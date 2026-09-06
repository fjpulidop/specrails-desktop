import { useEffect, useMemo, useState } from 'react'
import { Content as DialogContent } from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronRight, Loader2, RefreshCw, Search, Terminal, X } from 'lucide-react'
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from './ui/dialog'
import { BackgroundProcessLogsModal, sanitizeBackgroundLog } from './BackgroundProcessLogsModal'
import { isBackgroundProcessFinished } from './BackgroundProcessChip'
import { backgroundProcessKey } from '../lib/background-processes-api'
import type { BackgroundProcessView } from '../context/BackgroundProcessesContext'
import type { BackgroundProcess } from '../types'

export function BackgroundProcessHistoryModal({ processes, loading, error, onRefresh, onClose, onKill }: {
  processes: BackgroundProcessView[]
  loading: boolean
  error: string | null
  onRefresh: () => Promise<void>
  onClose: () => void
  onKill: (process: BackgroundProcess) => Promise<void> | void
}) {
  const { t } = useTranslation('agent')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [selected, setSelected] = useState<BackgroundProcessView | null>(null)
  useEffect(() => { void onRefresh() }, [onRefresh])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return processes.filter(process => !needle || [process.command, process.cwd, process.repositoryName, process.repositoryId, process.pid, t(`backgroundProcess.status.${process.status}`)].join(' ').toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(isBackgroundProcessFinished(a)) - Number(isBackgroundProcessFinished(b)) || b.startedAt - a.startedAt)
  }, [processes, query, t])
  if (selected) return <BackgroundProcessLogsModal
    process={processes.find(process => backgroundProcessKey(process) === backgroundProcessKey(selected)) ?? selected}
    onClose={onClose} onBack={() => setSelected(null)} onKill={onKill} />
  const control = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-40'
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogPortal>
      <DialogOverlay className="z-[80]" />
      <DialogContent data-testid="background-process-history-modal" className="fixed left-1/2 top-1/2 z-[81] flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border/50 bg-popover text-foreground shadow-2xl focus:outline-none">
        <header className="flex items-start gap-3 border-b border-border/50 px-4 py-3">
          <Terminal className="mt-0.5 h-5 w-5 shrink-0 text-accent-info" aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-sm font-semibold">{t('backgroundProcess.history.title')}</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">{t('backgroundProcess.history.description')}</DialogDescription>
          </div>
          <DialogClose className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary" aria-label={t('backgroundProcess.history.close')}><X className="h-4 w-4" /></DialogClose>
        </header>
        <div className="flex gap-2 border-b border-border/50 px-4 py-3">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
            <input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(100) }} placeholder={t('backgroundProcess.history.search')} aria-label={t('backgroundProcess.history.search')} className="h-8 w-full rounded-md border border-border/60 bg-background/50 pl-8 pr-2 text-xs outline-none focus:border-accent-primary/60" />
          </label>
          <button type="button" className={control} disabled={loading} onClick={() => void onRefresh()} aria-label={t('backgroundProcess.history.refresh')} title={t('backgroundProcess.history.refresh')}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden /></button>
        </div>
        {error && <div role="alert" className="flex items-center gap-2 border-b border-border/40 bg-destructive/5 px-4 py-2 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1">{t('backgroundProcess.history.loadFailed')}</span><button type="button" className={control} onClick={() => void onRefresh()}>{t('backgroundProcess.retry')}</button></div>}
        <div className="min-h-[160px] overflow-y-auto p-2">
          {filtered.slice(0, limit).map(process => <button type="button" key={backgroundProcessKey(process)} onClick={() => setSelected(process)} aria-label={t('backgroundProcess.open', { command: process.command })} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary">
            <Terminal className={`h-4 w-4 shrink-0 ${isBackgroundProcessFinished(process) ? 'text-muted-foreground' : 'text-accent-info'}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs text-foreground">{sanitizeBackgroundLog(process.command)}</span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">{sanitizeBackgroundLog(process.repositoryName ?? process.cwd)} · {new Date(process.startedAt).toLocaleString()} · PID {process.pid}</span>
            </span>
            <span className={`max-w-[35%] shrink-0 rounded-full px-2 py-0.5 text-[10px] ${process.status === 'failed' ? 'bg-destructive/10 text-destructive' : isBackgroundProcessFinished(process) ? 'bg-muted text-muted-foreground' : 'bg-accent-info/10 text-accent-info'}`}>{t(`backgroundProcess.status.${process.status}`)}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>)}
          {loading && !processes.length ? <p role="status" className="flex justify-center gap-2 py-12 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('backgroundProcess.history.loading')}</p>
            : !error && !filtered.length && <p className="px-4 py-12 text-center text-xs text-muted-foreground">{t(query.trim() ? 'backgroundProcess.history.noMatches' : 'backgroundProcess.history.empty')}</p>}
          {filtered.length > limit && <div className="py-2 text-center"><button type="button" className={control} onClick={() => setLimit(value => value + 100)}>{t('backgroundProcess.history.showMore')}</button></div>}
        </div>
        <footer className="border-t border-border/50 px-4 py-2 text-[10px] text-muted-foreground">{t('backgroundProcess.history.count', { count: filtered.length })}</footer>
      </DialogContent>
    </DialogPortal>
  </Dialog>
}
