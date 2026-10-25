import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useDesktop } from '../../../hooks/useDesktop'
import { usePlaceParam } from '../../../hooks/usePlaceParam'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { useUiMode } from '../../../context/UiModeContext'
import { dailyBudgetActionMessage, type DailyBudgetInfo } from '../../../lib/daily-budget'
import { openBudgetPanel } from '../../../lib/app-settings-events'
import { RunCapChoiceDialog } from '../../../components/RunCapChoiceDialog'
import type { RunCapChoice } from '../../../lib/run-cap'
import { OPEN_INBOX_EVENT } from '../../../lib/inbox-events'
import { INBOX_PARAM, PLACE_PUSH_STATE } from '../../../lib/places'
import { fetchInbox, resumeInboxRun, retryInboxJira, type InboxActionOutcome } from '../lib/inbox-api'
import {
  doneDismissal, groupByProject, inboxTarget, isDismissed, nextSnoozeExpiry, readDismissals, snoozeDismissal, writeDismissals,
  type Dismissals, type InboxGroup, type InboxItem, type SnoozeChoice,
} from '../lib/inbox-model'

/** WS events that can change what needs the person; any of them nudges a refetch. */
const NUDGE_TYPES = new Set(['rail.pr_state', 'rail.job_completed', 'rail.job_stopped', 'job.stuck', 'jira.outbox_changed'])
const NUDGE_DEBOUNCE_MS = 400
const POLL_MS = 60_000

