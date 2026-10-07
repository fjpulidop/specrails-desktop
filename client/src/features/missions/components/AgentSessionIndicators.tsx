import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, Info, Loader2, RotateCcw, Settings2, X } from 'lucide-react'

import type { BackgroundTurnView, SessionNotice } from '../lib/mission-sessions'
import { retryAgentSessionHost } from '../lib/agent-api'
import { AgentMessage } from './AgentMessage'

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

