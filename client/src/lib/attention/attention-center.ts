/**
 * The attention pipeline: every "this needs you" signal (inbox items, mission
 * replies, finished / failed / stuck jobs, provider limits) goes through
 * {@link AttentionCenter.dispatch}, which reads the prefs, asks where the focus
 * is, applies the pure policy and then shows an OS notification, an in-app
 * toast or nothing.
 *
 * Notifications sent while the person was away are remembered: when the main
 * window regains focus the return toast ("3 pending items", or one item by name) offers a way
 * back, since a native notification in the desktop app cannot be clicked
 * through.
 */
import { decideAttention, type AttentionCategory, type AttentionDecision, type AttentionPrefs } from './attention-policy'
import type { AttentionCopy } from './attention-copy'
import type { NativeNotification } from './native-notify'
import type { WindowFocus } from './window-focus'

export interface AttentionEvent {
  /** Unique per occurrence: the same key is never announced twice in this session. */
  key: string
  /** Same subject from different sources (a stuck run, then its inbox item): announced once per {@link SUBJECT_WINDOW_MS}. */
  subjectKey?: string
  category: AttentionCategory
  projectId: string | null
  title: string
  body: string
  /** Fire an OS notification even with the window focused (a stalled run). */
  persistent?: boolean
  /** Is the item's own place visible to the person, given where the focus is? Default: no. */
  isOnScreen?: (focus: WindowFocus) => boolean
  /** Where a click (browser) or the return toast leads. */
  open?: () => void
  /** Replaces the default in-app toast when the decision is `toast`. */
  inAppToast?: () => void
  /** What the item is, for the return toast and the toast's action ("… is waiting for your answer" → "Answer"). */
  copy?: AttentionCopy
}

export interface AwayEntry {
  key: string
  open?: () => void
  /** The event's wording (see {@link AttentionEvent.copy}); `title` is its fallback. */
  copy?: AttentionCopy
  title?: string
  /** The event's own on-screen check: on return, an item already in front of the person is not announced again. */
  isOnScreen?: (focus: WindowFocus) => boolean
}

export interface AttentionCenterDeps {
  prefs(): Promise<AttentionPrefs>
  focus(): Promise<WindowFocus>
  notify(notification: NativeNotification): Promise<boolean>
  toast(event: AttentionEvent): void
  /**
   * Shows an in-app toast now or later (the startup queue holds them while a
   * launch modal is open). Default: now.
   */
  deliver?: (show: () => void) => void
  now?: () => number
  /**
   * Coalescing of OS notifications: those sent within `burstMs` of the first
   * one are held, and more than `burstLimit` of them become one summary
   * (`summary(count, lines, copies)`, one line per held notification: its body,
   * which names the project and the item; `copies` their wording), so a batch of new items never floods the
   * notification centre. Defaults: 600 ms, 2. Without `summary` every
   * notification is sent at once.
   */
  burstMs?: number
  burstLimit?: number
  summary?: (count: number, lines: string[], copies: Array<AttentionCopy | undefined>) => NativeNotification
}

export const SUBJECT_WINDOW_MS = 10 * 60_000
const MAX_REMEMBERED = 500

export interface AttentionCenter {
  dispatch(event: AttentionEvent): Promise<AttentionDecision>
  /** The notifications sent while away, oldest first; the list is emptied. */
  takeAway(): AwayEntry[]
  /** Drop one away entry (its browser notification was clicked). */
  forget(key: string): void
}

export function createAttentionCenter(deps: AttentionCenterDeps): AttentionCenter {
  const now = deps.now ?? Date.now
  const deliver = deps.deliver ?? ((show: () => void) => show())
  const showToast = (event: AttentionEvent): void => deliver(() => {
    if (event.inAppToast) event.inAppToast()
    else deps.toast(event)
  })
  const keys = new Map<string, number>()
  const subjects = new Map<string, number>()
  let away: AwayEntry[] = []
  const burstMs = deps.burstMs ?? 600
  const burstLimit = deps.burstLimit ?? 2
  let burst: Array<{ notification: NativeNotification; copy?: AttentionCopy; resolve: (shown: boolean) => void }> = []
  let burstTimer: ReturnType<typeof setTimeout> | null = null

  const flushBurst = async (): Promise<void> => {
    const batch = burst
    burst = []
    burstTimer = null
    if (batch.length <= burstLimit || !deps.summary) {
      for (const entry of batch) entry.resolve(await deps.notify(entry.notification).catch(() => false))
      return
    }
    const summary = deps.summary(batch.length, batch.map((entry) => entry.notification.body || entry.notification.title), batch.map((entry) => entry.copy))
    const shown = await deps.notify({ ...summary, sound: batch.some((entry) => entry.notification.sound) }).catch(() => false)
    for (const entry of batch) entry.resolve(shown)
  }

  const notifyCoalesced = (notification: NativeNotification, copy?: AttentionCopy): Promise<boolean> => !deps.summary ? deps.notify(notification) : new Promise((resolve) => {
    burst.push({ notification, copy, resolve })
    if (!burstTimer) burstTimer = setTimeout(() => { void flushBurst() }, burstMs)
  })

  const prune = (at: number): void => {
    for (const [subject, sentAt] of subjects) if (at - sentAt > SUBJECT_WINDOW_MS) subjects.delete(subject)
    // Keys only grow with what was announced; keep the most recent ones.
    while (keys.size > MAX_REMEMBERED) keys.delete(keys.keys().next().value as string)
  }

  const center: AttentionCenter = {
    async dispatch(event) {
      if (keys.has(event.key)) return 'skip'
      const at = now()
      prune(at)
      if (event.subjectKey && subjects.has(event.subjectKey)) return 'skip'
      // Claim before awaiting: two copies of one event arriving together announce once.
      keys.set(event.key, at)
      if (event.subjectKey) subjects.set(event.subjectKey, at)
      const [prefs, focus] = await Promise.all([deps.prefs(), deps.focus()])
      const decision = decideAttention({
        category: event.category,
        projectId: event.projectId,
        windowFocused: focus.appFocused,
        placeOnScreen: focus.appFocused && (event.isOnScreen?.(focus) ?? false),
        persistent: event.persistent,
      }, prefs)
      if (decision === 'skip') {
        if (event.subjectKey) subjects.delete(event.subjectKey)
        return decision
      }
      if (decision === 'toast') {
        showToast(event)
        return decision
      }
      const open = event.open
      const shown = await notifyCoalesced({
        title: event.title,
        body: event.body,
        tag: event.key,
        sound: prefs.sound,
        onClick: open ? () => { center.forget(event.key); open() } : undefined,
      }, event.copy)
      // Away: remembered for the return toast even when the system refused the
      // notification (permission denied), so the person still hears about it.
      if (!focus.appFocused) away = [...away.filter((entry) => entry.key !== event.key), { key: event.key, open, isOnScreen: event.isOnScreen, copy: event.copy, title: event.title }]
      else if (!shown) showToast(event)
      return decision
    },
    takeAway() {
      const entries = away
      away = []
      return entries
    },
    forget(key) {
      away = away.filter((entry) => entry.key !== key)
    },
  }
  return center
}
