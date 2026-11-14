import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'
import { isBackgroundProcessFinished } from './BackgroundProcessChip'
import { backgroundProcessKey } from '../lib/background-processes-api'
import type { BackgroundProcessView } from '../context/BackgroundProcessesContext'
import type { BackgroundProcess } from '../../../types'

const MAX_ROWS = 8

/** Compact process list shown in the Processes popover; full search and history stay in the history modal. */
export function BackgroundProcessesPanel({ processes, loading, error, onRefresh, onSelect, onViewAll }: {
  processes: BackgroundProcessView[]
  loading: boolean
  error: string | null
  onRefresh: () => Promise<void>
  onSelect: (process: BackgroundProcess) => void
  onViewAll: () => void
}) {
  const { t } = useTranslation('agent')
  useEffect(() => { void onRefresh() }, [onRefresh])
  const rows = [...processes]
    .sort((a, b) => Number(isBackgroundProcessFinished(a)) - Number(isBackgroundProcessFinished(b)) || b.startedAt - a.startedAt)
    .slice(0, MAX_ROWS)
  return <div data-testid="background-processes-panel" className="space-y-3">
    <div className="flex items-start gap-2">
      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-accent-info" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('backgroundProcess.history.title')}</div>
        <div className="text-xs text-muted-foreground">{t('backgroundProcess.history.description')}</div>
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{t('backgroundProcess.history.loadFailed')}</p>}
    {rows.length === 0
      ? <p className="text-sm text-muted-foreground">{loading ? t('backgroundProcess.history.loading') : t('backgroundProcess.history.empty')}</p>
      : <ul className="divide-y divide-border/50 rounded-md border border-border/60">
        {rows.map(process => (
          <li key={backgroundProcessKey(process)}>
            <button type="button" onClick={() => onSelect(process)} aria-label={t('backgroundProcess.open', { command: process.command })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{process.command}</span>
                <span className="block text-xs text-muted-foreground">PID {process.pid}{process.repositoryName ? ` · ${process.repositoryName}` : ''}</span>
              </span>
              <span className={`shrink-0 text-xs ${isBackgroundProcessFinished(process) ? 'text-muted-foreground' : 'text-accent-info'}`}>{t(`backgroundProcess.status.${process.status}`)}</span>
            </button>
          </li>
        ))}
      </ul>}
    <button type="button" onClick={onViewAll}
      className="inline-flex h-8 w-full items-center justify-center rounded-md border border-border/60 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
      {t('backgroundProcess.history.viewAll')}
    </button>
  </div>
}
