import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { HoverPopover } from '../../../components/ui/hover-popover'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { renewAgentSessionWithSummary, SessionRenewError, type AgentContextUsage } from '../lib/agent-api'

/** At or above this share of the window the ring warns. */
export const CONTEXT_WARNING_PERCENT = 75
/** At or above this share of the window the ring turns destructive. */
export const CONTEXT_DANGER_PERCENT = 90

/** 18612 → "18.6k", 200000 → "200k", 1000000 → "1M". */
export function formatCompactTokens(value: number): string {
  const trim = (n: number) => (Math.round(n * 10) / 10).toString()
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (value >= 1_000) return `${trim(value / 1_000)}k`
  return String(Math.round(value))
}

export type ContextUsageLevel = 'normal' | 'warning' | 'danger'

export function contextUsageLevel(percent: number): ContextUsageLevel {
  if (percent >= CONTEXT_DANGER_PERCENT) return 'danger'
  if (percent >= CONTEXT_WARNING_PERCENT) return 'warning'
  return 'normal'
}

const LEVEL_TEXT: Record<ContextUsageLevel, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-accent-warning',
  danger: 'text-destructive',
}
const LEVEL_BAR: Record<ContextUsageLevel, string> = {
  normal: 'bg-accent-primary',
  warning: 'bg-accent-warning',
  danger: 'bg-destructive',
}

/** Product names of the CLIs whose session files are read. */
const SESSION_FILE_PROVIDER: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

const SIZE = 16
const STROKE = 2
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * "Context used" ring for the mission composer: how full the provider
 * session's context window is, as reported by the provider (never estimated).
 * Hidden when there is no snapshot. Without a window or a known usage (right
 * after a compaction) it is hidden too, unless it offers "Start fresh with a
 * summary" for a mission: then it shows an empty, neutral ring whose popover
 * says what is unknown, so the action stays available once a snapshot exists.
 */
export function AgentContextUsageRing({ usage, conversationId, busy = false, modeBlocked = false }: {
  usage: AgentContextUsage | null | undefined
  /** The mission whose session "Start fresh with a summary" renews (omitted: no action). */
  conversationId?: string | null
  /** A turn is running: renewal waits for it. */
  busy?: boolean
  /** An extension mode (Intent) owns the session: renewal is not offered. */
  modeBlocked?: boolean
}) {
  const { t } = useTranslation('agent')
  // Held by the ring, not the popover panel: closing the panel mid-renewal keeps its state.
  const [renew, setRenew] = useState<{ conversationId: string | null; state: RenewState }>({ conversationId: null, state: { step: 'idle' } })
  if (!usage) return null
  if (usage.windowTokens === null || usage.usedTokens === null || usage.percent === null) {
    if (!conversationId) return null
    return (
      <HoverPopover
        label={t('contextUsage.title')}
        description={t('contextUsage.description')}
        testId="agent-context-usage-popover"
        width={288}
        trigger={
          <button
            type="button"
            aria-label={t('contextUsage.openUnknown')}
            data-testid="agent-context-usage"
            data-level="unknown"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
              <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} stroke="currentColor" className="text-muted" />
            </svg>
          </button>
        }
      >
        <div className="space-y-2" data-testid="agent-context-usage-panel">
          <h3 className="text-label font-medium text-foreground">{t('contextUsage.title')}</h3>
          {usage.usedTokens !== null && (
            <div className="text-body tabular-nums text-foreground" data-testid="agent-context-usage-tokens">
              {t('contextUsage.tokensUsedOnly', { used: formatCompactTokens(usage.usedTokens) })}
            </div>
          )}
          <p className="text-caption text-muted-foreground" data-testid="agent-context-usage-unknown">
            {usage.usedTokens === null ? t('contextUsage.usageUnknown') : t('contextUsage.windowUnknown')}
          </p>
          <SessionRenewAction
            conversationId={conversationId}
            highlighted={false}
            busy={busy}
            modeBlocked={modeBlocked}
            state={renew.conversationId === conversationId ? renew.state : { step: 'idle' }}
            onState={(state) => setRenew({ conversationId, state })}
          />
        </div>
      </HoverPopover>
    )
  }
  const percent = usage.percent
  const drawn = Math.min(100, Math.max(0, percent))
  const level = contextUsageLevel(percent)
  const used = formatCompactTokens(usage.usedTokens)
  const window = formatCompactTokens(usage.windowTokens)
  return (
    <HoverPopover
      label={t('contextUsage.title')}
      description={t('contextUsage.description')}
      testId="agent-context-usage-popover"
      width={288}
      trigger={
        <button
          type="button"
          aria-label={t('contextUsage.open', { percent })}
          data-testid="agent-context-usage"
          data-level={level}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
            LEVEL_TEXT[level],
          )}
        >
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className="-rotate-90">
            <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} stroke="currentColor" className="text-muted" />
            <circle
              data-testid="agent-context-usage-arc"
              cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} stroke="currentColor" strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - drawn / 100)}
            />
          </svg>
        </button>
      }
    >
      <div className="space-y-2" data-testid="agent-context-usage-panel">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-label font-medium text-foreground">{t('contextUsage.title')}</h3>
          <span className={cn('text-label font-medium tabular-nums', LEVEL_TEXT[level])}>{t('contextUsage.percent', { percent })}</span>
        </div>
        <div className="text-body tabular-nums text-foreground" data-testid="agent-context-usage-tokens">
          {t('contextUsage.tokens', { used, window })}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={drawn} aria-label={t('contextUsage.title')}>
          <div className={cn('h-full rounded-full', LEVEL_BAR[level])} style={{ width: `${drawn}%` }} />
        </div>
        {usage.model && (
          <div className="flex justify-between gap-2 text-caption text-muted-foreground">
            <span>{t('contextUsage.model')}</span>
            <span className="truncate font-mono text-foreground">{usage.model}</span>
          </div>
        )}
        <p className="text-caption text-muted-foreground">
          {usage.source === 'session-file' ? t('contextUsage.sourceSessionFile', { provider: SESSION_FILE_PROVIDER[usage.provider] ?? usage.provider }) : t('contextUsage.sourceResponse')}
        </p>
        {usage.compacted && <p className="text-caption text-muted-foreground">{t('contextUsage.compacted')}</p>}
        {level !== 'normal' && (
          <p className={cn('text-caption', LEVEL_TEXT[level])} data-testid="agent-context-usage-note">{t('contextUsage.highNote')}</p>
        )}
        {conversationId && (
          <SessionRenewAction
            conversationId={conversationId}
            highlighted={level !== 'normal'}
            busy={busy}
            modeBlocked={modeBlocked}
            state={renew.conversationId === conversationId ? renew.state : { step: 'idle' }}
            onState={(state) => setRenew({ conversationId, state })}
          />
        )}
      </div>
    </HoverPopover>
  )
}

