import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../../lib/utils'
import { useRowVirtualizer } from '../../../hooks/useRowVirtualizer'
import {
  anchorAnnotations, buildSplitRows, buildUnifiedRows, flattenDiff, isSelected,
  type ChangeAnnotation, type DiffLine, type DiffMode, type DiffRow, type FileDiff, type LineSelection,
} from '../../../lib/changes-model'
import { AnnotationCard } from './AnnotationCard'

const LINE_HEIGHT = 20
const HUNK_HEIGHT = 24
const ANNOTATION_HEIGHT = 84

const LINE_TONE: Record<DiffLine['type'], string> = {
  add: 'bg-accent-success/10',
  delete: 'bg-destructive/10',
  context: '',
}
const MARKER: Record<DiffLine['type'], string> = { add: '+', delete: '−', context: ' ' }

function Gutter({ no, side, selected, onSelect, label }: {
  no: number | null
  side: 'new' | 'old'
  selected: boolean
  onSelect: (side: 'new' | 'old', no: number, extend: boolean) => void
  label: string
}) {
  if (no === null) return <span aria-hidden className="w-12 shrink-0" />
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={(event) => onSelect(side, no, event.shiftKey)}
      className={cn(
        'w-12 shrink-0 select-none px-1 text-right text-caption tabular-nums text-muted-foreground outline-none',
        'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-primary/20 text-foreground',
      )}
    >
      {no}
    </button>
  )
}

function Code({ line, selected }: { line: DiffLine; selected: boolean }) {
  return (
    <span className={cn('flex-1 whitespace-pre px-2 font-mono text-caption leading-5', selected && 'bg-primary/10')}>
      <span aria-hidden className="mr-2 select-none text-muted-foreground">{MARKER[line.type]}</span>
      {line.text}
      {line.noNewline ? <span aria-hidden className="ml-2 select-none text-muted-foreground">⏎̸</span> : null}
    </span>
  )
}

/**
 * The selected file's diff, virtualised: a 50,000-line file mounts only the
 * rows in view. Line numbers are buttons (shift-click extends); annotations sit
 * under their line and are reachable by keyboard (Tab, or `n` / `p` from the tab).
 */
export function DiffView({
  diff, mode, annotations, selection, onSelect, focusAnnotationId, onAsk, askDisabled,
}: {
  diff: FileDiff
  mode: DiffMode
  annotations: readonly ChangeAnnotation[]
  selection: LineSelection | null
  onSelect: (side: 'new' | 'old', no: number, extend: boolean) => void
  focusAnnotationId: string | null
  onAsk: (annotation: ChangeAnnotation) => void
  askDisabled?: boolean
}) {
  const { t } = useTranslation('packet')
  const parentRef = useRef<HTMLDivElement>(null)
  const flat = useMemo(() => flattenDiff(diff), [diff])
  const anchored = useMemo(() => anchorAnnotations(diff.path, flat, annotations), [diff.path, flat, annotations])
  const rows = useMemo<DiffRow[]>(
    () => (mode === 'split' ? buildSplitRows(diff, anchored) : buildUnifiedRows(diff, anchored)),
    [diff, anchored, mode],
  )
  const virtualizer = useRowVirtualizer({
    count: rows.length,
    parentRef,
    estimateSize: (index) => (rows[index]?.kind === 'annotations' ? ANNOTATION_HEIGHT : rows[index]?.kind === 'hunk' ? HUNK_HEIGHT : LINE_HEIGHT),
    overscan: 20,
    measure: true,
  })

  // `n` / `p`: bring the row into the window, then move focus onto the card.
  useEffect(() => {
    if (!focusAnnotationId) return
    const index = rows.findIndex((row) => row.kind === 'annotations' && row.annotations.some((a) => a.id === focusAnnotationId))
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    const frame = requestAnimationFrame(() => {
      const el = parentRef.current?.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(focusAnnotationId)}"]`)
      el?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
    // The virtualiser instance is stable; rows change with the file/layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAnnotationId, rows])

  const renderRow = (row: DiffRow) => {
    if (row.kind === 'hunk') {
      return <div className="flex h-6 items-center bg-muted/30 px-3 font-mono text-caption text-muted-foreground">{row.header}</div>
    }
    if (row.kind === 'annotations') {
      return (
        <div>
          {row.annotations.map((annotation) => (
            <AnnotationCard key={annotation.id} annotation={annotation} indented active={annotation.id === focusAnnotationId} onAsk={onAsk} askDisabled={askDisabled} />
          ))}
        </div>
      )
    }
    if (row.kind === 'line') {
      const { line } = row
      const oldSel = isSelected(selection, 'old', line.oldNo)
      const newSel = isSelected(selection, 'new', line.newNo)
      return (
        <div className={cn('flex h-5 items-stretch', LINE_TONE[line.type])}>
          <Gutter no={line.oldNo} side="old" selected={oldSel} onSelect={onSelect} label={t('changes.line.selectOld', { n: line.oldNo ?? 0 })} />
          <Gutter no={line.newNo} side="new" selected={newSel} onSelect={onSelect} label={t('changes.line.select', { n: line.newNo ?? 0 })} />
          <Code line={line} selected={oldSel || newSel} />
        </div>
      )
    }
    const half = (side: 'old' | 'new', cell: { index: number; line: DiffLine } | null) => {
      if (!cell) return <div className="flex h-5 min-w-0 items-stretch bg-muted/10" aria-hidden />
      const no = side === 'old' ? cell.line.oldNo : cell.line.newNo
      const selected = isSelected(selection, side, no)
      const tone = cell.line.type === 'context' ? '' : side === 'old' ? 'bg-destructive/10' : 'bg-accent-success/10'
      return (
        <div className={cn('flex h-5 min-w-0 items-stretch overflow-hidden', tone)}>
          <Gutter no={no} side={side} selected={selected} onSelect={onSelect} label={t(side === 'old' ? 'changes.line.selectOld' : 'changes.line.select', { n: no ?? 0 })} />
          <Code line={cell.line} selected={selected} />
        </div>
      )
    }
    return (
      <div className="grid h-5 grid-cols-2 divide-x divide-border/40">
        {half('old', row.left)}
        {half('new', row.right)}
      </div>
    )
  }

  if (diff.hunks.length === 0) return null

  return (
    <div
      ref={parentRef}
      role="region"
      aria-label={t('changes.diff.region', { path: diff.path })}
      data-testid="changes-diff"
      className="relative h-[70vh] min-h-64 overflow-auto rounded-card border border-border/60 bg-background-deep/40"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: '100%', width: mode === 'split' ? '100%' : 'max-content' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={row.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, minWidth: '100%', width: mode === 'split' ? '100%' : 'max-content', transform: `translateY(${item.start}px)` }}
            >
              {renderRow(row)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
