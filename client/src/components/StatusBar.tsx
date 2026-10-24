import { KeepAwakeControl } from './KeepAwakeControl'
import { SubscriptionUsageFooter } from '../features/subscription-usage/components/SubscriptionUsageFooter'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { LiveDot } from './ui/live-dot'
import { getApiBase } from '../lib/api'
import { formatUsd } from '../lib/format-usd'

interface Stats {
  totalJobs?: number
  jobsToday: number
  costToday: number
  totalCostUsd: number
  /** Portion of cost that is a rate-card ESTIMATE (codex/gemini), not
   *  provider-billed. Optional — absent on legacy claude-only surfaces. */
  estimatedCostToday?: number
  estimatedCostUsd?: number
  /** True when any part of the surfaced cost is a rate-card estimate. */
  includesEstimated?: boolean
  pricedRuns?: number
  unpricedRuns?: number
}

interface StatusBarProps {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  /** Optional slot rendered at the far right (e.g. the terminal panel chevron). */
  rightSlot?: React.ReactNode
  /** Agent Mode: quiet footer. No spend figure, and the connection cluster only
   *  renders when there is something worth saying (reconnecting / disconnected /
   *  post-reconnect sync) — silence means healthy. */
  minimal?: boolean
}

export function StatusBar({ connectionStatus, rightSlot, minimal = false }: StatusBarProps) {
  const { t } = useTranslation('nav')
  const { t: tAnalytics } = useTranslation('analytics')
  const [stats, setStats] = useState<Stats | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  // Reconnect feedback. A plain reload goes connecting -> connected without ever
  // having been connected, and a blip shorter than 3 s is not worth a toast:
  // those only flash the lamp. A real outage (>= 3 s offline) gets the toast.
  const everConnected = useRef(false)
  const offlineSince = useRef<number | null>(null)

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      if (everConnected.current && offlineSince.current === null) offlineSince.current = Date.now()
      return
    }
    const wasOffline = offlineSince.current
    offlineSince.current = null
    everConnected.current = true
    if (wasOffline === null) return
    if (Date.now() - wasOffline >= 3000) toast.success(t('statusBar.connectionRestored'))
    setIsSyncing(true)
    const timer = setTimeout(() => setIsSyncing(false), 2000)
    return () => clearTimeout(timer)
  }, [connectionStatus, t])

  useEffect(() => {
    if (minimal) return // spend figure never shown — skip the polling entirely
    async function fetchStats() {
      try {
        const res = await fetch(`${getApiBase()}/stats`)
        if (res.ok) {
          const data = await res.json() as Stats
          setStats(data)
        }
      } catch {
        // ignore
      }
    }

    fetchStats()
    // Refresh stats every 30 seconds
    const interval = setInterval(fetchStats, 30_000)
    return () => clearInterval(interval)
  }, [connectionStatus, minimal])

  // Minimal (Agent Mode): only speak when something is off — a steady
  // "connected" is presence noise; its absence reads as healthy.
  const showConnection = !minimal || connectionStatus !== 'connected' || isSyncing

  return (
    <footer className="h-7 shrink-0 flex items-center justify-between px-4 border-t border-border/30 bg-background text-caption num text-muted-foreground">
      {/* Connection status */}
      <div className={cn('flex items-center gap-1.5 transition-opacity duration-200', !showConnection && 'opacity-0')} aria-hidden={!showConnection || undefined}>
        <LiveDot
          size="xs"
          aria-hidden="true"
          pulsing={connectionStatus === 'connecting' || (connectionStatus === 'connected' && isSyncing)}
          tone={connectionStatus === 'disconnected' ? 'destructive' : connectionStatus === 'connecting' ? 'warning' : isSyncing ? 'info' : 'success'}
        />
        <span
          role="status"
          aria-live="polite"
          className={cn(
            'transition-colors',
            connectionStatus === 'connected' && !isSyncing && 'text-accent-success',
            connectionStatus === 'connected' && isSyncing && 'text-accent-info',
            connectionStatus === 'connecting' && 'text-accent-warning',
            connectionStatus === 'disconnected' && 'text-destructive'
          )}
        >
          {connectionStatus === 'connected' && !isSyncing && t('statusBar.connected')}
          {connectionStatus === 'connected' && isSyncing && t('statusBar.syncing')}
          {connectionStatus === 'connecting' && t('statusBar.reconnecting')}
          {connectionStatus === 'disconnected' && t('statusBar.disconnected')}
        </span>
      </div>

      {/* Stats + right slot (terminal chevron) */}
      <div className="flex items-center gap-2 [&>*+*]:border-l [&>*+*]:border-border/40 [&>*+*]:pl-2">
        {!minimal && stats && (stats.totalCostUsd > 0 || (stats.unpricedRuns ?? 0) > 0) && (() => {
          // BUG-ANALYTICS-27: never present a codex/gemini rate-card estimate as
          // a billed figure — prefix '~' + tooltip when any part is estimated.
          const estimated =
            stats.includesEstimated ??
            ((stats.estimatedCostUsd ?? 0) > 0 || (stats.estimatedCostToday ?? 0) > 0)
          const unpricedRuns = stats.unpricedRuns ?? 0
          const pricedRuns = stats.pricedRuns
            ?? Math.max(0, (stats.totalJobs ?? 0) - unpricedRuns)
          const unavailable = stats.totalCostUsd === 0 && unpricedRuns > 0 && pricedRuns === 0
          const partial = unpricedRuns > 0 && (pricedRuns > 0 || stats.totalCostUsd > 0)
          return (
            <span
              data-estimated={estimated ? 'true' : undefined}
              className="num"
              data-testid={unavailable ? 'statusbar-cost-unavailable' : undefined}
              title={
                unavailable
                  ? tAnalytics('desktop.costUnavailable')
                  : partial
                    ? tAnalytics('desktop.costPartiallyUnavailable', { count: unpricedRuns })
                    : estimated
                      ? tAnalytics('desktop.statusBarEstimatedTooltip')
                      : undefined
              }
            >
              {unavailable
                ? tAnalytics('desktop.costUnavailableShort')
                : `${estimated ? '~' : ''}${partial ? '≥' : ''}${formatUsd(stats.totalCostUsd)}`}
            </span>
          )
        })()}
        <KeepAwakeControl />
        <SubscriptionUsageFooter />
        {rightSlot}
      </div>
    </footer>
  )
}
