/**
 * The review packet's Changes tab (feature-gap CD3): what the delivery changed,
 * with the reviewer's findings pinned to the lines they are about.
 *
 *  · file tree (status, +/−, viewed) and one virtualised diff, loaded per file;
 *  · reviewer findings / brief risks / follow-up comments as annotations, with
 *    the ones that name no place listed above the tree rather than dropped;
 *  · select lines (or an annotation) → "Ask agent to change this" files a spec
 *    addendum, the carrier that already briefs the next run;
 *  · open the file in the editor chosen in Settings ▸ Code;
 *  · agent-directed only: there are no person-to-person threads here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Columns2, ExternalLink, FileCheck2, RefreshCw, Rows2, X } from 'lucide-react'
import { getApiBase } from '../../../../lib/api'
import { openAppSettings } from '../../../../lib/app-settings-events'
import { cn } from '../../../../lib/utils'
import { Kbd } from '../../../../components/ui/kbd'
import { RailTrack } from '../../../../components/brand/RailTrack'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select'
import { useDesktop } from '../../../../hooks/useDesktop'
import { joinProjectPath, openInEditor, useEditorPref } from '../../../../lib/open-in-editor'
import { useTicketDetailModal } from '../../../specs/context/TicketDetailModalContext'
import {
  ancestorDirs, anchorAnnotations, annotationOrder, buildAskAgentAddendum, buildTreeRows, extendSelection, flattenDiff, formatLineRange,
  orderedFiles, partitionAnnotations, selectionSnippet, stepIndex,
  type ChangeAnnotation, type ChangedFile, type ChangesPayload, type DiffMode, type FileDiff, type LineSelection,
} from '../../lib/changes-model'
import { countViewed, readDiffMode, readViewed, toggleViewed, writeDiffMode, type ViewedMap } from '../../lib/viewed-files'
import { AnnotationCard } from './changes/AnnotationCard'
import { AskAgentForm, type AskTicketOption } from './changes/AskAgentForm'
import { ChangesFileTree } from './changes/ChangesFileTree'
import { DiffView } from './changes/DiffView'

import { notifyError } from '../../../../lib/notify-error'
type Loadable<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T }

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

// Lamp Rule: colour is for state that needs attention. Only added (success) and deleted (destructive) carry a hue.
const STATUS_TONE: Record<ChangedFile['status'], string> = {
  added: 'text-accent-success', modified: 'text-muted-foreground', deleted: 'text-destructive',
  renamed: 'text-muted-foreground', copied: 'text-muted-foreground', typechange: 'text-muted-foreground',
}

const isOpenspecPath = (path: string): boolean => path === 'openspec' || path.startsWith('openspec/')

/** The tree rows that stand for the top-level `openspec/` folder (a single-child chain is merged into one row, so its path may be deeper). */
function openspecDirs(files: readonly ChangedFile[]): string[] {
  return buildTreeRows(files, new Set())
    .filter((row) => row.kind === 'dir' && row.depth === 0 && (row.name === 'openspec' || row.name.startsWith('openspec/')))
    .map((row) => row.path)
}

/**
 * The file the tab opens on: the first one the reviewer left a note on, else the first outside
 * `openspec/` (the change's own spec docs are context, not what is being reviewed), else the first.
 */
function firstUsefulFile(order: readonly ChangedFile[], annotated: ReadonlyMap<string, readonly ChangeAnnotation[]>): string | null {
  return (order.find((f) => (annotated.get(f.path)?.length ?? 0) > 0)
    ?? order.find((f) => !isOpenspecPath(f.path))
    ?? order[0])?.path ?? null
}

