import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown, GitCommitHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getApiBase } from '../../lib/api'
import { useProjectCache } from '../../hooks/useProjectCache'
import { useTicketDetailModal } from '../../context/TicketDetailModalContext'
import { useDesktop } from '../../hooks/useDesktop'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'

type FilterMode = 'touched-by-ai' | 'all'

export interface TreeEntry {
  path: string
  kind: 'file' | 'dir'
  sizeBytes?: number
  hasSummary?: boolean
  provenance?: {
    createdByTicketId?: number | null
    modifiedByTicketIds?: number[]
    touchedFileCount?: number
    latest?: {
      path: string
      ticketId: number | null
      jobId: string | null
      kind: 'created' | 'modified' | 'deleted'
      at: number
    } | null
  }
  lastModifiedAt?: string
}

interface FileTreeProps {
  onOpenFile: (relPath: string) => void
  selectedPath: string | null
  filterJobId?: string | null
  filterTicketId?: number | null
}

const FILTER_LS_KEY = (projectId: string) => `specrails-desktop:code-tree-filter:${projectId}`
const COLLAPSED_LS_KEY = (projectId: string) => `specrails-desktop:code-tree-collapsed:${projectId}`

function depthOf(path: string): number {
  return path.split('/').length - 1
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

function shortJobId(jobId: string | null | undefined): string | null {
  if (!jobId) return null
  return jobId.length > 10 ? jobId.slice(0, 10) : jobId
}

function actionLabel(kind: string | null | undefined): string | null {
  if (kind === 'created') return 'added'
  if (kind === 'modified') return 'changed'
  if (kind === 'deleted') return 'deleted'
  return null
}

function ancestorHidden(path: string, collapsed: Set<string>): boolean {
  if (collapsed.size === 0) return false
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    if (collapsed.has(parts.slice(0, i).join('/'))) return true
  }
  return false
}

