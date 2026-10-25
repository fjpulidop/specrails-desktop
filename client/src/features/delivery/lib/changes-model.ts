/**
 * Pure model of the review packet's Changes tab (feature-gap CD3).
 *
 * Mirrors the wire types of `GET /rails/pr-deliveries/:id/changes[/file]`
 * (`server/modules/delivery/runtime/delivery-changes.ts`) and holds everything
 * the view derives from them — the file tree, the diff rows for both layouts,
 * annotation anchoring, selection snippets and the "ask the agent" addendum —
 * so the interesting rules are testable without a DOM.
 */

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

export interface ChangedFile {
  path: string
  oldPath: string | null
  status: ChangedFileStatus
  additions: number | null
  deletions: number | null
  binary: boolean
  /** Changes whenever this file's diff does: the "viewed" invalidation key. */
  hash: string
}

export interface ChangeSource { id: string; ticketId: number | null; branch: string }

export interface ChangeAnnotation {
  id: string
  source: 'reviewer-finding' | 'review-risk' | 'review-untested' | 'follow-up-comment'
  text: string
  severity: 'high' | 'medium' | 'low' | null
  author: string | null
  location: { path: string; line: number | null; endLine: number | null } | null
}

export type ChangesPayload =
  | { available: false; reason: string; sources: ChangeSource[]; annotations: ChangeAnnotation[] }
  | {
    available: true
    source: string
    sources: ChangeSource[]
    base: string
    head: string
    baseSha: string
    headSha: string
    root: string
    rootKind: 'worktree' | 'repository'
    files: ChangedFile[]
    truncated: boolean
    totals: { files: number; additions: number; deletions: number }
    annotations: ChangeAnnotation[]
  }

export interface DiffLine { type: 'context' | 'add' | 'delete'; oldNo: number | null; newNo: number | null; text: string; noNewline?: boolean }
export interface DiffHunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export interface FileDiff {
  path: string
  oldPath: string | null
  status: ChangedFileStatus
  binary: boolean
  hunks: DiffHunk[]
  truncated: boolean
  totalLines: number
}

export type DiffMode = 'unified' | 'split'

// ─── Tree ───────────────────────────────────────────────────────────────────

export interface TreeRow {
  kind: 'dir' | 'file'
  /** Full path (a directory's path ends without a slash). */
  path: string
  name: string
  depth: number
  file?: ChangedFile
  /** Directory only: files below it, and how many are viewed. */
  fileCount?: number
}

interface DirNode { name: string; path: string; dirs: Map<string, DirNode>; files: ChangedFile[] }

function emptyDir(name: string, path: string): DirNode { return { name, path, dirs: new Map(), files: [] } }

function buildDirTree(files: readonly ChangedFile[]): DirNode {
  const root = emptyDir('', '')
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = node.dirs.get(parts[i])
      if (!next) { next = emptyDir(parts[i], path); node.dirs.set(parts[i], next) }
      node = next
    }
    node.files.push(file)
  }
  return root
}

function countFiles(node: DirNode): number {
  let n = node.files.length
  for (const dir of node.dirs.values()) n += countFiles(dir)
  return n
}

/**
 * Display order of the tree: directories first, then files, each alphabetical;
 * a directory holding exactly one directory and no files is merged into one
 * row (`src/app/ui`), the way editors show it.
 */
export function buildTreeRows(files: readonly ChangedFile[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (node: DirNode, depth: number): void => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const original of dirs) {
      let dir = original
      let name = dir.name
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0]
        name = `${name}/${dir.name}`
      }
      rows.push({ kind: 'dir', path: dir.path, name, depth, fileCount: countFiles(dir) })
      if (!collapsed.has(dir.path)) walk(dir, depth + 1)
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', path: file.path, name: file.path.slice(file.path.lastIndexOf('/') + 1), depth, file })
    }
  }
  walk(buildDirTree(files), 0)
  return rows
}

/** Files in tree order, ignoring collapsed state: the order `j` / `k` walk. */
export function orderedFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return buildTreeRows(files, new Set()).filter((row) => row.kind === 'file').map((row) => row.file!)
}

/** Every ancestor directory path of a file (as rendered, i.e. possibly merged chains' deepest dir). */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Step through `items` by delta, clamped (no wrap); -1 index starts at the first/last. */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + delta))
}

// ─── Annotations ────────────────────────────────────────────────────────────

export interface AnchoredAnnotations {
  /** Annotations pinned under a displayed line, keyed by that line's index in `FileLines`. */
  byLine: Map<number, ChangeAnnotation[]>
  /** The file is known but the line is not (or is outside the displayed hunks). */
  fileLevel: ChangeAnnotation[]
}

