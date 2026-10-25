import { describe, expect, it } from 'vitest'
import {
  anchorAnnotations, annotationOrder, ancestorDirs, buildAskAgentAddendum, buildSplitRows, buildTreeRows, buildUnifiedRows,
  extendSelection, flattenDiff, isSelected, orderedFiles, partitionAnnotations, selectionSnippet, stepIndex,
  type ChangeAnnotation, type ChangedFile, type FileDiff,
} from '../changes-model'

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, hash: `h-${path}`, ...extra,
})

const diff: FileDiff = {
  path: 'src/a.ts', oldPath: null, status: 'modified', binary: false, truncated: false, totalLines: 5,
  hunks: [{
    header: '@@ -1,3 +1,4 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
    lines: [
      { type: 'context', oldNo: 1, newNo: 1, text: 'a' },
      { type: 'delete', oldNo: 2, newNo: null, text: 'b' },
      { type: 'add', oldNo: null, newNo: 2, text: 'B' },
      { type: 'add', oldNo: null, newNo: 3, text: 'B2' },
      { type: 'context', oldNo: 3, newNo: 4, text: 'c' },
    ],
  }],
}

const annotation = (id: string, location: ChangeAnnotation['location'], extra: Partial<ChangeAnnotation> = {}): ChangeAnnotation => ({
  id, source: 'reviewer-finding', text: id, severity: null, author: null, location, ...extra,
})

