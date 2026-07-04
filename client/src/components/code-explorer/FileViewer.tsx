import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, FileMinus2, FilePlus2, FileText, GitCommitHorizontal } from 'lucide-react'
import { getApiBase } from '../../lib/api'
import { useDesktop } from '../../hooks/useDesktop'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'
import { useTicketDetailModal } from '../../context/TicketDetailModalContext'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../ui/ResizeGrips'
import { CodeViewerMonaco } from './CodeViewerMonaco'
import { SummaryHeader, type SummaryPayload } from './SummaryHeader'
import { MarkdownPreview } from './MarkdownPreview'
import { ConstructionStory } from './ConstructionStory'

function isMarkdown(relPath: string, language?: string): boolean {
  if (language === 'markdown' || language === 'md') return true
  return /\.(md|mdx|markdown)$/i.test(relPath)
}

interface FileViewerProps {
  relPath: string
  onFilterJob?: (jobId: string) => void
  onSummaryActionChange?: (action: SummaryAction | null) => void
  onCopyPathActionChange?: (action: CopyPathAction | null) => void
}

export interface SummaryAction {
  hasSummary: boolean
  regenerating: boolean
  disabledReason: string | null
  onClick: () => void
}

export interface CopyPathAction {
  onClick: () => void
}

interface FileResponse {
  content?: string
  reason?: 'not-found'
  encoding?: string
  language?: string
  binary?: boolean
  sizeBytes?: number
  mime?: string
  tooLarge?: boolean
  summary?: SummaryPayload | null
  summaryStale?: boolean
  absolutePath?: string
  provenance?: ProvenanceRow[]
}

interface ProvenanceRow {
  path: string
  ticketId: number | null
  jobId: string | null
  kind: 'created' | 'modified' | 'deleted'
  at: number
}

const DEFAULT_HISTORY_HEIGHT = 180
const MIN_HISTORY_HEIGHT = 120
const MIN_VIEWER_BODY_HEIGHT = 240

function summaryCollapsedKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:code-summary-collapsed:${projectId}` : null
}

function historyHeightKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:code-history-height:${projectId}` : null
}

function historyCollapsedKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:code-history-collapsed:${projectId}` : null
}

type HistoryMode = 'story' | 'log'

function historyModeKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:code-history-mode:${projectId}` : null
}

function loadHistoryMode(projectId: string | null): HistoryMode {
  const key = historyModeKey(projectId)
  if (!key) return 'story'
  try { return localStorage.getItem(key) === 'log' ? 'log' : 'story' } catch { return 'story' }
}

function saveHistoryMode(projectId: string | null, mode: HistoryMode): void {
  const key = historyModeKey(projectId)
  if (!key) return
  try { localStorage.setItem(key, mode) } catch { /* ignore */ }
}

function loadHistoryHeight(projectId: string | null): number {
  const key = historyHeightKey(projectId)
  if (!key) return DEFAULT_HISTORY_HEIGHT
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HISTORY_HEIGHT
  } catch {
    return DEFAULT_HISTORY_HEIGHT
  }
}

function saveHistoryHeight(projectId: string | null, height: number): void {
  const key = historyHeightKey(projectId)
  if (!key) return
  try { localStorage.setItem(key, String(Math.round(height))) } catch { /* ignore */ }
}

function loadSummaryCollapsed(projectId: string | null): boolean {
  const key = summaryCollapsedKey(projectId)
  if (!key) return false
  try { return localStorage.getItem(key) === 'true' } catch { return false }
}

function saveSummaryCollapsed(projectId: string | null, collapsed: boolean): void {
  const key = summaryCollapsedKey(projectId)
  if (!key) return
  try { localStorage.setItem(key, collapsed ? 'true' : 'false') } catch { /* ignore */ }
}

function loadHistoryCollapsed(projectId: string | null): boolean {
  const key = historyCollapsedKey(projectId)
  if (!key) return false
  try { return localStorage.getItem(key) === 'true' } catch { return false }
}