/** The flattened displayed lines of a diff, with hunk boundaries recorded. */
export interface FileLines { lines: DiffLine[]; hunkStarts: number[] }

export function flattenDiff(diff: FileDiff): FileLines {
  const lines: DiffLine[] = []
  const hunkStarts: number[] = []
  for (const hunk of diff.hunks) {
    hunkStarts.push(lines.length)
    lines.push(...hunk.lines)
  }
  return { lines, hunkStarts }
}

/**
 * Where an annotation for `path` shows. An annotation names a line of the NEW
 * file; it pins under the last displayed line of its range that exists in the
 * diff. A line outside every hunk (or a missing line number) degrades to the
 * file header, never disappears. Annotations whose path is not in the diff at
 * all are the caller's "unanchored" list.
 */
export function anchorAnnotations(path: string, file: FileLines | null, annotations: readonly ChangeAnnotation[]): AnchoredAnnotations {
  const result: AnchoredAnnotations = { byLine: new Map(), fileLevel: [] }
  for (const annotation of annotations) {
    if (annotation.location?.path !== path) continue
    const start = annotation.location.line
    const end = annotation.location.endLine ?? start
    let index = -1
    if (file && start !== null && end !== null) {
      for (let i = 0; i < file.lines.length; i++) {
        const no = file.lines[i].newNo
        if (no !== null && no >= start && no <= end) index = i
      }
    }
    if (index < 0) result.fileLevel.push(annotation)
    else result.byLine.set(index, [...(result.byLine.get(index) ?? []), annotation])
  }
  return result
}

/** Annotations whose file is part of the change; the rest render at the top. */
export function partitionAnnotations(files: readonly ChangedFile[], annotations: readonly ChangeAnnotation[]): {
  forFile: Map<string, ChangeAnnotation[]>
  unanchored: ChangeAnnotation[]
} {
  const known = new Set(files.map((f) => f.path))
  const forFile = new Map<string, ChangeAnnotation[]>()
  const unanchored: ChangeAnnotation[] = []
  for (const annotation of annotations) {
    const at = annotation.location
    if (at && known.has(at.path)) forFile.set(at.path, [...(forFile.get(at.path) ?? []), annotation])
    else unanchored.push(annotation)
  }
  return { forFile, unanchored }
}

/** Annotation walk order for `n` / `p`: file tree order, then line (file-level first). */
export function annotationOrder(files: readonly ChangedFile[], annotations: readonly ChangeAnnotation[]): ChangeAnnotation[] {
  const rank = new Map(orderedFiles(files).map((file, index) => [file.path, index]))
  return annotations
    .filter((a) => a.location && rank.has(a.location.path))
    .sort((a, b) => (rank.get(a.location!.path)! - rank.get(b.location!.path)!) || ((a.location!.line ?? 0) - (b.location!.line ?? 0)))
}

// ─── Rows (what the virtualiser renders) ───────────────────────────────────

export type DiffRow =
  | { kind: 'hunk'; key: string; header: string }
  | { kind: 'line'; key: string; index: number; line: DiffLine }
  | { kind: 'pair'; key: string; left: { index: number; line: DiffLine } | null; right: { index: number; line: DiffLine } | null }
  | { kind: 'annotations'; key: string; annotations: ChangeAnnotation[] }

/** Unified rows: hunk headers, lines, and annotation blocks under their line. */
export function buildUnifiedRows(diff: FileDiff, anchored: AnchoredAnnotations): DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  diff.hunks.forEach((hunk, h) => {
    rows.push({ kind: 'hunk', key: `h${h}`, header: hunk.header })
    for (const line of hunk.lines) {
      rows.push({ kind: 'line', key: `l${index}`, index, line })
      const here = anchored.byLine.get(index)
      if (here) rows.push({ kind: 'annotations', key: `a${index}`, annotations: here })
      index++
    }
  })
  return rows
}

/**
 * Split rows: a run of deletions pairs with the additions that follow it;
 * context lines sit on both sides. Annotations (new-file side) go under the
 * pair holding their line.
 */
