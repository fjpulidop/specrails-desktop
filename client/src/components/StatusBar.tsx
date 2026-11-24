import { KeepAwakeIndicator, KeepAwakeSwitch, useKeepAwake } from './KeepAwakeControl'
import { SubscriptionUsageFooter } from '../features/subscription-usage/components/SubscriptionUsageFooter'
import { AppResourcesFooter } from '../features/background/components/AppResourcesFooter'
import { DesktopUpdateChip } from './DesktopUpdateChip'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { LiveDot } from './ui/live-dot'
import { getApiBase } from '../lib/api'
import { formatUsd } from '../lib/format-usd'

interface Stats {
  costToday: number
  /** Portion of today's cost that is a rate-card ESTIMATE (codex/gemini), not provider-billed. */
  estimatedCostToday?: number
  totalJobs?: number
  pricedRuns?: number
  /** Runs whose provider reports no price (e.g. Kimi): the figure is then a lower bound. */
  unpricedRuns?: number
}

/**
 * Today's spend for the active project, inside the usage popover (never in the
 * bar itself). Read when the popover opens; nothing renders without a figure.
 */
export function TodaySpend() {
  const { t } = useTranslation('subscriptionUsage')
  const { t: tAnalytics } = useTranslation('analytics')
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let base: string
    try { base = getApiBase() } catch { return } // no active project
    fetch(`${base}/stats`, { signal: controller.signal })
      .then(res => res.ok ? res.json() as Promise<Stats> : null)
      .then(data => { if (data) setStats(data) })
      .catch(() => { /* nothing to show */ })
    return () => controller.abort()
  }, [])
  if (!stats) return null
  const unpriced = stats.unpricedRuns ?? 0
  const priced = stats.pricedRuns ?? Math.max(0, (stats.totalJobs ?? 0) - unpriced)
  const unavailable = !(stats.costToday > 0) && unpriced > 0 && priced === 0
  if (!(stats.costToday > 0) && !unavailable) return null
  // BUG-ANALYTICS-27: never present a rate-card estimate as a billed figure;
  // unpriced runs make the figure a known lower bound.
  const estimated = (stats.estimatedCostToday ?? 0) > 0
  const partial = !unavailable && unpriced > 0
  const title = unavailable ? tAnalytics('desktop.costUnavailable')
    : partial ? tAnalytics('desktop.costPartiallyUnavailable', { count: unpriced })
      : estimated ? t('today.estimated') : undefined
  return <div data-testid="usage-today-spend" className="mx-3 flex items-center justify-between gap-2 border-t border-border/40 py-2 text-caption">
    <span className="text-muted-foreground">{t('today.title')}</span>
    <span className="num text-foreground" data-estimated={estimated ? 'true' : undefined} title={title}>
      {unavailable ? tAnalytics('desktop.costUnavailableShort') : `${estimated ? '~' : ''}${partial ? '≥' : ''}${formatUsd(stats.costToday)}`}
    </span>
  </div>
}

/** How long a first connection may take before the bar says it is still connecting. */
export const SLOW_START_MS = 3000

interface StatusBarProps {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  /** Optional slot rendered at the far right (the terminal panel toggle). */
  rightSlot?: React.ReactNode
}

/**
 * One status bar for both modes (DESIGN.md › Status bar). Left: nothing while
 * healthy, only a connection problem. Right: an update offer, the busiest plan-usage meter,
 * persistent app resources, keep-awake while it is on, and the terminal toggle.
 * A missing figure renders nothing, never a placeholder dash.
 */
export function StatusBar({ connectionStatus, rightSlot }: StatusBarProps) {
  const { t } = useTranslation('nav')
  const keepAwake = useKeepAwake()
  const [isSyncing, setIsSyncing] = useState(false)
  // Reconnect feedback. A plain reload goes connecting -> connected without ever
  // having been connected, and a blip shorter than 3 s is not worth a toast.
  // A real outage (>= 3 s offline) gets the toast.
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

  // The first connect after a launch is not a problem worth naming, unless it takes long.
  const [slowStart, setSlowStart] = useState(false)
  useEffect(() => {
    if (connectionStatus === 'connected' || everConnected.current) { setSlowStart(false); return }
    const timer = setTimeout(() => setSlowStart(true), SLOW_START_MS)
    return () => clearTimeout(timer)
  }, [connectionStatus])
  const problem = connectionStatus === 'disconnected' || (connectionStatus === 'connecting' && (everConnected.current || slowStart))
  const showConnection = problem || isSyncing

  return (
    <footer className="h-7 shrink-0 flex items-center justify-between px-4 border-t border-border/30 bg-background text-caption num text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        {/* The live region stays mounted so the change is announced. */}
        <span role="status" aria-live="polite" className={cn('flex items-center gap-1.5', !showConnection && 'sr-only')}>
          {showConnection && <>
            {/* Connection health, not a run state: amber reconnecting, red offline, info while catching up. */}
            <LiveDot
              size="xs"
              aria-hidden="true"
              pulsing={connectionStatus !== 'disconnected'}
              tone={connectionStatus === 'disconnected' ? 'destructive' : connectionStatus === 'connecting' ? 'warning' : 'info'}
            />
            <span className={cn(
              connectionStatus === 'connected' && 'text-accent-info',
              connectionStatus === 'connecting' && 'text-accent-warning',
              connectionStatus === 'disconnected' && 'text-destructive',
            )}>
              {connectionStatus === 'connected' ? t('statusBar.syncing') : connectionStatus === 'connecting' ? t('statusBar.reconnecting') : t('statusBar.disconnected')}
            </span>
          </>}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <DesktopUpdateChip />
        <SubscriptionUsageFooter details={<TodaySpend />} />
        <AppResourcesFooter extra={<KeepAwakeSwitch keepAwake={keepAwake} />} />
        <KeepAwakeIndicator keepAwake={keepAwake} />
        {rightSlot}
      </div>
    </footer>
  )
}
