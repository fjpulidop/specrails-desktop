import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, ChevronRight, ExternalLink, FileMinus2, FilePlus2, FileText, Files, Filter, FolderSearch, History, PanelLeftClose, PanelLeftOpen, RotateCw, Search, X } from 'lucide-react'
import { FileTree } from '../components/code-explorer/FileTree'
import { FileViewer, type CopyPathAction, type SummaryAction } from '../components/code-explorer/FileViewer'
import { CodeSearch } from '../components/code-explorer/CodeSearch'
import { CodeActivity } from '../components/code-explorer/CodeActivity'
import { positiveLine, type ExplorerLocation, type ExplorerMode } from '../components/code-explorer/explorer-types'
import { getApiBase } from '../lib/api'
import { projectRepositories, repositoryApiBase } from '../lib/project-repositories'
import { CodeRepositoryContext, useCodeRepository } from '../components/code-explorer/CodeRepositoryContext'
import { useDesktop } from '../hooks/useDesktop'

type ProvenanceKind = 'created' | 'modified' | 'deleted'
interface ProvenanceRow { path: string; ticketId: number | null; jobId: string | null; kind: ProvenanceKind; at: number }
const DEFAULT_TREE_WIDTH = 320
const MIN_TREE_WIDTH = 240
const MIN_MAIN_WIDTH = 420
const COMPACT_WIDTH = 760
const widthKey = (projectId: string | null) => `specrails-desktop:code-tree-width:${projectId}`
function loadTreeWidth(projectId: string | null): number {
  try { const value = Number(localStorage.getItem(widthKey(projectId))); return value > 0 && Number.isFinite(value) ? value : DEFAULT_TREE_WIDTH } catch { return DEFAULT_TREE_WIDTH }
}
function saveTreeWidth(projectId: string | null, width: number) {
  if (projectId) try { localStorage.setItem(widthKey(projectId), String(Math.round(width))) } catch { /* optional preference */ }
}
function clampTreeWidth(width: number, containerWidth: number) { return Math.min(Math.max(width, MIN_TREE_WIDTH), Math.max(MIN_TREE_WIDTH, containerWidth - MIN_MAIN_WIDTH)) }

export interface CodePageProps {
  embedded?: boolean
  initialPath?: string | null
  initialRepositoryId?: string | null
  onRepositoryChange?: (repositoryId: string) => void
  onSelectedPathChange?: (path: string | null) => void
}

export default function CodePage(props: CodePageProps = {}) {
  const { activeProjectId } = useDesktop()
  return <CodeWorkspace key={activeProjectId ?? 'no-project'} {...props} />
}

