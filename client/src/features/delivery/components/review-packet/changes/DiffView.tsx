import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** The line number a row offers on a side (null: no gutter there). */
function gutterNumber(row: DiffRow, side: 'old' | 'new'): number | null {
  if (row.kind === 'line') return side === 'old' ? row.line.oldNo : row.line.newNo
  if (row.kind === 'pair') return (side === 'old' ? row.left?.line.oldNo : row.right?.line.newNo) ?? null
  return null
}

const gutterKey = (rowKey: string, side: 'old' | 'new'): string => `${rowKey}:${side}`

function Gutter({ no, side, selected, onSelect, label, id, tabStop }: {
  no: number | null
  side: 'new' | 'old'
  selected: boolean
  onSelect: (side: 'new' | 'old', no: number, extend: boolean) => void
  label: string
  /** Roving-tabindex identity (`<row>:<side>`). */
  id: string
  /** The one gutter that is a Tab stop; the arrows move between the others. */
  tabStop: boolean
}) {
  if (no === null) return <span aria-hidden className="w-12 shrink-0" />
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      tabIndex={tabStop ? 0 : -1}
      data-gutter-key={id}
      data-gutter-side={side}
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
  const { t } = useTranslation('packet')
  return (
    <span className={cn('flex-1 whitespace-pre px-2 font-mono text-caption leading-5', selected && 'bg-primary/10')}>
      <span aria-hidden className="mr-2 select-none text-muted-foreground">{MARKER[line.type]}</span>
      {/* The +/− glyph is decoration; screen readers get the word. */}
      {line.type !== 'context' && <span className="sr-only">{t(line.type === 'add' ? 'changes.line.added' : 'changes.line.removed')}{' '}</span>}
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

  // Roving tabindex: ONE gutter is a Tab stop (the one last focused, else the first line in view);
  // ↑ ↓ move between the lines' gutters on the same side. Otherwise every line would be two tab stops.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const items = virtualizer.getVirtualItems()
  const mountedKeys = new Set<string>()
  let firstVisible: string | null = null
  for (const item of items) {
    const row = rows[item.index]
    if (!row) continue
    for (const side of ['new', 'old'] as const) {
      if (gutterNumber(row, side) === null) continue
      const key = gutterKey(row.key, side)
      mountedKeys.add(key)
      if (!firstVisible) firstVisible = key
    }
  }
  const tabStopKey = focusKey && mountedKeys.has(focusKey) ? focusKey : firstVisible
  const pendingFocus = useRef<string | null>(null)
  const focusGutter = useCallback((key: string) => {
    const el = parentRef.current?.querySelector<HTMLElement>(`[data-gutter-key="${CSS.escape(key)}"]`)
    if (el) { el.focus(); return true }
    return false
  }, [])
  const onGutterKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-gutter-key]')
    if (!target) return
    const side = target.dataset.gutterSide === 'old' ? 'old' : 'new'
    const current = rows.findIndex((row) => gutterKey(row.key, side) === target.dataset.gutterKey)
    if (current < 0) return
    const step = event.key === 'ArrowDown' ? 1 : -1
    for (let i = current + step; i >= 0 && i < rows.length; i += step) {
      if (gutterNumber(rows[i], side) === null) continue
      event.preventDefault()
      const key = gutterKey(rows[i].key, side)
      setFocusKey(key)
      if (!focusGutter(key)) { pendingFocus.current = key; virtualizer.scrollToIndex(i, { align: 'auto' }) }
      return
    }
  }
  // The target row was outside the window: focus it once it has mounted.
  useEffect(() => {
    const key = pendingFocus.current
    if (key && focusGutter(key)) pendingFocus.current = null
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
          <Gutter no={line.oldNo} side="old" selected={oldSel} onSelect={onSelect} label={t('changes.line.selectOld', { n: line.oldNo ?? 0 })} id={gutterKey(row.key, 'old')} tabStop={tabStopKey === gutterKey(row.key, 'old')} />
          <Gutter no={line.newNo} side="new" selected={newSel} onSelect={onSelect} label={t('changes.line.select', { n: line.newNo ?? 0 })} id={gutterKey(row.key, 'new')} tabStop={tabStopKey === gutterKey(row.key, 'new')} />
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
          <Gutter no={no} side={side} selected={selected} onSelect={onSelect} label={t(side === 'old' ? 'changes.line.selectOld' : 'changes.line.select', { n: no ?? 0 })} id={gutterKey(row.key, side)} tabStop={tabStopKey === gutterKey(row.key, side)} />
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
      onKeyDown={onGutterKeyDown}
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