type RenewState = { step: 'idle' } | { step: 'confirm' } | { step: 'running' } | { step: 'error'; message: string }

/** Server refusals explained in the person's language; other errors (the provider's own) are shown as sent. */
const RENEW_ERROR_CODES = new Set(['MISSION_BUSY', 'MISSION_IN_INTENT', 'MISSION_ARCHIVED', 'NOTHING_TO_SUMMARIZE', 'RENEWAL_CANCELLED', 'SHUTTING_DOWN'])

/**
 * "Start fresh with a summary": a confirm step, then the server writes the
 * summary and the next message opens a new provider session that knows only
 * that summary. The marker card arrives in the transcript over WebSocket and the
 * ring hides until the new session reports its context.
 */
function SessionRenewAction({ conversationId, highlighted, busy, modeBlocked, state, onState: setState }: {
  conversationId: string; highlighted: boolean; busy: boolean; modeBlocked: boolean
  state: RenewState; onState: (state: RenewState) => void
}) {
  const { t } = useTranslation('agent')
  const run = async () => {
    setState({ step: 'running' })
    try {
      await renewAgentSessionWithSummary(conversationId)
      setState({ step: 'idle' })
    } catch (error) {
      const code = error instanceof SessionRenewError ? error.code : null
      const message = code && RENEW_ERROR_CODES.has(code)
        ? t(`sessionRenew.errors.${code}`)
        : error instanceof Error && error.message ? error.message : t('sessionRenew.errors.generic')
      setState({ step: 'error', message })
    }
  }
  const blocked = modeBlocked ? t('sessionRenew.blockedMode') : busy ? t('sessionRenew.blockedBusy') : null
  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid="agent-session-renew">
      {state.step === 'confirm' ? (
        <div className="space-y-2" data-testid="agent-session-renew-confirm">
          <p className="text-caption text-foreground">{t('sessionRenew.confirmBody')}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setState({ step: 'idle' })}>{t('sessionRenew.cancel')}</Button>
            <Button type="button" size="sm" disabled={!!blocked} onClick={() => void run()} data-testid="agent-session-renew-confirm-button">{t('sessionRenew.confirm')}</Button>
          </div>
        </div>
      ) : state.step === 'running' ? (
        <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status" data-testid="agent-session-renew-running">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          {t('sessionRenew.running')}
        </p>
      ) : (
        <>
          {state.step === 'error' && (
            <p className="text-caption text-destructive" role="alert" data-testid="agent-session-renew-error">{state.message}</p>
          )}
          <Button
            type="button"
            size="sm"
            variant={highlighted ? 'default' : 'outline'}
            className="w-full gap-1.5"
            disabled={!!blocked}
            onClick={() => setState({ step: 'confirm' })}
            data-testid="agent-session-renew-button"
            data-highlighted={highlighted ? 'true' : 'false'}
          >
            {state.step === 'error' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
            {state.step === 'error' ? t('sessionRenew.retry') : t('sessionRenew.action')}
          </Button>
          {blocked
            ? <p className="text-caption text-muted-foreground" data-testid="agent-session-renew-blocked">{blocked}</p>
            : <p className="text-caption text-muted-foreground">{t('sessionRenew.hint')}</p>}
        </>
      )}
    </div>
  )
}