function CodeWorkspace({ embedded = false, initialPath = null, initialRepositoryId, onRepositoryChange, onSelectedPathChange }: CodePageProps) {
  const { t } = useTranslation('code')
  const { t: tc } = useTranslation('common')
  const { activeProjectId, projects } = useDesktop()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const project = projects?.find(item => item.id === activeProjectId)
  const repositories = useMemo(() => projectRepositories(project), [project])
  const [history, setHistory] = useState<{ entries: ExplorerLocation[]; index: number }>(() => ({ entries: [{ repositoryId: initialRepositoryId ?? undefined, path: initialPath }], index: 0 }))
  const location: ExplorerLocation = embedded ? history.entries[history.index] : {
    repositoryId: params.get('repositoryId') ?? undefined,
    path: params.get('path'), line: positiveLine(params.get('line')), changeJobId: params.get('changeJobId'),
  }
  const repository = location.repositoryId ? repositories.find(item => item.id === location.repositoryId) : repositories.find(item => item.isPrimary)
  const invalid = !!location.repositoryId && !!project && !repository
  const scope = useMemo(() => ({ apiBase: activeProjectId ? repositoryApiBase(activeProjectId, repository?.id) : getApiBase(), repositoryId: repository?.id, repositoryPath: repository?.path, isPrimary: repository?.isPrimary }), [activeProjectId, repository?.id, repository?.path, repository?.isPrimary])
  const identity = JSON.stringify([activeProjectId, repository?.id, repository?.path])
  const [mode, setMode] = useState<ExplorerMode>('files')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [compact, setCompact] = useState(embedded)
  const [treeWidth, setTreeWidth] = useState(() => loadTreeWidth(activeProjectId))
  const [summaryAction, setSummaryAction] = useState<SummaryAction | null>(null)
  const [copyPathAction, setCopyPathAction] = useState<CopyPathAction | null>(null)
  const [embFilter, setEmbFilter] = useState<{ jobId?: string; ticketId?: number }>({})
  const jobId = embedded ? embFilter.jobId ?? null : params.get('jobId')
  const ticketId = embedded ? embFilter.ticketId ?? null : positiveLine(params.get('ticketId')) ?? null
  const [ticketInput, setTicketInput] = useState(ticketId ? String(ticketId) : '')
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)

  useEffect(() => { setTicketInput(ticketId ? String(ticketId) : '') }, [ticketId])
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = (width: number) => {
      if (!width) return
      setCompact(width < COMPACT_WIDTH)
      setTreeWidth(previous => clampTreeWidth(previous, width))
    }
    measure(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => measure(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => resizeCleanup.current?.(), [])
  useEffect(() => { if (compact && location.path) setSidebarOpen(false) }, [compact, location.path])

  const openLocation = useCallback((target: ExplorerLocation) => {
    const next = { ...target, repositoryId: target.repositoryId ?? repository?.id }
    const switchingRepository = next.repositoryId !== repository?.id
    if (embedded) {
      setHistory(previous => ({ entries: [...previous.entries.slice(0, previous.index + 1), next], index: previous.index + 1 }))
      if (switchingRepository) setEmbFilter({})
    } else {
      const nextParams = new URLSearchParams(params)
      for (const key of ['path', 'line', 'changeJobId']) nextParams.delete(key)
      if (next.repositoryId) nextParams.set('repositoryId', next.repositoryId)
      if (next.path) nextParams.set('path', next.path)
      if (next.line) nextParams.set('line', String(next.line))
      if (next.changeJobId) nextParams.set('changeJobId', next.changeJobId)
      if (switchingRepository) { nextParams.delete('jobId'); nextParams.delete('ticketId') }
      setParams(nextParams)
    }
    onSelectedPathChange?.(next.path)
    if (next.repositoryId) onRepositoryChange?.(next.repositoryId)
    if (compact && next.path) setSidebarOpen(false)
  }, [embedded, repository?.id, params, setParams, onSelectedPathChange, onRepositoryChange, compact])

  const moveHistory = (delta: number) => {
    if (!embedded) { navigate(delta); return }
    const index = history.index + delta
    const next = history.entries[index]
    if (!next) return
    const nextRepositoryId = next.repositoryId ?? repositories.find(item => item.isPrimary)?.id
    if (nextRepositoryId !== repository?.id) setEmbFilter({})
    setHistory({ ...history, index })
    onSelectedPathChange?.(next.path)
    if (nextRepositoryId) onRepositoryChange?.(nextRepositoryId)
  }
  const filterBy = useCallback((next: { jobId?: string; ticketId?: number }) => {
    if (embedded) setEmbFilter(next)
    else {
      const nextParams = new URLSearchParams(params)
      nextParams.delete('jobId'); nextParams.delete('ticketId')
      if (next.jobId) nextParams.set('jobId', next.jobId)
      if (next.ticketId) nextParams.set('ticketId', String(next.ticketId))
      setParams(nextParams)
    }
  }, [embedded, params, setParams])
  const onFilterJob = useCallback((id: string) => { filterBy({ jobId: id }); setMode('activity'); setSidebarOpen(true) }, [filterBy])
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeCleanup.current?.()
    const startX = event.clientX, startWidth = treeWidth
    let latest = treeWidth
    const move = (e: PointerEvent) => { latest = clampTreeWidth(startWidth + e.clientX - startX, containerRef.current?.clientWidth || window.innerWidth); setTreeWidth(latest) }
    const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); saveTreeWidth(activeProjectId, latest); resizeCleanup.current = null }
    resizeCleanup.current = finish
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish)
  }
  const showSidebar = sidebarOpen || !location.path
  const showReader = !compact || !showSidebar
  const breadcrumb = location.path?.split('/') ?? []

  return <CodeRepositoryContext.Provider value={scope}>
    <div ref={containerRef} className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="code-page" data-compact={compact}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/30 px-3 py-2">
        <div className="flex items-center gap-0.5">
          <button type="button" aria-label={t('explore.back')} title={t('explore.back')} onClick={() => moveHistory(-1)} disabled={embedded && history.index === 0} className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowLeft className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label={t('explore.forward')} title={t('explore.forward')} onClick={() => moveHistory(1)} disabled={embedded && history.index === history.entries.length - 1} className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-30"><ArrowRight className="h-3.5 w-3.5" /></button>
          {location.path && <button type="button" aria-label={t(showSidebar ? 'explore.hideNavigation' : 'explore.showNavigation')} title={t(showSidebar ? 'explore.hideNavigation' : 'explore.showNavigation')} onClick={() => setSidebarOpen(!showSidebar)} className="rounded p-1.5 text-muted-foreground hover:bg-muted">{showSidebar ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}</button>}
        </div>
        {repositories.length > 0 && <select aria-label={tc('repositories.select')} className="max-w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs" value={repository?.id ?? location.repositoryId ?? ''} onChange={event => openLocation({ repositoryId: event.target.value, path: null })}>
          {invalid && <option value={location.repositoryId}>{tc('repositories.unavailable')}</option>}
          {repositories.map(item => <option key={item.id} value={item.id}>{item.name}{item.isPrimary ? ` · ${tc('repositories.primary')}` : ''}</option>)}
        </select>}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={repository?.path}>{repository?.path}</span>
      </header>
      {invalid ? <p role="alert" className="p-4 text-sm text-destructive">{tc('repositories.invalidSelection')}</p> : <div className="flex min-h-0 flex-1 overflow-hidden">
        {<aside hidden={!showSidebar} className={`${showSidebar ? 'flex' : 'hidden'} min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-card/15`} style={{ width: compact ? '100%' : treeWidth }} aria-label={t('explore.navigation')}>
          <nav className="flex shrink-0 gap-0.5 border-b border-border px-2 pt-2" aria-label={t('explore.views')}>
            {([{ mode: 'files', Icon: Files }, { mode: 'search', Icon: Search }, { mode: 'activity', Icon: History }] as const).map(({ mode: value, Icon }) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-xs ${mode === value ? 'border-accent-primary text-accent-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}><Icon className="h-3.5 w-3.5 shrink-0" />{t(`explore.${value}`)}</button>)}
          </nav>
          <div className={mode === 'files' ? 'min-h-0 flex-1' : 'hidden'}><FileTree key={identity} selectedPath={location.path} onOpenFile={path => openLocation({ path })} filterJobId={jobId} filterTicketId={ticketId} /></div>
          {activeProjectId && <div className={mode === 'search' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><CodeSearch active={mode === 'search' && showSidebar} projectId={activeProjectId} repositoryName={repository?.name} multipleRepositories={repositories.length > 1} onOpen={openLocation} /></div>}
          {mode === 'activity' && activeProjectId && <CodeActivity projectId={activeProjectId} repositoryName={repository?.name} multipleRepositories={repositories.length > 1} jobId={jobId} ticketId={ticketId} onOpen={openLocation} />}
        </aside>}
        {showSidebar && !compact && <div role="separator" aria-orientation="vertical" aria-label={t('page.resizeFileTree')} onPointerDown={beginResize} onDoubleClick={() => { const next = clampTreeWidth(DEFAULT_TREE_WIDTH, containerRef.current?.clientWidth || window.innerWidth); setTreeWidth(next); saveTreeWidth(activeProjectId, next) }} className="w-1.5 shrink-0 cursor-col-resize touch-none select-none border-x border-border/40 hover:bg-accent-primary/20" title={t('resizer.hint')} data-testid="code-tree-resizer" />}
        {<main hidden={!showReader} className={`${showReader ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}>
          {location.path && <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 text-[11px]" aria-label={t('explore.breadcrumb')}>
            <FileText className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {breadcrumb.map((part, index) => <span key={index} className={`flex shrink-0 items-center gap-1 ${index === breadcrumb.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{index > 0 && <ChevronRight className="h-3 w-3" />}{part}</span>)}
            {location.line && <span className="ml-1 shrink-0 text-accent-primary">:{location.line}</span>}
          </div>}
          <CodeProvenanceToolbar jobId={jobId} ticketId={ticketId} ticketInput={ticketInput} onTicketInputChange={setTicketInput} onApplyTicket={value => filterBy({ ticketId: positiveLine(value.trim()) })} onClear={() => filterBy({})} summaryAction={location.path ? summaryAction : null} copyPathAction={location.path ? copyPathAction : null} />
          {(jobId || ticketId) && <ProvenanceResultPanel key={`${identity}:${jobId}:${ticketId}`} jobId={jobId} ticketId={ticketId} onOpenFile={path => openLocation({ path, changeJobId: jobId })} />}
          {location.path ? <FileViewer key={`${identity}:${location.path}`} compact={compact} relPath={location.path} initialLine={location.line} initialJobId={location.changeJobId} onFilterJob={onFilterJob} onSummaryActionChange={setSummaryAction} onCopyPathActionChange={setCopyPathAction} /> : <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
            <div className="max-w-sm space-y-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-primary/20 bg-accent-primary/10 text-accent-primary"><FolderSearch className="h-7 w-7" /></div>
              <div><h1 className="text-lg font-semibold">{t('explore.welcome')}</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('explore.description')}</p></div>
              <div className="flex flex-wrap justify-center gap-2"><button type="button" onClick={() => { setMode('search'); setSidebarOpen(true) }} className="rounded-lg bg-accent-primary/15 px-3 py-2 text-xs text-accent-primary">{t('explore.findCode')}</button><button type="button" onClick={() => { setMode('activity'); setSidebarOpen(true) }} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">{t('explore.viewActivity')}</button></div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">{t('explore.sourceHint')}</p>
            </div>
          </div>}
        </main>}
      </div>}
    </div>
  </CodeRepositoryContext.Provider>
}

function CodeProvenanceToolbar({
  jobId,
  ticketId,
  ticketInput,
  onTicketInputChange,
  onApplyTicket,
  onClear,
  summaryAction,
  copyPathAction,
}: {
  jobId: string | null
  ticketId: number | null
  ticketInput: string
  onTicketInputChange: (value: string) => void
  onApplyTicket: (value: string) => void
  onClear: () => void
  summaryAction: SummaryAction | null
  copyPathAction: CopyPathAction | null
}) {
  const { t } = useTranslation('code')
  const activeMode = ticketId ? 'spec' : jobId ? 'job-context' : 'all'

  return (
    <div className="border-b border-border bg-background/80 px-4 py-2" data-testid="code-provenance-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          {t('toolbar.scope')}
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-pressed={activeMode === 'all'}
          className={activeMode === 'all'
            ? 'rounded-md bg-accent-primary/20 px-2 py-1 text-xs text-accent-primary'
            : 'rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'}
        >
          {t('toolbar.allAi')}
        </button>
        <div className="flex items-center gap-1 rounded-md border border-border/70 bg-card/40 px-1 py-1">
          <button
            type="button"
            onClick={() => onApplyTicket(ticketInput)}
            aria-pressed={activeMode === 'spec'}
            className={activeMode === 'spec'
              ? 'rounded bg-accent-success/20 px-2 py-0.5 text-xs text-accent-success'
              : 'rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'}
          >
            {t('toolbar.spec')}
          </button>
          <input
            value={ticketInput}
            onChange={(e) => onTicketInputChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onApplyTicket(ticketInput) }}
            placeholder={t('toolbar.ticketIdPlaceholder')}
            inputMode="numeric"
            className="h-6 w-20 bg-transparent px-1 font-mono text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <div className="flex-1" />
        {copyPathAction && (
          <button
            type="button"
            onClick={copyPathAction.onClick}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {t('toolbar.copyFilePath')}
          </button>
        )}
        {summaryAction && (
          <button
            type="button"
            onClick={summaryAction.onClick}
            disabled={summaryAction.regenerating || !!summaryAction.disabledReason}
            aria-label={summaryAction.hasSummary ? t('toolbar.regenerateSummary') : t('toolbar.generateSummary')}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary/15 px-2.5 py-1 text-xs text-accent-primary hover:bg-accent-primary/25 disabled:opacity-50"
            title={summaryAction.disabledReason ? t('toolbar.summaryUnavailable', { reason: summaryAction.disabledReason }) : undefined}
          >
            <RotateCw className={summaryAction.regenerating ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {summaryAction.hasSummary
              ? (summaryAction.regenerating ? t('toolbar.regenerating') : t('toolbar.regenerateSummary'))
              : (summaryAction.regenerating ? t('toolbar.generating') : t('toolbar.generateSummary'))}
          </button>
        )}
        {activeMode === 'job-context' && (
          <span className="rounded-md bg-accent-info/15 px-2 py-1 text-xs text-accent-info">
            {t('toolbar.jobContext')}
          </span>
        )}
        {(jobId || ticketId) && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            {t('toolbar.clear')}
          </button>
        )}
      </div>
    </div>
  )
}