export function FileTree({ onOpenFile, selectedPath, filterJobId, filterTicketId }: FileTreeProps) {
  const { t } = useTranslation('code')
  const { activeProjectId } = useDesktop()
  const { openTicketDetail } = useTicketDetailModal()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const [filter, setFilter] = useState<FilterMode>(() => {
    if (!activeProjectId) return 'touched-by-ai'
    try {
      const stored = localStorage.getItem(FILTER_LS_KEY(activeProjectId))
      if (stored === 'all' || stored === 'touched-by-ai') return stored
    } catch { /* ignore */ }
    return 'touched-by-ai'
  })

  useEffect(() => {
    if (!activeProjectId) return
    try { localStorage.setItem(FILTER_LS_KEY(activeProjectId), filter) } catch { /* ignore */ }
  }, [filter, activeProjectId])

  // Folder collapse state — set of folder paths that are collapsed.
  // Default: all expanded. Persisted per project so reload restores choices.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!activeProjectId) return new Set()
    try {
      const raw = localStorage.getItem(COLLAPSED_LS_KEY(activeProjectId))
      if (!raw) return new Set()
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'))
    } catch { /* ignore */ }
    return new Set()
  })

  useEffect(() => {
    if (!activeProjectId) return
    try { localStorage.setItem(COLLAPSED_LS_KEY(activeProjectId), JSON.stringify([...collapsed])) } catch { /* ignore */ }
  }, [collapsed, activeProjectId])

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folderPath)) next.delete(folderPath)
      else next.add(folderPath)
      return next
    })
  }, [])

  const expandAll = useCallback(() => { setCollapsed(new Set()) }, [])

  // The job/ticket scope only affects the touched-by-ai query; in 'All files' the
  // server response is identical regardless, so don't fork the cache key on it.
  const scopeKey = filter === 'touched-by-ai'
    ? `${filterJobId ?? 'all-jobs'}:${filterTicketId ?? 'all-specs'}`
    : 'all'
  const namespace = `code-tree:${filter}:${scopeKey}`
  const fetcher = useCallback(async (): Promise<TreeEntry[]> => {
    // Follow server pagination (cursor) to completion — the tree is capped at
    // 2000 entries PER PAGE; without this loop everything after the first page is
    // silently lost on large repos. MAX_PAGES bounds a pathological response.
    const MAX_PAGES = 100
    const all: TreeEntry[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ withProvenance: '1', filter })
      if (filter === 'touched-by-ai' && filterJobId) params.set('jobId', filterJobId)
      if (filter === 'touched-by-ai' && typeof filterTicketId === 'number') params.set('ticketId', String(filterTicketId))
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`${getApiBase()}/code/tree?${params.toString()}`)
      if (!res.ok) break
      const json = await res.json().catch(() => ({})) as { entries?: TreeEntry[]; nextCursor?: string | null }
      if (Array.isArray(json.entries)) all.push(...json.entries)
      if (!json.nextCursor) break
      cursor = json.nextCursor
    }
    return all
  }, [filter, filterJobId, filterTicketId])

  const { data: entries, refresh, isFirstLoad } = useProjectCache<TreeEntry[]>({
    namespace,
    projectId: activeProjectId,
    initialValue: [],
    fetcher,
  })

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  useEffect(() => {
    if (!activeProjectId) return
    const handlerId = `code-tree-${activeProjectId}`
    registerHandler(handlerId, (raw) => {
      const msg = raw as { type?: string; projectId?: string }
      if (msg.projectId !== activeProjectIdRef.current) return
      if (msg.type === 'file.provenance_updated') refresh()
    })
    return () => unregisterHandler(handlerId)
  }, [activeProjectId, registerHandler, unregisterHandler, refresh])

  const parentRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(
    () => (entries ?? []).filter((e) => !ancestorHidden(e.path, collapsed)),
    [entries, collapsed],
  )

  const collapseAll = useCallback(() => {
    setCollapsed(new Set((entries ?? []).filter((e) => e.kind === 'dir').map((e) => e.path)))
  }, [entries])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
    initialRect: { width: 320, height: 600 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement as HTMLElement | null
      if (!el) return () => {}
      const measure = () => {
        const rect = el.getBoundingClientRect()
        const height = rect.height || el.clientHeight || 600
        const width = rect.width || el.clientWidth || 320
        cb({ width, height })
      }
      measure()
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
      }
      return () => {}
    },
  })

  const isEmpty = rows.length === 0
  const touchedFileCount = useMemo(
    () => (entries ?? []).filter((entry) => entry.kind === 'file').length,
    [entries],
  )

  return (
    <div className="flex flex-col h-full" data-testid="file-tree">
      <div className="px-2 py-2 border-b border-border text-xs space-y-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilter('touched-by-ai')}
            className={cn(
              'px-2 py-1 rounded-md transition-colors',
              filter === 'touched-by-ai'
                ? 'bg-accent-primary/20 text-accent-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
            aria-pressed={filter === 'touched-by-ai'}
          >
            {filterJobId ? t('tree.jobFiles') : filterTicketId ? t('tree.specFiles') : t('tree.touchedByAi')}
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'px-2 py-1 rounded-md transition-colors',
              filter === 'all'
                ? 'bg-accent-primary/20 text-accent-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
            aria-pressed={filter === 'all'}
          >
            {t('tree.allFiles')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={collapseAll}
            title={t('tree.collapseAll')}
            className="px-1.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50"
            aria-label={t('tree.collapseAll')}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={expandAll}
            title={t('tree.expandAll')}
            className="px-1.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50"
            aria-label={t('tree.expandAll')}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
        {filter === 'touched-by-ai' && touchedFileCount > 0 && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{t('tree.touchedCount', { count: touchedFileCount })}</span>
          </div>
        )}
      </div>

      {isEmpty && isFirstLoad ? (
        <div className="flex-1 flex items-center justify-center px-4 text-center" data-testid="file-tree-loading">
          <p className="text-xs text-muted-foreground animate-pulse">{t('tree.loadingFiles')}</p>
        </div>
      ) : isEmpty && filter === 'touched-by-ai' ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center gap-3">
          <p className="text-xs text-muted-foreground">
            {t('tree.emptyTouched')}
          </p>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
          >
            {t('tree.showAllFiles')}
          </button>
        </div>
      ) : isEmpty ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
          {t('tree.noFiles')}
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto" data-testid="file-tree-scroller">
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = rows[vi.index]
              const indent = depthOf(entry.path) * 12
              const isSelected = entry.kind === 'file' && entry.path === selectedPath
              const createdBy = entry.provenance?.createdByTicketId
              const modifiedBy = entry.provenance?.modifiedByTicketIds ?? []
              const latest = entry.provenance?.latest ?? null
              const jobLabel = shortJobId(latest?.jobId)
              const latestAction = actionLabel(latest?.kind)
              const isFolder = entry.kind === 'dir'
              const isCollapsed = isFolder && collapsed.has(entry.path)
              const folderTouchedCount = entry.provenance?.touchedFileCount ?? 0
              return (
                <div
                  key={entry.path}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translateY(${vi.start}px)`,
                    height: vi.size,
                    width: '100%',
                  }}
                  className={cn(
                    'flex items-center gap-2 px-2 text-xs cursor-pointer hover:bg-muted/50',
                    isSelected && 'bg-muted text-foreground',
                  )}
                  onClick={() => {
                    if (isFolder) toggleFolder(entry.path)
                    else onOpenFile(entry.path)
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    if (isFolder) toggleFolder(entry.path)
                    else onOpenFile(entry.path)
                  }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isFolder ? !isCollapsed : undefined}
                  data-testid={`file-tree-row-${entry.path}`}
                >
                  <span style={{ paddingLeft: indent }} className="flex items-center gap-1 min-w-0 flex-1">
                    {isFolder ? (
                      <>
                        {isCollapsed
                          ? <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
                        {isCollapsed
                          ? <Folder className="w-3.5 h-3.5 text-accent-info flex-shrink-0" />
                          : <FolderOpen className="w-3.5 h-3.5 text-accent-info flex-shrink-0" />}
                      </>
                    ) : (
                      <>
                        <span className="w-3 flex-shrink-0" />
                        <FileIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      </>
                    )}
                    <span className="truncate ml-0.5">{basename(entry.path)}</span>
                  </span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    {isFolder && folderTouchedCount > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground"
                        title={t('tree.folderTouched', { count: folderTouchedCount })}
                      >
                        {folderTouchedCount}
                      </span>
                    )}
                    {!isFolder && latestAction && (
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded',
                          latest?.kind === 'created' && 'bg-accent-success/15 text-accent-success',
                          latest?.kind === 'modified' && 'bg-accent-info/15 text-accent-info',
                          latest?.kind === 'deleted' && 'bg-destructive/15 text-destructive',
                        )}
                        title={
                          latest?.kind === 'created'
                            ? t('tree.latestTitleCreated')
                            : latest?.kind === 'deleted'
                              ? t('tree.latestTitleDeleted')
                              : t('tree.latestTitleModified')
                        }
                      >
                        {t(`action.${latestAction}`)}
                      </span>
                    )}
                    {!isFolder && jobLabel && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground font-mono"
                        title={t('tree.jobTitle', { jobId: latest?.jobId ?? '' })}
                      >
                        <GitCommitHorizontal className="h-3 w-3" />
                        {jobLabel}
                      </span>
                    )}
                    {!isFolder && typeof createdBy === 'number' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openTicketDetail(createdBy) }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-accent-success/20 text-accent-success"
                        data-testid={`provenance-chip-created-${createdBy}`}
                        title={t('tree.createdBySpec', { id: createdBy })}
                      >
                        #{createdBy}
                      </button>
                    )}
                    {!isFolder && modifiedBy.slice(0, 2).map((tid) => (
                      <button
                        type="button"
                        key={tid}
                        onClick={(e) => { e.stopPropagation(); openTicketDetail(tid) }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-accent-info/15 text-accent-info"
                        data-testid={`provenance-chip-modified-${tid}`}
                        title={t('tree.modifiedBySpec', { id: tid })}
                      >
                        #{tid}
                      </button>
                    ))}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default FileTree