export function ChangesTab({ prDeliveryId, repositoryId, tickets, active }: {
  prDeliveryId: string
  repositoryId: string | null
  tickets: readonly AskTicketOption[]
  /** The tab is visible: keys are live and the first load happens. */
  active: boolean
}) {
  const { t } = useTranslation(['packet', 'common', 'settings'])
  const { activeProjectId } = useDesktop()
  const { openTicketDetail } = useTicketDetailModal()
  const editor = useEditorPref()

  const [requestedSource, setRequestedSource] = useState<string | null>(null)
  const scopeKey = JSON.stringify([activeProjectId, prDeliveryId, repositoryId, requestedSource])
  const [listState, setListState] = useState<{ key: string; value: Loadable<ChangesPayload> } | null>(null)
  const [diffs, setDiffs] = useState<Record<string, Loadable<FileDiff>>>({})
  const [fullPaths, setFullPaths] = useState<ReadonlySet<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [mode, setMode] = useState<DiffMode>(readDiffMode)
  const [viewed, setViewed] = useState<ViewedMap>({})
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [ask, setAsk] = useState<{ note: string; annotationId: string | null } | null>(null)
  const [asking, setAsking] = useState(false)
  const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null)
  const requestRef = useRef(0)

  const projectKey = activeProjectId ?? ''
  useEffect(() => { setViewed(readViewed(projectKey, prDeliveryId)) }, [projectKey, prDeliveryId])

  const query = useCallback((extra: Record<string, string>) => {
    const params = new URLSearchParams(extra)
    if (repositoryId) params.set('repositoryId', repositoryId)
    if (requestedSource) params.set('source', requestedSource)
    const text = params.toString()
    return text ? `?${text}` : ''
  }, [repositoryId, requestedSource])

  const loadList = useCallback(async () => {
    if (!activeProjectId) return
    const revision = ++requestRef.current
    setListState((prev) => ({ key: scopeKey, value: prev?.key === scopeKey && prev.value.status === 'ready' ? prev.value : { status: 'loading' } }))
    try {
      const res = await fetch(`${getApiBase()}/rails/pr-deliveries/${encodeURIComponent(prDeliveryId)}/changes${query({})}`)
      if (requestRef.current !== revision) return
      if (!res.ok) { setListState({ key: scopeKey, value: { status: 'error' } }); return }
      const body = await res.json() as { changes: ChangesPayload }
      if (requestRef.current !== revision) return
      setDiffs({})
      setFullPaths(new Set())
      setListState({ key: scopeKey, value: { status: 'ready', data: body.changes } })
    } catch {
      if (requestRef.current === revision) setListState({ key: scopeKey, value: { status: 'error' } })
    }
  }, [activeProjectId, prDeliveryId, query, scopeKey])

  const everActive = useRef(false)
  if (active) everActive.current = true
  useEffect(() => {
    if (!everActive.current) return
    void loadList()
    return () => { requestRef.current++ }
  }, [loadList, active])

  const current = listState?.key === scopeKey ? listState.value : null
  const data = current?.status === 'ready' ? current.data : null
  const available = data?.available ? data : null
  const files = useMemo(() => available?.files ?? [], [available])
  const order = useMemo(() => orderedFiles(files), [files])
  const annotations = data?.annotations ?? []
  const { forFile, unanchored } = useMemo(() => partitionAnnotations(files, annotations), [files, annotations])
  const walk = useMemo(() => annotationOrder(files, annotations), [files, annotations])

  // A fresh list selects the first file worth reading (see firstUsefulFile); a still-valid selection survives a refresh.
  useEffect(() => {
    if (!available) return
    if (selectedPath && files.some((f) => f.path === selectedPath)) return
    const first = firstUsefulFile(order, forFile)
    setSelectedPath(first)
    setSelection(null)
    // The archived change docs (openspec/) start folded when there is real code to look at, unless that is what opens.
    const hasOthers = order.some((f) => !isOpenspecPath(f.path))
    const keepOpen = first ? ancestorDirs(first) : []
    setCollapsed(new Set(hasOthers ? openspecDirs(files).filter((dir) => !keepOpen.includes(dir)) : []))
  }, [available, files, order, selectedPath, forFile])

  const file = files.find((f) => f.path === selectedPath) ?? null
  const full = !!file && fullPaths.has(file.path)
  const diffKey = file ? `${scopeKey}|${file.path}|${full ? 'full' : 'cap'}|${file.hash}` : null
  const diffState = diffKey ? diffs[diffKey] : undefined

  useEffect(() => {
    if (!file || !diffKey || !active || file.binary || diffs[diffKey]) return
    const key = diffKey
    const revision = requestRef.current
    setDiffs((prev) => ({ ...prev, [key]: { status: 'loading' } }))
    void (async () => {
      try {
        const res = await fetch(`${getApiBase()}/rails/pr-deliveries/${encodeURIComponent(prDeliveryId)}/changes/file${query({ path: file.path, ...(full ? { full: '1' } : {}) })}`)
        if (requestRef.current !== revision) return
        if (!res.ok) { setDiffs((prev) => ({ ...prev, [key]: { status: 'error' } })); return }
        const body = await res.json() as { diff: FileDiff }
        setDiffs((prev) => ({ ...prev, [key]: { status: 'ready', data: body.diff } }))
      } catch {
        if (requestRef.current === revision) setDiffs((prev) => ({ ...prev, [key]: { status: 'error' } }))
      }
    })()
  }, [file, diffKey, active, diffs, full, prDeliveryId, query])

  const diff = diffState?.status === 'ready' ? diffState.data : file?.binary ? { path: file.path, oldPath: file.oldPath, status: file.status, binary: true, hunks: [], truncated: false, totalLines: 0 } satisfies FileDiff : null
  const flat = useMemo(() => (diff ? flattenDiff(diff) : null), [diff])
  const fileAnnotations = useMemo(() => (file ? forFile.get(file.path) ?? [] : []), [file, forFile])
  const fileLevel = useMemo(() => (file ? anchorAnnotations(file.path, flat, fileAnnotations).fileLevel : []), [file, flat, fileAnnotations])

  const selectFile = useCallback((path: string) => {
    setSelectedPath(path)
    setSelection(null)
    setAsk(null)
    setCollapsed((prev) => {
      const hidden = ancestorDirs(path).filter((dir) => prev.has(dir))
      if (hidden.length === 0) return prev
      const next = new Set(prev)
      for (const dir of hidden) next.delete(dir)
      return next
    })
  }, [])

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next })
  }, [])

  const onToggleViewed = useCallback((target: ChangedFile) => {
    setViewed((prev) => toggleViewed(projectKey, prDeliveryId, prev, target))
  }, [projectKey, prDeliveryId])

  const changeMode = (next: DiffMode) => { setMode(next); writeDiffMode(next) }

  // ── Keyboard: j/k files, n/p annotations, v viewed (never while typing) ──
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return
      const key = event.key
      if (key === 'j' || key === 'k') {
        const index = stepIndex(order.findIndex((f) => f.path === selectedPath), key === 'j' ? 1 : -1, order.length)
        if (index >= 0) { event.preventDefault(); selectFile(order[index].path); setFocusAnnotationId(null) }
      } else if (key === 'n' || key === 'p') {
        const index = stepIndex(walk.findIndex((a) => a.id === focusAnnotationId), key === 'n' ? 1 : -1, walk.length)
        if (index >= 0) {
          event.preventDefault()
          const target = walk[index]
          if (target.location && target.location.path !== selectedPath) selectFile(target.location.path)
          setFocusAnnotationId(target.id)
        }
      } else if (key === 'v' && file) {
        event.preventDefault()
        onToggleViewed(file)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, order, selectedPath, walk, focusAnnotationId, file, selectFile, onToggleViewed])

  // ── Ask the agent ──────────────────────────────────────────────────────────
  const askForAnnotation = (annotation: ChangeAnnotation) => {
    const at = annotation.location
    if (at && at.path !== selectedPath && files.some((f) => f.path === at.path)) selectFile(at.path)
    setSelection(at && at.line !== null ? { side: 'new', from: at.line, to: at.endLine ?? at.line } : null)
    setAsk({ note: annotation.text, annotationId: annotation.id })
  }

  const submitAsk = async (ticketId: number, note: string) => {
    const annotation = ask?.annotationId ? annotations.find((a) => a.id === ask.annotationId) : null
    const path = annotation ? annotation.location?.path ?? null : file?.path ?? null
    const pathFile = path ? files.find((f) => f.path === path) : null
    const useFlat = pathFile && pathFile.path === file?.path ? flat : null
    const body = buildAskAgentAddendum({
      path, selection, note,
      snippet: selection && useFlat ? selectionSnippet(useFlat, selection) : '',
    })
    setAsking(true)
    try {
      const res = await fetch(`${getApiBase()}/tickets/${ticketId}/addenda`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) { notifyError(t('packet:changes.ask.failed')); return }
      toast.success(t('packet:changes.ask.created', { id: ticketId }), {
        action: { label: t('packet:changes.ask.open'), onClick: () => openTicketDetail(ticketId) },
      })
      setAsk(null)
      setSelection(null)
    } catch {
      notifyError(t('packet:changes.ask.failed'))
    } finally {
      setAsking(false)
    }
  }

  const openEditor = async (line: number | null) => {
    if (!available || !file || file.status === 'deleted') return
    const editorName = t(`packet:changes.editor.names.${editor}`)
    const opened = await openInEditor(editor, joinProjectPath(available.root, file.path), line).catch(() => false)
    if (opened) return
    // Never fail silently: say which editor, and where to change it.
    notifyError(t('packet:changes.editor.failed', { editor: editorName }), {
      action: { label: t('settings:openSettings'), onClick: () => openAppSettings('code', 'editor') },
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (!current || current.status === 'loading') {
    return (
      <div role="status" className="flex flex-col items-start gap-2 p-6 text-body text-muted-foreground" data-testid="changes-loading">
        <RailTrack running className="w-24" />{t('packet:changes.loading')}
      </div>
    )
  }
  if (current.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 p-6 text-body text-muted-foreground">
        <p>{t('packet:changes.error')}</p>
        <button type="button" onClick={() => void loadList()} className="rounded-control border border-border px-3 py-1 text-foreground hover:bg-surface">{t('common:actions.retry')}</button>
      </div>
    )
  }
  if (!available) {
    return (
      <div className="flex flex-col gap-3 p-6" data-testid="changes-unavailable">
        <p className="text-body text-muted-foreground">{t(`packet:changes.unavailable.${data && !data.available ? data.reason : 'git_failed'}`, { defaultValue: t('packet:changes.unavailable.git_failed') })}</p>
        {unanchored.length > 0 ? <UnanchoredList annotations={unanchored} onAsk={askForAnnotation} /> : null}
      </div>
    )
  }

  const viewedCount = countViewed(viewed, files)
  const diffEntry = diff
  const rootNote = available.rootKind === 'repository' ? t('packet:changes.editor.rootRepository') : undefined
  // The path is in the header right above; the bar only names the lines.
  const selectionLabel = selection && file ? `:${formatLineRange(selection)}` : null

  return (
    <section aria-label={t('packet:changes.tab')} className="flex flex-col gap-3" data-testid="changes-tab">
      {/* Summary + controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body">
        <span className="text-strong text-foreground">{t('packet:changes.summary', { count: available.totals.files })}</span>
        <span className="tabular-nums">
          <span className="text-accent-success">+{available.totals.additions}</span>{' '}
          <span className="text-destructive">−{available.totals.deletions}</span>
        </span>
        <span className="text-muted-foreground" data-testid="changes-viewed-count">{t('packet:changes.viewedCount', { viewed: viewedCount, total: files.length })}</span>
        <span className="text-caption text-muted-foreground"><code className="font-mono">{available.head}</code> ← <code className="font-mono">{available.base}</code></span>
        <span className="flex-1" />
        {available.sources.length > 1 ? (
          <div className="flex items-center gap-2 text-caption">
            <span id="changes-source-label" className="text-muted-foreground">{t('packet:changes.source')}</span>
            <Select value={available.source} onValueChange={(value) => { setRequestedSource(value); setSelectedPath(null) }}>
              <SelectTrigger aria-labelledby="changes-source-label" className="h-7 w-auto min-w-[8rem] text-caption"><SelectValue /></SelectTrigger>
              <SelectContent>
                {available.sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.ticketId === null ? t('packet:changes.sourceDelivery') : t('packet:changes.sourceTicket', { id: source.ticketId })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div role="radiogroup" aria-label={t('packet:changes.mode.label')} className="inline-flex overflow-hidden rounded-control border border-border">
          {(['unified', 'split'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => changeMode(value)}
              className={cn('flex items-center gap-1 px-2 py-1 text-caption', mode === value ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-surface')}
            >
              {value === 'unified' ? <Rows2 className="size-3.5" aria-hidden /> : <Columns2 className="size-3.5" aria-hidden />}
              {t(`packet:changes.mode.${value}`)}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void loadList()} aria-label={t('packet:changes.refresh')} title={t('packet:changes.refresh')} className="rounded-control border border-border p-1.5 text-muted-foreground hover:bg-surface hover:text-foreground">
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>

      {available.truncated ? <p className="text-caption text-accent-warning">{t('packet:changes.truncatedList', { count: files.length })}</p> : null}
      {unanchored.length > 0 ? <UnanchoredList annotations={unanchored} onAsk={askForAnnotation} askDisabled={asking} /> : null}

      {files.length === 0 ? (
        <p className="p-4 text-body text-muted-foreground">{t('packet:changes.empty')}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[18rem_minmax(0,1fr)]">
          <ChangesFileTree
            files={files}
            collapsed={collapsed}
            onToggleDir={toggleDir}
            selectedPath={selectedPath}
            onSelectFile={(path) => { selectFile(path); setFocusAnnotationId(null) }}
            viewed={viewed}
            onToggleViewed={onToggleViewed}
          />
          <div className="flex min-w-0 flex-col gap-2">
            {file ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-body text-foreground" title={file.path}>{file.path}</code>
                  <span className={cn('text-caption font-medium', STATUS_TONE[file.status])}>{t(`packet:changes.status.${file.status}`)}</span>
                  {file.oldPath ? <span className="text-caption text-muted-foreground">{t('packet:changes.renamedFrom', { path: file.oldPath })}</span> : null}
                  <button
                    type="button"
                    onClick={() => onToggleViewed(file)}
                    aria-pressed={viewed[file.path] === file.hash}
                    className={cn('inline-flex items-center gap-1 rounded-control border px-2 py-1 text-caption', viewed[file.path] === file.hash ? 'border-accent-success/50 bg-accent-success/10 text-accent-success' : 'border-border text-foreground hover:bg-surface')}
                    data-testid="changes-mark-viewed"
                  >
                    <FileCheck2 className="size-3.5" aria-hidden />
                    {viewed[file.path] === file.hash ? t('packet:changes.viewed.unmark') : file.path in viewed ? t('packet:changes.viewed.changedSince') : t('packet:changes.viewed.mark')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void openEditor(selection?.side === 'new' ? Math.min(selection.from, selection.to) : null) }}
                    disabled={file.status === 'deleted'}
                    title={rootNote}
                    className="inline-flex items-center gap-1 rounded-control border border-border px-2 py-1 text-caption text-foreground hover:bg-surface disabled:opacity-50"
                    data-testid="changes-open-editor"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t('packet:changes.editor.open', { editor: t(`packet:changes.editor.names.${editor}`) })}
                  </button>
                </div>

                {selection && !ask ? (
                  // A zero-height sticky layer: the bar floats over the top of the diff instead of pushing it down when a line is picked.
                  <div className="sticky top-0 z-10 h-0" data-testid="changes-selection-layer">
                    <div className="absolute inset-x-0 top-1 flex flex-wrap items-center gap-2 rounded-card border border-primary/40 bg-popover px-3 py-1.5 text-body shadow-2" data-testid="changes-selection-bar">
                      <code className="font-mono text-caption text-foreground">{selectionLabel}</code>
                      <button type="button" onClick={() => setAsk({ note: '', annotationId: null })} className="rounded-control bg-primary px-2.5 py-1 text-caption font-medium text-primary-foreground hover:bg-primary/90" data-testid="changes-ask-button">
                        {t('packet:changes.ask.button')}
                      </button>
                      <button type="button" onClick={() => setSelection(null)} aria-label={t('packet:changes.selection.clear')} className="rounded-control p-1 text-muted-foreground hover:text-foreground">
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  </div>
                ) : null}
                {ask ? (
                  <AskAgentForm
                    key={ask.annotationId ?? 'selection'}
                    path={ask.annotationId ? annotations.find((a) => a.id === ask.annotationId)?.location?.path ?? null : file.path}
                    selection={selection}
                    tickets={tickets}
                    initialNote={ask.note}
                    busy={asking}
                    onSubmit={(ticketId, note) => void submitAsk(ticketId, note)}
                    onCancel={() => setAsk(null)}
                  />
                ) : null}

                {fileLevel.map((annotation) => (
                  <AnnotationCard key={annotation.id} annotation={annotation} active={annotation.id === focusAnnotationId} onAsk={askForAnnotation} askDisabled={asking} />
                ))}

                {file.binary ? (
                  <p className="rounded-card border border-border/60 p-4 text-body text-muted-foreground" data-testid="changes-binary">{t('packet:changes.binary')}</p>
                ) : !diffState || diffState.status === 'loading' ? (
                  <div role="status" className="flex flex-col items-start gap-2 p-4 text-body text-muted-foreground"><RailTrack running className="w-24" />{t('packet:changes.loading')}</div>
                ) : diffState.status === 'error' ? (
                  <p className="p-4 text-body text-muted-foreground">{t('packet:changes.fileError')}</p>
                ) : diffEntry && diffEntry.hunks.length === 0 ? (
                  <p className="rounded-card border border-border/60 p-4 text-body text-muted-foreground">{t('packet:changes.noTextChanges')}</p>
                ) : diffEntry ? (
                  <>
                    <DiffView
                      diff={diffEntry}
                      mode={mode}
                      annotations={fileAnnotations}
                      selection={selection}
                      onSelect={(side, no, extend) => setSelection((prev) => extendSelection(prev, side, no, extend))}
                      focusAnnotationId={focusAnnotationId}
                      onAsk={askForAnnotation}
                      askDisabled={asking}
                    />
                    {diffEntry.truncated ? (
                      <div className="flex flex-wrap items-center gap-2 text-caption text-accent-warning" data-testid="changes-truncated">
                        {t('packet:changes.largeDiff', { shown: diffEntry.hunks.reduce((n, h) => n + h.lines.length, 0), total: diffEntry.totalLines })}
                        <button type="button" onClick={() => setFullPaths((prev) => new Set(prev).add(file.path))} className="rounded-control border border-border px-2 py-0.5 text-foreground hover:bg-surface">
                          {t('packet:changes.loadFull')}
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground" data-testid="changes-key-hint">
              <span><Kbd>j</Kbd> <Kbd>k</Kbd> {t('packet:changes.keys.files')}</span>
              <span><Kbd>n</Kbd> <Kbd>p</Kbd> {t('packet:changes.keys.annotations')}</span>
              <span><Kbd>v</Kbd> {t('packet:changes.keys.viewed')}</span>
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

/** Notes that name no file of the change: listed, never dropped. */
function UnanchoredList({ annotations, onAsk, askDisabled }: {
  annotations: readonly ChangeAnnotation[]
  onAsk: (annotation: ChangeAnnotation) => void
  askDisabled?: boolean
}) {
  const { t } = useTranslation('packet')
  return (
    <section aria-label={t('changes.annotations.title', { count: annotations.length })} data-testid="changes-unanchored">
      <h3 className="mb-1 text-label text-foreground">{t('changes.annotations.title', { count: annotations.length })}</h3>
      <div className="flex flex-col">
        {annotations.map((annotation) => <AnnotationCard key={annotation.id} annotation={annotation} showLocation onAsk={onAsk} askDisabled={askDisabled} />)}
      </div>
    </section>
  )
}