function ProvenanceResultPanel({
  jobId,
  ticketId,
  onOpenFile,
}: {
  jobId: string | null
  ticketId: number | null
  onOpenFile: (path: string) => void
}) {
  const { t } = useTranslation('code')
  const { apiBase } = useCodeRepository()
  const [rows, setRows] = useState<ProvenanceRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [partial, setPartial] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setRows(null); setFailed(false); setPartial(false)
    const params = new URLSearchParams({ limit: '100' })
    if (jobId) params.set('jobId', jobId)
    if (ticketId) params.set('ticketId', String(ticketId))
    fetch(`${apiBase}/code/activity?${params}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('activity_failed'); return response.json() })
      .then((data: { entries: ProvenanceRow[]; nextCursor?: string | null; truncated?: boolean }) => {
        if (controller.signal.aborted) return
        if (!Array.isArray(data.entries)) throw new Error('invalid_activity_response')
        // Show each file once, using its latest intervention in this scope.
        const unique = new Map<string, ProvenanceRow>()
        for (const row of data.entries) if (!unique.has(row.path)) unique.set(row.path, row)
        setRows([...unique.values()])
        setPartial(!!data.nextCursor || data.truncated === true)
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [jobId, ticketId, apiBase, retry])

  const grouped = useMemo(() => {
    const source = rows ?? []
    return {
      created: source.filter((r) => r.kind === 'created'),
      modified: source.filter((r) => r.kind === 'modified'),
      deleted: source.filter((r) => r.kind === 'deleted'),
    }
  }, [rows])

  const total = rows?.length ?? 0
  const title = jobId ? t('provenancePanel.jobTitle', { jobId }) : t('provenancePanel.specTitle', { ticketId })

  return (
    <section className="max-h-52 shrink-0 overflow-auto border-b border-border bg-card/35 px-4 py-3" data-testid="provenance-result-panel">
      {failed && <p role="alert" className="mb-2 text-xs">{t('activity.failed')} <button type="button" className="text-accent-primary underline" onClick={() => setRetry(value => value + 1)}>{t('explore.retry')}</button></p>}
      {!rows && !failed && <p role="status" className="mb-2 text-xs text-muted-foreground">{t('activity.loading')}</p>}
      {partial && <p role="status" className="mb-2 text-xs text-amber-600 dark:text-amber-400">{t('activity.partial')}</p>}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold truncate">{title}</h2>
            <span className="text-[11px] text-muted-foreground">{rows ? t('provenancePanel.touchedFiles', { count: total }) : '—'}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <ResultGroup label={t('action.added')} rows={grouped.created} icon="created" onOpenFile={onOpenFile} />
            <ResultGroup label={t('action.changed')} rows={grouped.modified} icon="modified" onOpenFile={onOpenFile} />
            <ResultGroup label={t('action.deleted')} rows={grouped.deleted} icon="deleted" onOpenFile={onOpenFile} />
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {jobId && (
            <a
              href={`/jobs/${encodeURIComponent(jobId)}`}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('provenancePanel.log')}
            </a>
          )}
        </div>
      </div>
    </section>
  )
}

function ResultGroup({
  label,
  rows,
  icon,
  onOpenFile,
}: {
  label: string
  rows: ProvenanceRow[]
  icon: ProvenanceKind
  onOpenFile: (path: string) => void
}) {
  const Icon = icon === 'created' ? FilePlus2 : icon === 'deleted' ? FileMinus2 : FileText
  return (
    <details className="group min-w-[180px] max-w-[320px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md bg-muted/35 px-2 py-1 text-xs hover:bg-muted/55">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span>{label}</span>
        <span className="text-muted-foreground">{rows.length}</span>
      </summary>
      {rows.length > 0 && (
        <div className="mt-1 max-h-28 overflow-auto rounded-md border border-border/60 bg-background/60 p-1">
          {rows.map((row, index) => (
            <button
              key={`${row.path}-${row.jobId ?? 'job'}-${row.at}-${index}`}
              type="button"
              onClick={() => onOpenFile(row.path)}
              className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              title={row.path}
            >
              {row.path}
            </button>
          ))}
        </div>
      )}
    </details>
  )
}
