import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, ChevronRight, Info, Loader2, RotateCcw, Settings2, Square, X } from 'lucide-react'

import { formatElapsed } from '../../../lib/format-duration'
import type { AgentSubagent, AgentSubagentEvent } from '../lib/agent-api'
import { PhaseGlyph, SubagentActivity, useElapsed } from './AgentSubagentsCard'
import { isLiveSubagent, type BackgroundTurnView, type SessionNotice } from '../lib/mission-sessions'
import { retryAgentSessionHost } from '../lib/agent-api'
import { AgentMessage } from './AgentMessage'

/** One live agent in the pill's popover: description and time; expands to its live activity. */
function LiveAgentRow({ conversationId, node, liveEvents, onStop }: { conversationId: string; node: AgentSubagent; liveEvents: AgentSubagentEvent[]; onStop: () => void }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(node)
  return (
    <li className="border-t border-border/20 first:border-t-0" data-testid="agent-live-agent-row">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? t('subagents.collapse') : t('subagents.expand', { name: node.description })}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
          <ChevronRight className={`h-3 w-3 shrink-0 text-foreground/40 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
          <PhaseGlyph node={node} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/85">{node.description}</span>
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-foreground/45">{elapsed}</span>
        </button>
        <button type="button" onClick={onStop} aria-label={t('subagents.stopOne', { name: node.description })} title={t('subagents.stop')}
          className="shrink-0 rounded p-1 text-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive">
          <Square className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {open && <div className="border-t border-border/20 bg-background/40"><SubagentActivity conversationId={conversationId} node={node} liveEvents={liveEvents} /></div>}
    </li>
  )
}

/**
 * Composer pill: background agents still working and for how long. It opens a
 * popover with each live agent (activity, Stop) and stops them all from its ✕.
 */
export function AgentBackgroundAgentsPill({ conversationId, subagents, liveEvents = {}, onStop }: {
  conversationId: string
  subagents: AgentSubagent[]
  liveEvents?: Record<string, AgentSubagentEvent[]>
  onStop: (subagentIds?: string[]) => Promise<void>
}) {
  const { t } = useTranslation('agent')
  const live = subagents.filter(isLiveSubagent)
  const [now, setNow] = useState(() => Date.now())
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useEffect(() => {
    if (live.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live.length])
  useEffect(() => { if (live.length === 0) setOpen(false) }, [live.length])
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const height = popup.current?.offsetHeight ?? 0
      if (!rect) return
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)), top: Math.max(8, rect.top - height - 8) })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [open, live.length])
  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [open])
  if (live.length === 0) return null
  const since = Math.min(...live.map((node) => Date.parse(node.startedAt)))
  const elapsed = formatElapsed(Math.max(0, now - since))
  const stop = async (ids?: string[]) => {
    setStopping(true); setFailed(false)
    try { await onStop(ids) } catch { setFailed(true) } finally { setStopping(false) }
  }
  return (
    <span data-testid="agent-background-agents-pill" className="inline-flex max-w-full items-center rounded-lg border border-accent-primary/40 bg-accent-primary/10 text-[11px] text-accent-primary">
      <button ref={trigger} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog"
        aria-label={t('subagents.pillAria', { count: live.length, elapsed })}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-l-lg px-2 py-1 transition-colors hover:bg-accent-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-primary" />
        </span>
        <Bot className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium">{t('subagents.pill', { count: live.length })}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{elapsed}</span>
      </button>
      {failed && <span role="alert" className="px-1 text-destructive">{t('subagents.stopFailed')}</span>}
      <button type="button" disabled={stopping} onClick={() => void stop()} aria-label={t('subagents.stopAll')} title={t('subagents.stopAll')}
        className="mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50">
        {stopping ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
      </button>
      {open && createPortal(
        <motion.div ref={popup} role="dialog" aria-label={t('subagents.popoverTitle')} data-testid="agent-background-agents-popover"
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14, ease: 'easeOut' }}
          style={{ position: 'fixed', left: position.left, top: position.top }}
          className="z-[100] w-[360px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border border-border/60 bg-card text-foreground shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
            <Bot className="h-3.5 w-3.5 text-accent-primary" aria-hidden />
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-foreground/60">{t('subagents.popoverTitle')}</span>
            <button type="button" disabled={stopping} onClick={() => void stop()} className="rounded-md px-1.5 py-0.5 text-[10.5px] text-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50">
              {t('subagents.stopAll')}
            </button>
          </div>
          <ul className="max-h-[50vh] overflow-y-auto">
            {live.map((node) => (
              <LiveAgentRow key={node.subagentId} conversationId={conversationId} node={node} liveEvents={liveEvents[node.subagentId] ?? []} onStop={() => void stop([node.subagentId])} />
            ))}
          </ul>
        </motion.div>,
        document.body,
      )}
    </span>
  )
}

/** A turn the agent runs on its own after sub-agents finished, streaming live. */
export function AgentBackgroundTurn({ turn }: { turn: BackgroundTurnView }) {
  const { t } = useTranslation('agent')
  return (
    <div className="space-y-1" data-testid="agent-background-turn">
      <AgentTurnOriginLabel origin={turn.origin} />
      {turn.text
        ? <AgentMessage role="assistant" content={turn.text} streaming />
        : <p className="title-shimmer px-1 text-[12px] text-foreground/55">{t('subagents.backgroundTurn')}</p>}
    </div>
  )
}

/** Quiet label above a message the agent produced after background work. */
export function AgentTurnOriginLabel({ origin }: { origin: 'subagent' | 'system' }) {
  const { t } = useTranslation('agent')
  return (
    <p className="flex items-center gap-1.5 px-1 text-[10.5px] uppercase tracking-wide text-foreground/40" data-testid="agent-turn-origin">
      <Bot className="h-3 w-3" aria-hidden />
      {origin === 'system' ? t('subagents.continuationSystem') : t('subagents.continuation')}
    </p>
  )
}

/** A settings change Core will apply once background agents finish. */
export function AgentDeferredChangeNotice({ onApplyNow }: { onApplyNow: () => Promise<void> }) {
  const { t } = useTranslation('agent')
  const [busy, setBusy] = useState(false)
  return (
    <div role="status" data-testid="agent-deferred-change" className="flex items-center gap-2 rounded-lg border border-accent-highlight/30 bg-accent-highlight/[0.07] px-3 py-1.5 text-[11.5px] text-foreground/70">
      <Settings2 className="h-3.5 w-3.5 shrink-0 text-accent-highlight" aria-hidden />
      <span className="min-w-0 flex-1">{t('subagents.deferred')}</span>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); void onApplyNow().finally(() => setBusy(false)) }}
        className="shrink-0 rounded-md border border-border/50 px-2 py-0.5 text-[11px] text-foreground/70 transition-colors hover:border-destructive/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-50">
        {t('subagents.applyNow')}
      </button>
    </div>
  )
}

const HOST_NOTICES = new Set(['host_degraded', 'journal_locked'])
const KNOWN_NOTICES = new Set([...HOST_NOTICES, 'policy.subagent_blocked'])

/** Session notices the user can act on: host trouble (with Retry) and policy enforcement. */
export function AgentSessionNotices({ notices, onDismiss }: { notices: SessionNotice[]; onDismiss: (noticeId: string) => void }) {
  const { t } = useTranslation('agent')
  const [retrying, setRetrying] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (notices.length === 0) return null
  const retry = async (notice: SessionNotice) => {
    if (!notice.scope) return
    setRetrying(notice.id); setRetryError(null)
    try {
      const { host } = await retryAgentSessionHost(notice.scope)
      if (host.status === 'ready') onDismiss(notice.id)
      else setRetryError(notice.id)
    } catch {
      setRetryError(notice.id)
    } finally {
      setRetrying(null)
    }
  }
  return (
    <div className="space-y-1.5" data-testid="agent-session-notices">
      {notices.map((notice) => {
        const known = KNOWN_NOTICES.has(notice.code)
        const host = HOST_NOTICES.has(notice.code)
        const warning = notice.level !== 'info'
        return (
          <div key={notice.id} role={warning ? 'alert' : 'status'} data-code={notice.code}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] ${warning ? 'border-accent-highlight/35 bg-accent-highlight/[0.07] text-foreground/75' : 'border-border/40 bg-surface/40 text-foreground/65'}`}>
            {warning ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-highlight" aria-hidden /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/45" aria-hidden />}
            <div className="min-w-0 flex-1 space-y-0.5">
              <p>{known ? t(`sessionNotice.${notice.code}`) : notice.message}</p>
              {retryError === notice.id && <p className="text-destructive">{t('sessionNotice.retryFailed')}</p>}
            </div>
            {host && notice.scope && (
              <button type="button" disabled={retrying === notice.id} onClick={() => void retry(notice)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 py-0.5 text-[11px] text-foreground/70 transition-colors hover:border-accent-primary/50 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50">
                {retrying === notice.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RotateCcw className="h-3 w-3" aria-hidden />}
                {t('sessionNotice.retry')}
              </button>
            )}
            <button type="button" onClick={() => onDismiss(notice.id)} aria-label={t('sessionNotice.dismiss')} title={t('sessionNotice.dismiss')}
              className="shrink-0 rounded p-0.5 text-foreground/40 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}