function sameSnapshot(a: InboxItem[], b: InboxItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/** "3:15 PM" when the snooze ends today, "Mon 8:00 AM" otherwise. */
function formatSnoozeEnd(until: number | null, lang: string): string {
  if (until === null) return ''
  const end = new Date(until)
  const sameDay = end.toDateString() === new Date().toDateString()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' }
  try { return end.toLocaleString(lang || 'en', options) } catch { return end.toLocaleString('en', options) }
}

export interface InboxValue {
  isOpen: boolean
  openInbox: () => void
  closeInbox: () => void
  toggleInbox: () => void
  status: 'loading' | 'ready' | 'error'
  /** Everything not snoozed or done, newest first. */
  items: InboxItem[]
  groups: InboxGroup[]
  /** Badge number: the items that currently need the person. */
  count: number
  /** Item ids whose primary action is in flight. */
  busy: ReadonlySet<string>
  refresh: () => Promise<void>
  /** The primary inline action of the row. */
  runPrimary: (item: InboxItem, choice?: RunCapChoice) => Promise<void>
  snooze: (item: InboxItem, choice: SnoozeChoice) => void
  done: (item: InboxItem) => void
}

const InboxContext = createContext<InboxValue | null>(null)

/** The inbox (null outside the main window, where no inbox exists). */
export function useInbox(): InboxValue | null {
  return useContext(InboxContext)
}

export function InboxProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation('inbox')
  const { activeProjectId, setActiveProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const navigate = useNavigate()
  const location = useLocation()
  const place = usePlaceParam(INBOX_PARAM)
  const ws = useContext(SharedWebSocketContext)

  const [snapshotItems, setSnapshotItems] = useState<InboxItem[]>([])
  const [status, setStatus] = useState<InboxValue['status']>('loading')
  const [dismissals, setDismissals] = useState<Dismissals>(() => readDismissals())
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  const isOpen = place.value === '1'

  // ── Read-model fetch (never cached across projects: the server reads each project's own state)
  const revision = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    const mine = ++revision.current
    try {
      const snapshot = await fetchInbox()
      if (!alive.current || mine !== revision.current) return
      // The 60 s poll and every focus return fetch again: an identical snapshot
      // keeps its identity so the badge, the app shell and the dialog do not re-render.
      setSnapshotItems((previous) => (sameSnapshot(previous, snapshot.items) ? previous : snapshot.items))
      setStatus('ready')
    } catch {
      // Keep what we last knew; only say "error" when there is nothing to show.
      if (alive.current && mine === revision.current) setStatus((s) => (s === 'ready' ? s : 'error'))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (isOpen) void refresh() }, [isOpen, refresh])

  // Refresh on the events that change attention (any project: the inbox is app-wide), debounced.
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!registerHandler || !unregisterHandler) return
    registerHandler('inbox', (message) => {
      const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined
      if (typeof type !== 'string' || !(NUDGE_TYPES.has(type) || type.startsWith('loop.run_'))) return
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
      nudgeTimer.current = setTimeout(() => { nudgeTimer.current = null; void refresh() }, NUDGE_DEBOUNCE_MS)
    })
    return () => {
      unregisterHandler('inbox')
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
    }
  }, [registerHandler, unregisterHandler, refresh])

  // Gentle poll while visible + refresh on return to the window.
  useEffect(() => {
    const visibleRefresh = (): void => { if (document.visibilityState !== 'hidden') void refresh() }
    const timer = setInterval(visibleRefresh, POLL_MS)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
    }
  }, [refresh])

  // A snooze that lapses brings its item back without a refetch.
  useEffect(() => {
    const next = nextSnoozeExpiry(dismissals, now)
    if (next === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - now, 0) + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [dismissals, now])

  const items = useMemo(() => snapshotItems.filter((item) => !isDismissed(item, dismissals, now)), [snapshotItems, dismissals, now])
  const groups = useMemo(() => groupByProject(items), [items])

  // ── Opening / closing (a place: `?inbox=1`)
  const { open: openPlace, close: closePlace } = place
  const openInbox = useCallback(() => openPlace('1'), [openPlace])
  const closeInbox = useCallback(() => closePlace(), [closePlace])
  const toggleInbox = useCallback(() => { if (isOpen) closePlace(); else openPlace('1') }, [isOpen, openPlace, closePlace])
  useEffect(() => {
    window.addEventListener(OPEN_INBOX_EVENT, openInbox)
    return () => window.removeEventListener(OPEN_INBOX_EVENT, openInbox)
  }, [openInbox])

  // ── Navigating to an item (switching project first when it lives elsewhere)
  const locationRef = useRef(location)
  locationRef.current = location
  const uiModeRef = useRef(uiMode)
  uiModeRef.current = uiMode
  const pendingOpen = useRef<InboxItem | null>(null)
  const [runCapPrompt, setRunCapPrompt] = useState<{ item: InboxItem; budget: DailyBudgetInfo } | null>(null)
  const goToItem = useCallback((item: InboxItem, fromInbox: boolean) => {
    // "Raise cap" lands on the project's Analytics ▸ Budget panel (the shell navigates).
    if (item.action === 'raise-cap') { openBudgetPanel(); return }
    const target = inboxTarget(item, uiModeRef.current)
    const inboxEntryIsHere = fromInbox && new URLSearchParams(locationRef.current.search).get(INBOX_PARAM) === '1'
    // The inbox entry (when this very row was opened from it) is replaced by the place it leads to,
    // so Back returns to where the person was before opening the inbox.
    navigate({ pathname: target.pathname, search: target.search }, { replace: inboxEntryIsHere, state: { [PLACE_PUSH_STATE]: target.place } })
  }, [navigate])
  const openItem = useCallback((item: InboxItem) => {
    if (item.projectId !== activeProjectId) {
      pendingOpen.current = item
      // Leave the inbox before the switch: the item's own place replaces it, and the dialog must not outlive the hand-off.
      closePlace()
      setActiveProjectId(item.projectId)
      return
    }
    goToItem(item, true)
  }, [activeProjectId, setActiveProjectId, goToItem, closePlace])
  // The route memory (a parent effect of this one) restores the incoming project's last page in the same
  // commit and would overwrite an immediate navigation, so the hand-off waits one frame. It reads the
  // latest `goToItem`: the router's `navigate` changes identity with every location change.
  const goToItemRef = useRef(goToItem)
  goToItemRef.current = goToItem
  useEffect(() => {
    const pending = pendingOpen.current
    if (pending && pending.projectId === activeProjectId) {
      pendingOpen.current = null
      requestAnimationFrame(() => { if (alive.current) goToItemRef.current(pending, false) })
    }
  }, [activeProjectId])

  // ── Primary action: the same handlers/routes the existing buttons call
  const runPrimary = useCallback(async (item: InboxItem, choice?: RunCapChoice) => {
    if (item.action === 'open-review' || item.action === 'open-run' || item.action === 'raise-cap') { openItem(item); return }
    setBusy((current) => new Set(current).add(item.id))
    let outcome: InboxActionOutcome
    try {
      outcome = item.action === 'resume-run' ? await resumeInboxRun(item, choice) : await retryInboxJira(item)
    } finally {
      if (alive.current) setBusy((current) => { const next = new Set(current); next.delete(item.id); return next })
    }
    if (outcome.kind === 'ok') {
      toast.success(t(item.action === 'resume-run' ? 'toast.resumed' : 'toast.retried'))
    } else if (outcome.kind === 'over-budget' && outcome.budget.period === 'run') {
      // The run's per-run soft cap stands: the person answers Continue / Raise.
      if (alive.current) setRunCapPrompt({ item, budget: outcome.budget })
    } else if (outcome.kind === 'over-budget') {
      toast.error(t('toast.stillOverBudget'), { description: dailyBudgetActionMessage(t as never, outcome.budget) })
    } else {
      toast.error(t(item.action === 'resume-run' ? 'toast.resumeFailed' : 'toast.retryFailed'), { description: outcome.detail })
    }
    void refresh()
  }, [openItem, refresh, t])

  // ── Snooze / Done
  const persist = useCallback((updater: (current: Dismissals) => Dismissals) => {
    setDismissals((current) => {
      const next = updater(current)
      writeDismissals(next)
      return next
    })
    setNow(Date.now())
  }, [])
  // Both are quiet, so both say what happened and offer the way back (sonner directly: the app-wide undo
  // stack is per project and the inbox spans all of them).
  const undoDismissal = useCallback((id: string) => {
    persist((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }, [persist])
  const snooze = useCallback((item: InboxItem, choice: SnoozeChoice) => {
    const dismissal = snoozeDismissal(item, choice, Date.now())
    persist((current) => ({ ...current, [item.id]: dismissal }))
    toast(t('toast.snoozed', { when: formatSnoozeEnd(dismissal.until, i18n.language) }), {
      action: { label: t('toast.undo'), onClick: () => undoDismissal(item.id) },
    })
  }, [persist, undoDismissal, t, i18n.language])
  const done = useCallback((item: InboxItem) => {
    persist((current) => ({ ...current, [item.id]: doneDismissal(item, Date.now()) }))
    toast(t('toast.done'), { action: { label: t('toast.undo'), onClick: () => undoDismissal(item.id) } })
  }, [persist, undoDismissal, t])

  const value = useMemo<InboxValue>(() => ({
    isOpen, openInbox, closeInbox, toggleInbox, status, items, groups, count: items.length, busy, refresh, runPrimary, snooze, done,
  }), [isOpen, openInbox, closeInbox, toggleInbox, status, items, groups, busy, refresh, runPrimary, snooze, done])

  return (
    <InboxContext.Provider value={value}>
      {children}
      <RunCapChoiceDialog
        info={runCapPrompt?.budget ?? null}
        onDismiss={() => setRunCapPrompt(null)}
        onChoose={(choice) => {
          const prompt = runCapPrompt
          setRunCapPrompt(null)
          if (prompt) void runPrimary(prompt.item, choice)
        }}
      />
    </InboxContext.Provider>
  )
}
