import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { cn } from '../../../../../lib/utils'
import { useRowVirtualizer } from '../../../hooks/useRowVirtualizer'
import { buildTreeRows, type ChangedFile, type ChangedFileStatus, type TreeRow } from '../../../lib/changes-model'
import { changedSinceViewed, isViewed, type ViewedMap } from '../../../lib/viewed-files'

const ROW_HEIGHT = 28

/** Letter + lamp tone per status; the letter keeps it readable without colour. */
const STATUS_BADGE: Record<ChangedFileStatus, { letter: string; tone: string }> = {
  added: { letter: 'A', tone: 'text-accent-success' },
  modified: { letter: 'M', tone: 'text-accent-info' },
  deleted: { letter: 'D', tone: 'text-destructive' },
  renamed: { letter: 'R', tone: 'text-accent-review' },
  copied: { letter: 'C', tone: 'text-accent-review' },
  typechange: { letter: 'T', tone: 'text-accent-warning' },
}

/**
 * The changed-file tree (ARIA tree, virtualised). One tab stop; arrows move,
 * Left/Right fold directories, Enter or Space opens a file.
 */
export function ChangesFileTree({
  files, collapsed, onToggleDir, selectedPath, onSelectFile, viewed, onToggleViewed,
}: {
  files: readonly ChangedFile[]
  collapsed: ReadonlySet<string>
  onToggleDir: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
  viewed: ViewedMap
  onToggleViewed: (file: ChangedFile) => void
}) {
  const { t } = useTranslation('packet')
  const parentRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => buildTreeRows(files, collapsed), [files, collapsed])
  const virtualizer = useRowVirtualizer({ count: rows.length, parentRef, estimateSize: () => ROW_HEIGHT, overscan: 12, fallbackHeight: 480 })
  const focusRow = (index: number) => {
    const clamped = Math.min(rows.length - 1, Math.max(0, index))
    virtualizer.scrollToIndex(clamped)
    requestAnimationFrame(() => parentRef.current?.querySelector<HTMLElement>(`[data-row-index="${clamped}"]`)?.focus())
  }
  const selectedIndex = rows.findIndex((row) => row.kind === 'file' && row.path === selectedPath)

  const onKeyDown = (event: React.KeyboardEvent, row: TreeRow, index: number) => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(index + 1); break
      case 'ArrowUp': event.preventDefault(); focusRow(index - 1); break
      case 'Home': event.preventDefault(); focusRow(0); break
      case 'End': event.preventDefault(); focusRow(rows.length - 1); break
      case 'ArrowRight':
        if (row.kind === 'dir' && collapsed.has(row.path)) { event.preventDefault(); onToggleDir(row.path) }
        break
      case 'ArrowLeft':
        if (row.kind === 'dir' && !collapsed.has(row.path)) { event.preventDefault(); onToggleDir(row.path) }
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (row.kind === 'dir') onToggleDir(row.path)
        else onSelectFile(row.path)
        break
      default:
    }
  }

  return (
    <div
      ref={parentRef}
      role="tree"
      aria-label={t('changes.tree.label')}
      aria-multiselectable={false}
      data-testid="changes-tree"
      className="h-[70vh] min-h-64 overflow-auto rounded-card border border-border/60 bg-surface/40"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          const isDir = row.kind === 'dir'
          const open = isDir && !collapsed.has(row.path)
          const file = row.file
          const selected = !isDir && row.path === selectedPath
          const isViewedFile = !!file && isViewed(viewed, file)
          const stale = !!file && changedSinceViewed(viewed, file)
          const badge = file ? STATUS_BADGE[file.status] : null
          return (
            <div
              key={row.path + row.kind}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isDir ? undefined : selected}
              aria-expanded={isDir ? open : undefined}
              tabIndex={selected || (selectedIndex < 0 && item.index === 0) ? 0 : -1}
              data-row-index={item.index}
              data-path={row.path}
              onKeyDown={(event) => onKeyDown(event, row, item.index)}
              onClick={() => (isDir ? onToggleDir(row.path) : onSelectFile(row.path))}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${item.start}px)`, paddingLeft: 8 + row.depth * 14 }}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 pr-2 text-body outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                selected && 'bg-primary/15',
              )}
            >
              {isDir ? (
                <>
                  {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
                </>
              ) : (
                <>
                  <span aria-hidden className={cn('w-3.5 shrink-0 text-center text-caption font-medium', badge?.tone)}>{badge?.letter}</span>
                  <span className={cn('min-w-0 flex-1 truncate', isViewedFile ? 'text-muted-foreground' : 'text-foreground')} title={file?.oldPath ? t('changes.renamedFrom', { path: file.oldPath }) : row.path}>
                    <span className="sr-only">{t(`changes.status.${file!.status}`)}: </span>
                    {row.name}
                  </span>
                  {file!.binary ? <span className="text-caption text-muted-foreground">{t('changes.binaryShort')}</span> : (
                    <span className="shrink-0 text-caption tabular-nums">
                      <span className="text-accent-success">+{file!.additions ?? 0}</span>{' '}
                      <span className="text-destructive">−{file!.deletions ?? 0}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-pressed={isViewedFile}
                    aria-label={stale ? t('changes.viewed.changedSince') : isViewedFile ? t('changes.viewed.unmark') : t('changes.viewed.mark')}
                    title={stale ? t('changes.viewed.changedSince') : undefined}
                    onClick={(event) => { event.stopPropagation(); onToggleViewed(file!) }}
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-control border',
                      isViewedFile ? 'border-accent-success/50 bg-accent-success/15 text-accent-success' : stale ? 'border-accent-warning/50 text-accent-warning' : 'border-border text-transparent hover:text-muted-foreground',
                    )}
                  >
                    {stale ? <span aria-hidden className="text-caption">!</span> : <Check className="size-3" aria-hidden />}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
