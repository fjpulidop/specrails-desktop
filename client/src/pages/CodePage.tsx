import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FileMinus2, FilePlus2, FileText, Filter, RotateCw, X } from 'lucide-react'
import { FileTree } from '../components/code-explorer/FileTree'
import { FileViewer, type CopyPathAction, type SummaryAction } from '../components/code-explorer/FileViewer'
import { getApiBase } from '../lib/api'
import { useDesktop } from '../hooks/useDesktop'

type ProvenanceKind = 'created' | 'modified' | 'deleted'

interface ProvenanceRow {
  path: string
  ticketId: number | null
  jobId: string | null
  kind: ProvenanceKind
  at: number
}

const DEFAULT_TREE_WIDTH = 320
const MIN_TREE_WIDTH = 240
const MIN_MAIN_WIDTH = 520

function treeWidthKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:code-tree-width:${projectId}` : null
}

function loadTreeWidth(projectId: string | null): number {
  const key = treeWidthKey(projectId)
  if (!key) return DEFAULT_TREE_WIDTH
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TREE_WIDTH
  } catch {
    return DEFAULT_TREE_WIDTH
  }
}

function saveTreeWidth(projectId: string | null, width: number): void {
  const key = treeWidthKey(projectId)
  if (!key) return
  try { localStorage.setItem(key, String(Math.round(width))) } catch { /* ignore */ }
}

function clampTreeWidth(width: number, containerWidth: number): number {
  const max = Math.max(MIN_TREE_WIDTH, containerWidth - MIN_MAIN_WIDTH)
  return Math.min(Math.max(width, MIN_TREE_WIDTH), max)
}

export interface CodePageProps {
  /** When embedded (Agent-Mode Files split pane), CodePage is controlled: it
   *  never navigates to /code and never reads/writes the URL — selection +
   *  provenance filters live in local state (seeded by `initialPath`) and file
   *  opens report via `onSelectedPathChange`. */
  embedded?: boolean
  initialPath?: string | null
  onSelectedPathChange?: (path: string | null) => void
}

export default function CodePage({ embedded = false, initialPath = null, onSelectedPathChange }: CodePageProps = {}) {
  const { t } = useTranslation('code')
  const { activeProjectId } = useDesktop()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const initial = embedded ? initialPath : searchParams.get('path')
  const [relPath, setRelPathState] = useState<string | null>(initial)
  const setRelPath = useCallback((p: string | null) => {
    setRelPathState(p)
    onSelectedPathChange?.(p)
  }, [onSelectedPathChange])
  const [summaryAction, setSummaryAction] = useState<SummaryAction | null>(null)
  const [copyPathAction, setCopyPathAction] = useState<CopyPathAction | null>(null)
  const [treeWidth, setTreeWidth] = useState(() => loadTreeWidth(activeProjectId))
  // Provenance filters: route-driven normally, local state when embedded.
  const [embJobId, setEmbJobId] = useState<string | null>(null)
  const [embTicketId, setEmbTicketId] = useState<number | null>(null)
  const jobId = embedded ? embJobId : searchParams.get('jobId')
  const ticketId = useMemo(() => {
    if (embedded) return embTicketId
    const raw = searchParams.get('ticketId')
    if (!raw) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }, [embedded, embTicketId, searchParams])
  const [ticketInput, setTicketInput] = useState(ticketId != null ? String(ticketId) : '')

  useEffect(() => {
    if (embedded) return
    const next = searchParams.get('path')
    if (next !== relPath) setRelPathState(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, embedded])

  useEffect(() => {
    setTicketInput(ticketId != null ? String(ticketId) : '')
  }, [ticketId])

  useEffect(() => {
    const width = containerRef.current?.clientWidth || window.innerWidth
    setTreeWidth(clampTreeWidth(loadTreeWidth(activeProjectId), width))
  }, [activeProjectId])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width !== 'number') return
      setTreeWidth((prev) => clampTreeWidth(prev, width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const beginTreeResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX
    const startWidth = treeWidth
    const containerWidth = containerRef.current?.clientWidth || window.innerWidth
    const target = e.currentTarget
    try { target.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    function onMove(ev: PointerEvent) {
      setTreeWidth(clampTreeWidth(startWidth + (ev.clientX - startX), containerWidth))
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setTreeWidth((prev) => {
        const next = clampTreeWidth(prev, containerWidth)
        saveTreeWidth(activeProjectId, next)
        return next
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [activeProjectId, treeWidth])

  const resetTreeWidth = useCallback(() => {
    const width = containerRef.current?.clientWidth || window.innerWidth
    const next = clampTreeWidth(DEFAULT_TREE_WIDTH, width)
    setTreeWidth(next)
    saveTreeWidth(activeProjectId, next)
  }, [activeProjectId])

  const onOpenFile = useCallback((p: string) => {
    setRelPath(p)
    if (embedded) return
    const params = new URLSearchParams(searchParams)
    params.set('path', p)
    navigate({ pathname: '/code', search: `?${params.toString()}` }, { replace: true })
  }, [embedded, navigate, searchParams, setRelPath])

  const onFilterJob = useCallback((nextJobId: string) => {
    if (embedded) {
      setEmbJobId(nextJobId)
      setEmbTicketId(null)
      return
    }
    const params = new URLSearchParams(searchParams)
    params.set('jobId', nextJobId)
    params.delete('ticketId')
    navigate({ pathname: '/code', search: `?${params.toString()}` }, { replace: true })
  }, [embedded, navigate, searchParams])

  const clearProvenanceFilter = useCallback(() => {
    if (embedded) {
      setEmbJobId(null)
      setEmbTicketId(null)
      return
    }
    const params = new URLSearchParams(searchParams)
    params.delete('jobId')
    params.delete('ticketId')
    navigate({ pathname: '/code', search: params.toString() ? `?${params.toString()}` : '' }, { replace: true })
  }, [embedded, navigate, searchParams])

  const applyTicketFilter = useCallback((value: string) => {
    const n = Number(value.trim())
    if (!Number.isInteger(n) || n <= 0) {
      clearProvenanceFilter()
      return
    }
    if (embedded) {
      setEmbTicketId(n)
      setEmbJobId(null)
      return
    }
    const params = new URLSearchParams(searchParams)
    params.set('ticketId', String(n))
    params.delete('jobId')
    navigate({ pathname: '/code', search: `?${params.toString()}` }, { replace: true })
  }, [clearProvenanceFilter, embedded, navigate, searchParams])

  return (
    <div ref={containerRef} className="flex h-full w-full" data-testid="code-page">
      <aside className="overflow-hidden flex flex-col shrink-0" style={{ width: treeWidth }}>
        <FileTree
          key={activeProjectId ?? 'no-project'}
          onOpenFile={onOpenFile}
          selectedPath={relPath}
          filterJobId={jobId}
          filterTicketId={ticketId}
        />
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('page.resizeFileTree')}
        onPointerDown={beginTreeResize}
        onDoubleClick={resetTreeWidth}
        className="relative w-1.5 shrink-0 cursor-col-resize select-none touch-none border-x border-border/40 hover:bg-accent-primary/20 focus-visible:outline-none focus-visible:bg-accent-primary/30"
        title={t('resizer.hint')}
        data-testid="code-tree-resizer"
      />
      <main className="flex-1 overflow-hidden flex flex-col">
        <CodeProvenanceToolbar
          jobId={jobId}
          ticketId={ticketId}
          ticketInput={ticketInput}
          onTicketInputChange={setTicketInput}
          onApplyTicket={applyTicketFilter}
          onClear={clearProvenanceFilter}
          summaryAction={summaryAction}
          copyPathAction={copyPathAction}
        />
        {(jobId || ticketId) && (
          <ProvenanceResultPanel
            jobId={jobId}
            ticketId={ticketId}
            onOpenFile={onOpenFile}
          />
        )}
        {relPath ? (
          <FileViewer
            relPath={relPath}
            onFilterJob={onFilterJob}
            onSummaryActionChange={setSummaryAction}
            onCopyPathActionChange={setCopyPathAction}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            {t('page.selectFile')}
          </div>
        )}
      </main>
    </div>
  )
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
  const [rows, setRows] = useState<ProvenanceRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (jobId) params.set('jobId', jobId)
    if (ticketId) params.set('ticketId', String(ticketId))
    fetch(`${getApiBase()}/code/provenance?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data) ? data as ProvenanceRow[] : [])
      })
      .catch(() => { if (!cancelled) setRows([]) })
    return () => { cancelled = true }
  }, [jobId, ticketId])

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
    <section className="border-b border-border bg-card/35 px-4 py-3" data-testid="provenance-result-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold truncate">{title}</h2>
            <span className="text-[11px] text-muted-foreground">{t('provenancePanel.touchedFiles', { count: total })}</span>
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