describe('file tree', () => {
  const files = [file('src/ui/b.ts'), file('README.md'), file('src/ui/a.ts'), file('src/lib/deep/x/y.ts')]

  it('lists directories first, merges single-child chains and sorts', () => {
    const rows = buildTreeRows(files, new Set())
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.name}`)).toEqual([
      '0:dir:src', '1:dir:lib/deep/x', '2:file:y.ts', '1:dir:ui', '2:file:a.ts', '2:file:b.ts', '0:file:README.md',
    ])
    expect(rows[0].fileCount).toBe(3)
  })

  it('hides the children of a collapsed directory but keeps the j/k order complete', () => {
    const collapsed = new Set(['src/ui'])
    expect(buildTreeRows(files, collapsed).some((r) => r.name === 'a.ts')).toBe(false)
    expect(orderedFiles(files).map((f) => f.path)).toEqual(['src/lib/deep/x/y.ts', 'src/ui/a.ts', 'src/ui/b.ts', 'README.md'])
    expect(ancestorDirs('src/ui/a.ts')).toEqual(['src', 'src/ui'])
  })

  it('steps without wrapping and starts at the ends', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0)
    expect(stepIndex(-1, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })
})

describe('annotation anchoring', () => {
  const lines = flattenDiff(diff)

  it('pins an annotation under the last displayed line of its range', () => {
    const anchored = anchorAnnotations('src/a.ts', lines, [annotation('r', { path: 'src/a.ts', line: 2, endLine: 3 })])
    expect([...anchored.byLine.keys()]).toEqual([3])
    expect(anchored.fileLevel).toEqual([])
  })

  it('degrades a line outside the hunks, or no line, to the file header', () => {
    const anchored = anchorAnnotations('src/a.ts', lines, [
      annotation('far', { path: 'src/a.ts', line: 99, endLine: null }),
      annotation('none', { path: 'src/a.ts', line: null, endLine: null }),
      annotation('other', { path: 'src/b.ts', line: 1, endLine: null }),
    ])
    expect(anchored.fileLevel.map((a) => a.id)).toEqual(['far', 'none'])
    expect(anchored.byLine.size).toBe(0)
  })

  it('lists annotations without a location, or for a file outside the change, as unanchored', () => {
    const { forFile, unanchored } = partitionAnnotations([file('src/a.ts')], [
      annotation('a', { path: 'src/a.ts', line: 1, endLine: null }),
      annotation('legacy', null),
      annotation('gone', { path: 'src/removed.ts', line: 1, endLine: null }),
    ])
    expect(forFile.get('src/a.ts')?.map((a) => a.id)).toEqual(['a'])
    expect(unanchored.map((a) => a.id)).toEqual(['legacy', 'gone'])
  })

  it('walks annotations in tree order then line, skipping unlocated ones', () => {
    const files = [file('b.ts'), file('a/z.ts')]
    const order = annotationOrder(files, [
      annotation('b9', { path: 'b.ts', line: 9, endLine: null }),
      annotation('legacy', null),
      annotation('z2', { path: 'a/z.ts', line: 2, endLine: null }),
      annotation('b1', { path: 'b.ts', line: 1, endLine: null }),
    ])
    expect(order.map((a) => a.id)).toEqual(['z2', 'b1', 'b9'])
  })
})

describe('diff rows', () => {
  const anchored = anchorAnnotations('src/a.ts', flattenDiff(diff), [annotation('r', { path: 'src/a.ts', line: 2, endLine: null })])

  it('unified rows put the annotation block right under its line', () => {
    const kinds = buildUnifiedRows(diff, anchored).map((r) => r.kind)
    expect(kinds).toEqual(['hunk', 'line', 'line', 'line', 'annotations', 'line', 'line'])
  })

  it('split rows pair deletions with additions and keep annotations under the new-side line', () => {
    const rows = buildSplitRows(diff, anchored)
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'pair', 'pair', 'annotations', 'pair', 'pair'])
    const first = rows[2]
    expect(first.kind === 'pair' && first.left?.line.text).toBe('b')
    expect(first.kind === 'pair' && first.right?.line.text).toBe('B')
    const unpaired = rows[4]
    expect(unpaired.kind === 'pair' && unpaired.left).toBeNull()
  })
})

describe('selection', () => {
  const lines = flattenDiff(diff)
  it('extends within a side and restarts on the other side', () => {
    const one = extendSelection(null, 'new', 2, false)
    const range = extendSelection(one, 'new', 4, true)
    expect(range).toEqual({ side: 'new', from: 2, to: 4 })
    expect(extendSelection(range, 'old', 2, true)).toEqual({ side: 'old', from: 2, to: 2 })
    expect(extendSelection(range, 'new', 1, true)).toEqual({ side: 'new', from: 1, to: 2 })
    expect(isSelected(range, 'new', 3)).toBe(true)
    expect(isSelected(range, 'old', 3)).toBe(false)
    expect(isSelected(null, 'new', 1)).toBe(false)
  })

  it('quotes only the lines that exist on the chosen side', () => {
    expect(selectionSnippet(lines, { side: 'new', from: 1, to: 3 })).toBe('a\nB\nB2')
    expect(selectionSnippet(lines, { side: 'old', from: 1, to: 3 })).toBe('a\nb\nc')
  })
})

describe('ask the agent → addendum payload', () => {
  it('prefills path:lines, the quoted snippet and the note, as review feedback', () => {
    const payload = buildAskAgentAddendum({ path: 'src/a.ts', selection: { side: 'new', from: 2, to: 3 }, snippet: 'B\nB2', note: '  Make it pure.  ' })
    expect(payload.kind).toBe('review-feedback')
    expect(payload.title).toBe('Review: src/a.ts:2-3')
    expect(payload.body).toContain('`src/a.ts:2-3` (lines 2-3, after the change)')
    expect(payload.body).toContain('```\nB\nB2\n```')
    expect(payload.body.endsWith('Make it pure.')).toBe(true)
  })

  it('uses a longer fence when the snippet contains one, and bounds everything', () => {
    const payload = buildAskAgentAddendum({ path: 'a.md', selection: { side: 'new', from: 1, to: 1 }, snippet: '```js\nx\n```', note: 'n'.repeat(20_000) })
    expect(payload.body).toContain('````\n```js')
    expect(payload.body.length).toBeLessThanOrEqual(8000)
    expect(buildAskAgentAddendum({ path: 'p'.repeat(500), selection: null, snippet: '', note: 'x' }).title.length).toBeLessThanOrEqual(200)
  })

  it('supports a whole-file and a whole-delivery note', () => {
    expect(buildAskAgentAddendum({ path: 'a.ts', selection: null, snippet: '', note: 'x' }).title).toBe('Review: a.ts')
    const delivery = buildAskAgentAddendum({ path: null, selection: null, snippet: '', note: 'Check the auth flow\nmore' })
    expect(delivery.title).toBe('Review: Check the auth flow')
    expect(delivery.body).not.toContain('```')
  })
})
