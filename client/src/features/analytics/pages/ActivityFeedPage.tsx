import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CheckCircle2, XCircle, Ban, Loader2, Activity, Zap } from 'lucide-react'
import { useDesktop } from '../../../hooks/useDesktop'
import { useActivity } from '../hooks/useActivity'
import type { ActivityItem } from '../hooks/useActivity'

function formatRelativeTime(isoTimestamp: string, t: TFunction): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return t('feed.relativeTime.seconds', { value: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('feed.relativeTime.minutes', { value: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('feed.relativeTime.hours', { value: hours })
  const days = Math.floor(hours / 24)
  return t('feed.relativeTime.days', { value: days })
}

function ActivityIcon({ type }: { type: ActivityItem['type'] }) {
  switch (type) {
    case 'job_completed':
      return <CheckCircle2 className="w-4 h-4 text-green-500 aurora-light:text-accent-success flex-shrink-0" />
    case 'job_failed':
      return <XCircle className="w-4 h-4 text-red-500 aurora-light:text-destructive flex-shrink-0" />
    case 'job_canceled':
      return <Ban className="w-4 h-4 text-muted-foreground flex-shrink-0" />
    default:
      return <Zap className="w-4 h-4 text-blue-500 aurora-light:text-accent-info flex-shrink-0" />
  }
}

function typeLabel(type: ActivityItem['type'], t: TFunction): string {
  switch (type) {
    case 'job_completed': return t('common:status.completed')
    case 'job_failed': return t('common:status.failed')
    case 'job_canceled': return t('common:status.canceled')
    default: return t('feed.typeStarted')
  }
}

function typeLabelClass(type: ActivityItem['type']): string {
  switch (type) {
    case 'job_completed': return 'text-green-500 aurora-light:text-accent-success'
    case 'job_failed': return 'text-red-500 aurora-light:text-destructive'
    case 'job_canceled': return 'text-muted-foreground'
    default: return 'text-blue-500 aurora-light:text-accent-info'
  }
}

export default function ActivityFeedPage() {
  const { t } = useTranslation('activity')
  const { activeProjectId } = useDesktop()
  const { items, loading, hasMore, loadMore } = useActivity({ activeProjectId })
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loading, loadMore])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background/50">
        <Activity className="w-4 h-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">{t('feed.title')}</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
            <Activity className="w-8 h-8 opacity-40" />
            <p className="text-sm">{t('feed.emptyTitle')}</p>
            <p className="text-xs opacity-70">{t('feed.emptyHint')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {items.map((item) => (
              <li key={`${item.type}:${item.jobId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/30 transition-colors">
                <ActivityIcon type={item.type} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate" title={item.jobCommand}>
                    {item.jobCommand}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-xs font-medium ${typeLabelClass(item.type)}`}>
                      {typeLabel(item.type, t)}
                    </span>
                    {item.costUsd != null && (
                      <span className="text-xs text-muted-foreground">
                        ${item.costUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                  {formatRelativeTime(item.timestamp, t)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Scroll sentinel for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />

        {loading && items.length > 0 && (
          <div className="flex justify-center py-3">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!hasMore && items.length > 0 && (
          <p className="text-center text-xs text-muted-foreground py-3">
            {t('feed.allLoaded')}
          </p>
        )}
      </div>
    </div>
  )
}
