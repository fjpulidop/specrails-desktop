import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { getApiBase } from '../lib/api'

interface Stats {
  jobsToday: number
  costToday: number
  totalCostUsd: number
  /** Portion of cost that is a rate-card ESTIMATE (codex/gemini), not
   *  provider-billed. Optional — absent on legacy claude-only surfaces. */
  estimatedCostToday?: number
  estimatedCostUsd?: number
  /** True when any part of the surfaced cost is a rate-card estimate. */
  includesEstimated?: boolean
}

interface StatusBarProps {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  /** Optional slot rendered at the far right (e.g. the terminal panel chevron). */
  rightSlot?: React.ReactNode
}

export function StatusBar({ connectionStatus, rightSlot }: StatusBarProps) {
  const { t } = useTranslation('nav')
  const { t: tAnalytics } = useTranslation('analytics')
  const [stats, setStats] = useState<Stats | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const prevStatusRef = useRef<'connecting' | 'connected' | 'disconnected'>('connecting')
  const isFirstMount = useRef(true)

  // Detect reconnect: was previously connected/connecting-after-disconnect, now connected again
  useEffect(() => {
    const prev = prevStatusRef.current
    if (connectionStatus === 'connected' && !isFirstMount.current && prev !== 'connected') {
      toast.success(t('statusBar.connectionRestored'))
      setIsSyncing(true)
      const timer = setTimeout(() => setIsSyncing(false), 2000)
      return () => clearTimeout(timer)
    }
    if (isFirstMount.current && connectionStatus === 'connected') {
      isFirstMount.current = false
    }
    prevStatusRef.current = connectionStatus
  }, [connectionStatus])

  // Mark first mount resolved once we hit any status change
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
    }
  }, [])

  useEffect(() => {
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
  }, [connectionStatus])

  return (
    <footer className="h-7 flex items-center justify-between px-4 border-t border-border/30 bg-background/80 backdrop-blur-sm text-[10px] text-muted-foreground">
      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full transition-colors',
            connectionStatus === 'connected' && !isSyncing && 'bg-accent-success',
            connectionStatus === 'connected' && isSyncing && 'bg-accent-info animate-pulse',
            connectionStatus === 'connecting' && 'bg-accent-warning animate-[pulse_0.75s_ease-in-out_infinite]',
            connectionStatus === 'disconnected' && 'bg-destructive'
          )}
        />
        <span
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
      <div className="flex items-center gap-2">
        {stats && stats.totalCostUsd > 0 && (() => {
          // BUG-ANALYTICS-27: never present a codex/gemini rate-card estimate as
          // a billed figure — prefix '~' + tooltip when any part is estimated.
          const estimated =
            stats.includesEstimated ??
            ((stats.estimatedCostUsd ?? 0) > 0 || (stats.estimatedCostToday ?? 0) > 0)
          return (
            <span
              data-estimated={estimated ? 'true' : undefined}
              title={estimated ? tAnalytics('desktop.statusBarEstimatedTooltip') : undefined}
            >
              {estimated ? '~' : ''}${stats.totalCostUsd.toFixed(2)}
            </span>
          )
        })()}
        {rightSlot}
      </div>
    </footer>
  )
}
