import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileMinus2, FilePlus2, FileText, GitCommitHorizontal, History, Loader2, RefreshCw } from 'lucide-react'
import { repositoryApiBase } from '../../lib/project-repositories'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'
import { useCodeRepository } from './CodeRepositoryContext'
import type { ExplorerLocation } from './explorer-types'

interface ActivityEntry {
  id: number
  repositoryId: string
  repositoryName: string
  path: string
  jobId: string | null
  ticketId: number | null
  kind: 'created' | 'modified' | 'deleted'
  at: number
  hasPatch: boolean
  patchTruncated: boolean
}
interface ActivityPage { entries: ActivityEntry[]; nextCursor: string | null; truncated: boolean }
interface ActivitySnapshot extends ActivityPage { scope: string }

export function CodeActivity({ projectId, repositoryName, multipleRepositories, jobId, ticketId, onOpen }: {
  projectId: string
  repositoryName?: string
  multipleRepositories: boolean
  jobId?: string | null
  ticketId?: number | null
  onOpen: (location: ExplorerLocation) => void
}) {
  const { t, i18n } = useTranslation('code')
  const { repositoryId, repositoryPath } = useCodeRepository()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [allRepositories, setAllRepositories] = useState(multipleRepositories)
  const [snapshot, setData] = useState<ActivitySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestId = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const instanceId = useId()
  const scope = JSON.stringify([projectId, repositoryId, repositoryPath, allRepositories, jobId, ticketId])
  const activeScope = useRef(scope)
  activeScope.current = scope
  // A new address must never briefly display or open an old scope's records,
  // even before the passive effect cancels its pending request.
  const data = snapshot?.scope === scope ? snapshot : null
  const load = useCallback(async (cursor?: string) => {
    const generation = ++requestId.current
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setLoading(true); setFailed(false)
    if (!cursor) setData(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (!allRepositories && repositoryId) params.set('repositoryId', repositoryId)
      if (jobId) params.set('jobId', jobId)
      if (ticketId) params.set('ticketId', String(ticketId))
      if (cursor) params.set('cursor', cursor)
      const response = await fetch(`${repositoryApiBase(projectId)}/code/activity?${params}`, { signal: request.signal })
      if (!response.ok) throw new Error('activity_failed')
      const page = await response.json() as ActivityPage
      if (!Array.isArray(page.entries) || (cursor && page.nextCursor === cursor)) throw new Error('invalid_activity_page')
      if (request.signal.aborted || generation !== requestId.current || activeScope.current !== scope) return
      setData(previous => {
        const entries = cursor && previous?.scope === scope ? [...previous.entries, ...page.entries] : page.entries
        const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()]
        const capped = unique.length > 1000 || (unique.length === 1000 && page.nextCursor !== null)
        return { ...page, scope, entries: unique.slice(0, 1000), nextCursor: capped ? null : page.nextCursor,
          truncated: page.truncated || capped || (!!cursor && previous?.scope === scope && previous.truncated) }
      })
    } catch {
      if (!request.signal.aborted && generation === requestId.current && activeScope.current === scope) setFailed(true)
    } finally {
      if (!request.signal.aborted && generation === requestId.current && activeScope.current === scope) setLoading(false)
    }
  }, [projectId, repositoryId, repositoryPath, allRepositories, jobId, ticketId, scope])

  useEffect(() => { void load(); return () => { requestId.current++; controller.current?.abort() } }, [load])
  useEffect(() => {
    const id = `code-activity-${projectId}-${instanceId}`
    let timer: ReturnType<typeof setTimeout> | undefined
    registerHandler(id, raw => {
      const message = raw as { type?: string; projectId?: string }
      if (message.type !== 'file.provenance_updated' || message.projectId !== projectId) return
      // Job hooks can emit one event per path. Coalesce them into one refresh.
      clearTimeout(timer)
      timer = setTimeout(() => { void load() }, 250)
    })
    return () => { clearTimeout(timer); unregisterHandler(id) }
  }, [load, projectId, instanceId, registerHandler, unregisterHandler])

  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t('explore.activity')}>
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex items-start justify-between gap-2"><p className="text-xs leading-relaxed text-muted-foreground">{t('activity.description')}</p><button type="button" disabled={loading} onClick={() => { void load() }} aria-label={t('explore.refresh')} title={t('explore.refresh')} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button></div>
      {multipleRepositories && <select aria-label={t('activity.scope')} value={allRepositories ? 'all' : 'current'} onChange={event => setAllRepositories(event.target.value === 'all')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"><option value="all">{t('search.allRepositories')}</option><option value="current">{repositoryName ?? t('search.currentRepository')}</option></select>}
      {(ticketId || jobId) && <p className="break-all text-[11px] text-accent-primary">{ticketId ? t('provenancePanel.specTitle', { ticketId }) : t('provenancePanel.jobTitle', { jobId })}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
      {failed && <div role="alert" className="space-y-2 p-3 text-xs"><p>{t('activity.failed')}</p><button type="button" onClick={() => { void load(data?.nextCursor ?? undefined) }} className="text-accent-primary underline">{t('explore.retry')}</button></div>}
      {data?.truncated && <p role="status" className="border-b border-border p-3 text-xs text-amber-600 dark:text-amber-400">{t('activity.partial')}</p>}
      {data && data.entries.length === 0 && !data.truncated && !data.nextCursor && !loading && <div className="space-y-2 p-6 text-center text-xs text-muted-foreground"><History className="mx-auto h-6 w-6 opacity-50" /><p>{t('activity.empty')}</p></div>}
      <ol>{data?.entries.map((entry, index) => {
        const previous = data.entries[index - 1]
        const groupStart = !previous || previous.repositoryId !== entry.repositoryId || previous.jobId !== entry.jobId || previous.ticketId !== entry.ticketId
        const Icon = entry.kind === 'created' ? FilePlus2 : entry.kind === 'deleted' ? FileMinus2 : FileText
        return <li key={entry.id}>
          {groupStart && <div className="sticky top-0 z-[1] space-y-1 border-y border-border bg-background/95 px-3 py-2 backdrop-blur">
            <div className="flex items-center gap-2 text-[11px]"><span className="min-w-0 flex-1 truncate font-medium">{entry.repositoryName}</span>{entry.ticketId != null && <span className="rounded bg-accent-primary/10 px-1.5 py-0.5 text-accent-primary">{t('story.spec', { ticketId: entry.ticketId })}</span>}</div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span className="inline-flex min-w-0 items-center gap-1" title={entry.jobId ?? undefined}><GitCommitHorizontal className="h-3 w-3" />{entry.jobId?.slice(0, 10) ?? t('history.unknownJob')}</span><time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString(i18n.language)}>{new Date(entry.at).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}</time></div>
          </div>}
          <button type="button" onClick={() => onOpen({ repositoryId: entry.repositoryId, path: entry.path, changeJobId: entry.jobId })} className="flex w-full items-start gap-2 border-b border-border/30 px-3 py-3 text-left hover:bg-muted/50" title={entry.path}>
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${entry.kind === 'created' ? 'text-accent-success' : entry.kind === 'deleted' ? 'text-destructive' : 'text-accent-info'}`} />
            <span className="min-w-0 flex-1 space-y-1"><span className="block break-all font-mono text-xs">{entry.path}</span><span className="block text-[10px] text-muted-foreground">{t(`story.kindLabel.${entry.kind}`)} · {t(entry.hasPatch ? entry.patchTruncated ? 'activity.partialPatch' : 'activity.patch' : 'activity.noPatch')}</span></span>
          </button>
        </li>
      })}</ol>
      {loading && <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('activity.loading')}</p>}
      {data?.nextCursor && !loading && !failed && <button type="button" onClick={() => { void load(data.nextCursor!) }} className="m-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/50">{t('activity.loadMore')}</button>}
    </div>
  </section>
}