export function buildSplitRows(diff: FileDiff, anchored: AnchoredAnnotations): DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  diff.hunks.forEach((hunk, h) => {
    rows.push({ kind: 'hunk', key: `h${h}`, header: hunk.header })
    const lines = hunk.lines
    let i = 0
    const pushAnnotations = (indexes: number[]): void => {
      const found = indexes.flatMap((n) => anchored.byLine.get(n) ?? [])
      if (found.length) rows.push({ kind: 'annotations', key: `a${indexes[0]}`, annotations: found })
    }
    while (i < lines.length) {
      const line = lines[i]
      if (line.type === 'context') {
        rows.push({ kind: 'pair', key: `p${index}`, left: { index, line }, right: { index, line } })
        pushAnnotations([index])
        index++; i++
        continue
      }
      const deletes: Array<{ index: number; line: DiffLine }> = []
      const adds: Array<{ index: number; line: DiffLine }> = []
      while (i < lines.length && lines[i].type === 'delete') { deletes.push({ index, line: lines[i] }); index++; i++ }
      while (i < lines.length && lines[i].type === 'add') { adds.push({ index, line: lines[i] }); index++; i++ }
      const height = Math.max(deletes.length, adds.length)
      for (let r = 0; r < height; r++) {
        const left = deletes[r] ?? null
        const right = adds[r] ?? null
        rows.push({ kind: 'pair', key: `p${(left ?? right)!.index}`, left, right })
        if (right) pushAnnotations([right.index])
      }
    }
  })
  return rows
}

// ─── Selection ──────────────────────────────────────────────────────────────

/** A contiguous selection of line numbers on one side of the diff. */
export interface LineSelection { side: 'new' | 'old'; from: number; to: number }

export function normalizeSelection(selection: LineSelection): LineSelection {
  return selection.from <= selection.to ? selection : { ...selection, from: selection.to, to: selection.from }
}

/** Extend (shift-click) an anchor to a line on the same side; a different side starts afresh. */
export function extendSelection(current: LineSelection | null, side: 'new' | 'old', lineNo: number, extend: boolean): LineSelection {
  if (!extend || !current || current.side !== side) return { side, from: lineNo, to: lineNo }
  return normalizeSelection({ side, from: current.from, to: lineNo })
}

export function isSelected(selection: LineSelection | null, side: 'new' | 'old', lineNo: number | null): boolean {
  if (!selection || lineNo === null || selection.side !== side) return false
  const { from, to } = normalizeSelection(selection)
  return lineNo >= from && lineNo <= to
}

export function selectionSnippet(file: FileLines, selection: LineSelection): string {
  const { from, to } = normalizeSelection(selection)
  const pick = (line: DiffLine): number | null => (selection.side === 'new' ? line.newNo : line.oldNo)
  return file.lines
    .filter((line) => { const no = pick(line); return no !== null && no >= from && no <= to && (selection.side === 'new' ? line.type !== 'delete' : line.type !== 'add') })
    .map((line) => line.text)
    .join('\n')
}

export function formatLineRange(selection: Pick<LineSelection, 'from' | 'to'>): string {
  const from = Math.min(selection.from, selection.to)
  const to = Math.max(selection.from, selection.to)
  return from === to ? String(from) : `${from}-${to}`
}

// ─── Ask the agent (spec addendum) ─────────────────────────────────────────

const ADDENDUM_BODY_CAP = 8000
const SNIPPET_CAP = 2500
const NOTE_CAP = 3500
const TITLE_CAP = 200

export interface AskAgentInput {
  /** null = the note is about the delivery as a whole (an unanchored annotation). */
  path: string | null
  /** null = the whole file. */
  selection: LineSelection | null
  snippet: string
  note: string
}

/**
 * The existing spec-addendum carrier, prefilled: `path:lines`, the selected code
 * as quoted evidence and the person's note. Bounded so it always passes the
 * addendum validator (body ≤ 8000, title ≤ 200).
 */
export function buildAskAgentAddendum(input: AskAgentInput): { kind: 'review-feedback'; title: string; body: string } {
  const range = input.selection ? formatLineRange(input.selection) : null
  const where = input.path ? (range ? `${input.path}:${range}` : input.path) : null
  const note = input.note.trim().slice(0, NOTE_CAP)
  const parts: string[] = [
    where
      ? `Requested in review of this delivery: \`${where}\`${input.selection ? ` (lines ${range}, ${input.selection.side === 'old' ? 'before the change' : 'after the change'})` : ''}.`
      : 'Requested in review of this delivery.',
  ]
  const snippet = input.snippet.length > SNIPPET_CAP ? `${input.snippet.slice(0, SNIPPET_CAP)}\n…` : input.snippet
  if (snippet) {
    // A fence the snippet itself cannot close.
    let fence = '```'
    while (snippet.includes(fence)) fence += '`'
    parts.push('', `${fence}\n${snippet}\n${fence}`)
  }
  parts.push('', note)
  const title = where ? `Review: ${where}` : `Review: ${note.split('\n')[0].slice(0, 80)}`
  return { kind: 'review-feedback', title: title.slice(0, TITLE_CAP), body: parts.join('\n').slice(0, ADDENDUM_BODY_CAP) }
}
