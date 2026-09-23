import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'
import type { RuntimeProviderStatus } from '../../lib/agent-runtime'

export type ConnectionPillState = 'probing' | 'reachable' | 'unauthorized' | 'unreachable' | 'untested'

/** Fold a detection/test status into the five pill states. Undefined = never probed. */
export function pillStateFor(status: RuntimeProviderStatus | undefined, probing = false): ConnectionPillState {
  if (probing) return 'probing'
  if (!status) return 'untested'
  const reachable = status.reachable ?? status.installed
  if (reachable === undefined) return 'untested'
  if (!reachable) return 'unreachable'
  if (status.authState === 'unauthenticated') return 'unauthorized'
  return 'reachable'
}

const STYLES: Record<ConnectionPillState, { dot: string; pill: string }> = {
  probing: { dot: 'bg-accent-info animate-pulse', pill: 'border-accent-info/30 bg-accent-info/10 text-accent-info' },
  reachable: { dot: 'bg-accent-success', pill: 'border-accent-success/30 bg-accent-success/10 text-accent-success' },
  unauthorized: { dot: 'bg-accent-warning', pill: 'border-accent-warning/30 bg-accent-warning/10 text-accent-warning' },
  unreachable: { dot: 'bg-destructive', pill: 'border-destructive/30 bg-destructive/10 text-destructive' },
  untested: { dot: 'bg-muted-foreground/50', pill: 'border-border bg-muted/40 text-muted-foreground' },
}

interface Props {
  state: ConnectionPillState
  /** Round-trip of the last probe, rendered as a subtle suffix when known. */
  latencyMs?: number
  className?: string
}

/** Premium status pill: probing (pulse) / reachable / not authorized / unreachable / never tested. */
export function ConnectionStatusPill({ state, latencyMs, className }: Props) {
  const { t } = useTranslation('agentRuntime')
  const style = STYLES[state]
  return (
    <span
      data-testid="connection-status-pill"
      data-state={state}
      role="status"
      className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors', style.pill, className)}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {t(`providers.status.${state}`)}
      {state === 'reachable' && typeof latencyMs === 'number' && (
        <span className="text-[10px] font-normal opacity-70 tabular-nums">· {latencyMs} ms</span>
      )}
    </span>
  )
}
