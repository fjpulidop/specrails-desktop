import { useTranslation } from 'react-i18next'
import { HoverPopover } from '../../../components/ui/hover-popover'
import { cn } from '../../../lib/utils'
import type { AgentContextUsage } from '../lib/agent-api'

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
 * Hidden when there is no snapshot, the window is unknown, or the usage is
 * unknown (right after a compaction).
 */
export function AgentContextUsageRing({ usage }: { usage: AgentContextUsage | null | undefined }) {
  const { t } = useTranslation('agent')
  if (!usage || usage.windowTokens === null || usage.usedTokens === null || usage.percent === null) return null
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
      </div>
    </HoverPopover>
  )
}