function saveHistoryCollapsed(projectId: string | null, collapsed: boolean): void {
  const key = historyCollapsedKey(projectId)
  if (!key) return
  try { localStorage.setItem(key, collapsed ? 'true' : 'false') } catch { /* ignore */ }
}

function clampHistoryHeight(height: number, containerHeight: number): number {
  const max = Math.max(MIN_HISTORY_HEIGHT, containerHeight - MIN_VIEWER_BODY_HEIGHT)
  return Math.min(Math.max(height, MIN_HISTORY_HEIGHT), max)
}

export function FileViewer({ relPath, onFilterJob, onSummaryActionChange, onCopyPathActionChange }: FileViewerProps) {
  const { t } = useTranslation('code')
  const { activeProjectId } = useDesktop()
  const { openTicketDetail } = useTicketDetailModal()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const budgetModal = useMovableResizableModal({ allowMove: false })
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const [file, setFile] = useState<FileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [budgetPromptOpen, setBudgetPromptOpen] = useState(false)
  const [summaryCollapsed, setSummaryCollapsed] = useState(() => loadSummaryCollapsed(activeProjectId))
  const [historyHeight, setHistoryHeight] = useState(() => loadHistoryHeight(activeProjectId))
  const [historyCollapsed, setHistoryCollapsed] = useState(() => loadHistoryCollapsed(activeProjectId))
  const [historyMode, setHistoryMode] = useState<HistoryMode>(() => loadHistoryMode(activeProjectId))

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])
  const relPathRef = useRef(relPath)
  useEffect(() => { relPathRef.current = relPath }, [relPath])

  useEffect(() => {
    const height = viewerRef.current?.clientHeight || window.innerHeight
    setSummaryCollapsed(loadSummaryCollapsed(activeProjectId))
    setHistoryHeight(clampHistoryHeight(loadHistoryHeight(activeProjectId), height))
    setHistoryCollapsed(loadHistoryCollapsed(activeProjectId))
    setHistoryMode(loadHistoryMode(activeProjectId))
  }, [activeProjectId])

  const beginHistoryResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY
    const startHeight = historyHeight
    const containerHeight = viewerRef.current?.clientHeight || window.innerHeight
    const target = e.currentTarget
    try { target.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    function onMove(ev: PointerEvent) {
      setHistoryHeight(clampHistoryHeight(startHeight + (startY - ev.clientY), containerHeight))
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setHistoryHeight((prev) => {
        const next = clampHistoryHeight(prev, containerHeight)
        saveHistoryHeight(activeProjectId, next)
        return next
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [activeProjectId, historyHeight])

  const resetHistoryHeight = useCallback(() => {
    const height = viewerRef.current?.clientHeight || window.innerHeight
    const next = clampHistoryHeight(DEFAULT_HISTORY_HEIGHT, height)
    setHistoryHeight(next)
    saveHistoryHeight(activeProjectId, next)
  }, [activeProjectId])

  const toggleSummaryCollapsed = useCallback(() => {
    setSummaryCollapsed((prev) => {
      const next = !prev
      saveSummaryCollapsed(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  const toggleHistoryCollapsed = useCallback(() => {
    setHistoryCollapsed((prev) => {
      const next = !prev
      saveHistoryCollapsed(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  const changeHistoryMode = useCallback((mode: HistoryMode) => {
    setHistoryMode(mode)
    saveHistoryMode(activeProjectId, mode)
  }, [activeProjectId])

  useEffect(() => {
    setRegenerating(false)
    setBudgetPromptOpen(false)
    setMarkdownMode('preview')
    setEditing(false) // switching files exits edit mode (discards the unsaved draft)
  }, [relPath])

  const reqIdRef = useRef(0)
  const fetchFile = useCallback(async () => {
    // Monotonic request id: a slower fetch for a previously-selected file can
    // resolve after a newer one — ignore any response that is no longer current
    // so the viewer never shows the wrong file's content.
    const myReq = ++reqIdRef.current
    setLoading(true)
    try {
      const res = await fetch(`${getApiBase()}/code/file?path=${encodeURIComponent(relPath)}`)
      if (myReq !== reqIdRef.current) return
      if (!res.ok) {
        setFile(null)
        return
      }
      const json = (await res.json()) as FileResponse
      if (myReq !== reqIdRef.current) return
      setFile(json)
    } catch {
      if (myReq === reqIdRef.current) setFile(null)
    } finally {
      if (myReq === reqIdRef.current) setLoading(false)
    }
    // activeProjectId: getApiBase() is project-scoped, so a project switch (with
    // the same relPath) must refetch against the new project.
  }, [relPath, activeProjectId])

  useEffect(() => { fetchFile() }, [fetchFile])

  useEffect(() => {
    if (!activeProjectId) return
    const id = `code-file-${activeProjectId}`
    registerHandler(id, (raw) => {
      const msg = raw as { type?: string; projectId?: string; path?: string; reason?: string }
      if (msg.projectId !== activeProjectIdRef.current) return
      if (msg.type === 'file.summary_updated' && msg.path === relPathRef.current) {
        setRegenerating(false)
        fetchFile()
      } else if (msg.type === 'file.summary_failed' && msg.path === relPathRef.current) {
        toast.error(msg.reason ?? t('summary.generationFailed'))
        setRegenerating(false)
      } else if (msg.type === 'file.summary_skipped' && msg.path === relPathRef.current) {
        if (msg.reason) toast(t('summary.skipped', { reason: msg.reason }))
        setRegenerating(false)
      }
    })
    return () => unregisterHandler(id)
  }, [activeProjectId, registerHandler, unregisterHandler, fetchFile, t])

  const handleRegenerate = useCallback(async (overrideBudget: boolean) => {
    setRegenerating(true)
    try {
      const res = await fetch(
        `${getApiBase()}/code/file/regenerate-summary?path=${encodeURIComponent(relPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ overrideBudget }),
        },
      )
      const json = await res.json().catch(() => ({})) as { skipped?: string }
      if (!res.ok) {
        setRegenerating(false)
        const skipped = typeof json.skipped === 'string' ? json.skipped : null
        toast.error(skipped ? t('summary.skipped', { reason: skipped }) : t('summary.generationFailed'))
        return
      }
      if (json.skipped === 'budget') {
        setRegenerating(false)
        setBudgetPromptOpen(true)
        return
      }
      // ttl / not-found / per-job-cap come back as 200 with a `skipped` reason —
      // tell the user it was dropped instead of silently clearing the spinner.
      if (json.skipped) {
        setRegenerating(false)
        toast(t('summary.skipped', { reason: json.skipped }))
        return
      }
      await fetchFile()
      setRegenerating(false)
    } catch {
      setRegenerating(false)
      toast.error(t('summary.generationFailed'))
    }
  }, [fetchFile, relPath, t])

  const copyAbsolutePath = useCallback(async () => {
    const abs = file?.absolutePath ?? relPath
    try {
      // writeText rejects ASYNC (insecure origin, unfocused doc, Tauri webview);
      // await so a failure doesn't leak an unhandled rejection AND so the success
      // toast only fires when the clipboard actually received the path.
      await navigator.clipboard?.writeText(abs)
      toast.success(t('viewer.pathCopied'))
    } catch {
      toast.error(t('viewer.copyPathFailed'))
    }
  }, [file, relPath, t])

  // Hook order must be stable across renders — declare BEFORE any early return.
  const markdown = useMemo(() => isMarkdown(relPath, file?.language), [relPath, file?.language])
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'raw'>('preview')

  // In-app editing (v1): toggle an editable Monaco over the current text file.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const editable = file?.content !== undefined && !file.binary && !file.tooLarge && file.reason !== 'not-found'

  const startEditing = useCallback(() => {
    setDraft(file?.content ?? '')
    setMarkdownMode('raw') // edit the source, not the rendered preview
    setEditing(true)
  }, [file])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch(`${getApiBase()}/code/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: relPath, content: draft }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? t('viewer.saveFailed'))
        return
      }
      toast.success(t('viewer.saved'))
      setEditing(false)
      fetchFile() // refresh content + summaryStale
    } catch {
      toast.error(t('viewer.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [relPath, draft, t, fetchFile])

  const summary = file?.summary ?? null
  const stale = !!file?.summaryStale
  const provenance = file?.provenance ?? []
  const missing = file?.reason === 'not-found'
  const summaryDisabledReason = missing
    ? t('summary.reason.missing')
    : file?.binary
      ? t('summary.reason.binary')
      : file?.tooLarge
        ? t('summary.reason.tooLarge')
        : null

  useEffect(() => {
    if (!onSummaryActionChange) return
    if (loading && !file) {
      onSummaryActionChange(null)
      return
    }
    onSummaryActionChange({
      hasSummary: !!summary,
      regenerating,
      disabledReason: summaryDisabledReason,
      onClick: () => handleRegenerate(false),
    })
    return () => onSummaryActionChange(null)
  }, [file, handleRegenerate, loading, onSummaryActionChange, regenerating, summary, summaryDisabledReason])

  useEffect(() => {
    if (!onCopyPathActionChange) return
    if (loading && !file) {
      onCopyPathActionChange(null)
      return
    }
    onCopyPathActionChange({ onClick: copyAbsolutePath })
    return () => onCopyPathActionChange(null)
  }, [copyAbsolutePath, file, loading, onCopyPathActionChange])

  if (loading && !file) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground animate-pulse">
        {t('viewer.loadingFile')}
      </div>
    )
  }

  return (
    <div ref={viewerRef} className="flex flex-col h-full" data-testid="file-viewer">
      {summaryCollapsed ? (
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface px-4" data-testid="summary-header-collapsed">
          <span className="truncate text-xs text-muted-foreground">{relPath}</span>
          <button
            type="button"
            onClick={toggleSummaryCollapsed}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {t('viewer.showSummary')}
          </button>
        </div>
      ) : (
        <SummaryHeader
          path={relPath}
          summary={summary}
          stale={stale}
          regenerating={regenerating}
          generateDisabledReason={summaryDisabledReason}
          onCollapse={toggleSummaryCollapsed}
        />
      )}
      <div className="px-4 py-1 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {markdown && file?.content !== undefined && !file.binary && !file.tooLarge && (
            <div className="flex items-center gap-1 text-[11px]" role="group" aria-label={t('viewer.markdownViewMode')}>
              <button
                type="button"
                onClick={() => setMarkdownMode('preview')}
                aria-pressed={markdownMode === 'preview'}
                className={
                  markdownMode === 'preview'
                    ? 'px-2 py-1 rounded-md bg-accent-primary/20 text-accent-primary'
                    : 'px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }
              >
                {t('viewer.preview')}
              </button>
              <button
                type="button"
                onClick={() => setMarkdownMode('raw')}
                aria-pressed={markdownMode === 'raw'}
                className={
                  markdownMode === 'raw'
                    ? 'px-2 py-1 rounded-md bg-accent-primary/20 text-accent-primary'
                    : 'px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }
              >
                {t('viewer.raw')}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] shrink-0">
          {editable && !editing && (
            <button
              type="button"
              onClick={startEditing}
              className="px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              {t('viewer.edit')}
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
              >
                {t('actions.cancel', { ns: 'common' })}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-2 py-1 rounded-md bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30 disabled:opacity-50"
              >
                {saving ? t('viewer.saving') : t('viewer.save')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {missing ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground" data-testid="file-missing">
            {t('viewer.missingFile')}
          </div>
        ) : file?.binary ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground" data-testid="file-binary">
            {t('viewer.binaryFile')}
          </div>
        ) : file?.tooLarge ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground" data-testid="file-too-large">
            {t('viewer.tooLarge', { size: Math.round((file.sizeBytes ?? 0) / 1024 / 1024) })}
          </div>
        ) : file?.content !== undefined ? (
          editing ? (
            <CodeViewerMonaco
              content={draft}
              language={file.language ?? 'plaintext'}
              readOnly={false}
              onChange={setDraft}
            />
          ) : markdown && markdownMode === 'preview' ? (
            <div
              className="h-full overflow-auto px-6 py-4 prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-pre:bg-muted/40 prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none"
              data-testid="markdown-preview"
            >
              <MarkdownPreview content={file.content} />
            </div>
          ) : (
            <CodeViewerMonaco content={file.content} language={file.language ?? 'plaintext'} />
          )
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            {t('viewer.noContent')}
          </div>
        )}
      </div>
      {provenance.length > 0 && (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('history.resize')}
            onPointerDown={historyCollapsed ? undefined : beginHistoryResize}
            onDoubleClick={historyCollapsed ? undefined : resetHistoryHeight}
            className={
              historyCollapsed
                ? 'flex h-8 shrink-0 items-center justify-between border-t border-border bg-card/35 px-4'
                : 'flex h-8 shrink-0 cursor-row-resize items-center justify-between border-y border-border/40 bg-card/35 px-4 hover:bg-accent-primary/10'
            }
            title={historyCollapsed ? undefined : t('resizer.hint')}
            data-testid="code-history-resizer"
          >
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {historyMode === 'story'
                ? t('story.title', { count: provenance.length })
                : t('history.title', { count: provenance.length })}
            </span>
            <span className="flex items-center gap-1">
              {!historyCollapsed && (
                <span
                  className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
                  role="group"
                  aria-label={t('story.viewMode')}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => changeHistoryMode('story')}
                    aria-pressed={historyMode === 'story'}
                    className={historyMode === 'story'
                      ? 'rounded px-2 py-0.5 text-[10px] bg-accent-primary/20 text-accent-primary'
                      : 'rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground'}
                  >
                    {t('story.modeStory')}
                  </button>
                  <button
                    type="button"
                    onClick={() => changeHistoryMode('log')}
                    aria-pressed={historyMode === 'log'}
                    className={historyMode === 'log'
                      ? 'rounded px-2 py-0.5 text-[10px] bg-accent-primary/20 text-accent-primary'
                      : 'rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground'}
                  >
                    {t('story.modeLog')}
                  </button>
                </span>
              )}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={toggleHistoryCollapsed}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                {historyCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {historyCollapsed ? t('history.show') : t('history.hide')}
              </button>
            </span>
          </div>
          {!historyCollapsed && (
            historyMode === 'story' ? (
              <ConstructionStory
                relPath={relPath}
                height={historyHeight}
                onOpenTicket={openTicketDetail}
                onFilterJob={onFilterJob}
              />
            ) : (
              <ProvenanceTimeline
                rows={provenance}
                onOpenTicket={openTicketDetail}
                onFilterJob={onFilterJob}
                height={historyHeight}
              />
            )
          )}
        </>
      )}

      {budgetPromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          data-testid="budget-prompt"
          onClick={budgetModal.guardBackdrop(() => setBudgetPromptOpen(false))}
        >
          <div
            ref={budgetModal.panelRef}
            onClick={(e) => e.stopPropagation()}
            className="bg-card border border-border rounded-lg p-4 w-80 flex flex-col gap-3"
            style={budgetModal.panelStyle}
          >
            <p className="text-sm text-foreground">{t('viewer.budgetPrompt')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBudgetPromptOpen(false)}
                className="text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => { setBudgetPromptOpen(false); handleRegenerate(true) }}
                className="text-xs px-3 py-1.5 rounded-md bg-accent-primary text-white"
              >
                {t('common:actions.confirm')}
              </button>
            </div>
          </div>
          <ResizeGrips handles={budgetModal.resizeHandles} />
        </div>
      )}
    </div>
  )
}

function ProvenanceTimeline({
  rows,
  onOpenTicket,
  onFilterJob,
  height,
}: {
  rows: ProvenanceRow[]
  onOpenTicket: (ticketId: number) => void
  onFilterJob?: (jobId: string) => void
  height: number
}) {
  const { t } = useTranslation('code')
  const [openDiffKey, setOpenDiffKey] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, { patch: string; truncated: boolean } | 'missing' | 'loading'>>({})
  if (rows.length === 0) return null

  async function toggleDiff(row: ProvenanceRow, key: string) {
    if (openDiffKey === key) {
      setOpenDiffKey(null)
      return
    }
    setOpenDiffKey(key)
    if (!row.jobId || diffs[key]) return
    setDiffs((prev) => ({ ...prev, [key]: 'loading' }))
    try {
      const params = new URLSearchParams({ jobId: row.jobId, path: row.path })
      const res = await fetch(`${getApiBase()}/code/diff?${params.toString()}`)
      if (res.status === 404) {
        setDiffs((prev) => ({ ...prev, [key]: 'missing' }))
        return
      }
      if (!res.ok) throw new Error('diff failed')
      const json = await res.json() as { patch?: string; truncated?: boolean }
      setDiffs((prev) => ({ ...prev, [key]: { patch: json.patch ?? '', truncated: json.truncated === true } }))
    } catch {
      setDiffs((prev) => ({ ...prev, [key]: 'missing' }))
    }
  }

  return (
    <div
      className="shrink-0 border-t border-border bg-card/40 px-4 py-3 overflow-hidden"
      style={{ height }}
      data-testid="file-provenance-timeline"
    >
      <div className="h-full overflow-auto space-y-1">
        {rows.map((row, index) => {
          const Icon = row.kind === 'created' ? FilePlus2 : row.kind === 'deleted' ? FileMinus2 : FileText
          const job = row.jobId ? (row.jobId.length > 12 ? row.jobId.slice(0, 12) : row.jobId) : t('history.unknownJob')
          const diffKey = `${row.jobId ?? 'job'}:${row.path}:${row.at}:${index}`
          const diffState = diffs[diffKey]
          return (
            <div key={diffKey} className="rounded-md hover:bg-muted/40">
              <div className="grid grid-cols-[minmax(72px,auto)_minmax(0,1fr)_auto] items-center gap-2 text-xs px-2 py-1.5">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="capitalize">{t(`kind.${row.kind}`)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 min-w-0 text-muted-foreground">
                  <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
                  {row.jobId && onFilterJob ? (
                    <button
                      type="button"
                      onClick={() => onFilterJob(row.jobId!)}
                      className="font-mono truncate hover:text-foreground"
                      title={t('history.filterByJob', { jobId: row.jobId })}
                    >
                      {job}
                    </button>
                  ) : (
                    <span className="font-mono truncate" title={row.jobId ?? undefined}>{job}</span>
                  )}
                  {row.jobId && (
                    <button
                      type="button"
                      onClick={() => toggleDiff(row, diffKey)}
                      className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {t('history.diff')}
                    </button>
                  )}
                  {typeof row.ticketId === 'number' && (
                    <button
                      type="button"
                      onClick={() => onOpenTicket(row.ticketId!)}
                      className="shrink-0 rounded bg-accent-primary/15 px-1.5 py-0.5 text-[10px] text-accent-primary hover:bg-accent-primary/25"
                      title={t('history.openSpec', { ticketId: row.ticketId })}
                    >
                      {t('history.specChip', { ticketId: row.ticketId })}
                    </button>
                  )}
                </span>
                <time className="text-[11px] text-muted-foreground" dateTime={new Date(row.at).toISOString()}>
                  {new Date(row.at).toLocaleString()}
                </time>
              </div>
              {openDiffKey === diffKey && (
                <div className="px-2 pb-2">
                  {diffState === 'loading' ? (
                    <div className="rounded-md bg-muted/35 px-2 py-2 text-[11px] text-muted-foreground">{t('history.loadingDiff')}</div>
                  ) : diffState === 'missing' || !diffState ? (
                    <div className="rounded-md bg-muted/35 px-2 py-2 text-[11px] text-muted-foreground">
                      {t('history.diffUnavailable')}
                    </div>
                  ) : (
                    <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 px-2 py-2 font-mono text-[11px] leading-relaxed text-foreground/85">
                      {diffState.patch}
                      {diffState.truncated ? `\n${t('history.diffTruncated')}` : ''}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default FileViewer
