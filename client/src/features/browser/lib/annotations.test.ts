import { describe, it, expect } from 'vitest'
import {
  annotationReducer,
  initialEditorState,
  nextStepNumber,
  normalizeBox,
  arrowHead,
  isUsableDrag,
  clamp01,
  toAnnotationSet,
  type Annotation,
  type EditorState,
} from './annotations'

const box = (id: string): Annotation => ({ id, kind: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0.2, color: '#f00' })

describe('annotationReducer', () => {
  it('adds objects and clears the redo stack', () => {
    let s = initialEditorState
    s = annotationReducer(s, { type: 'add', obj: box('a') })
    s = annotationReducer(s, { type: 'add', obj: box('b') })
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(s.past).toHaveLength(2)
    expect(s.future).toHaveLength(0)
  })

  it('undo and redo move objects across the history stacks', () => {
    let s = annotationReducer(initialEditorState, { type: 'add', obj: box('a') })
    s = annotationReducer(s, { type: 'add', obj: box('b') })
    s = annotationReducer(s, { type: 'undo' })
    expect(s.objects.map((o) => o.id)).toEqual(['a'])
    expect(s.future).toHaveLength(1)
    s = annotationReducer(s, { type: 'redo' })
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(s.future).toHaveLength(0)
  })

  it('adding after an undo discards the redo future', () => {
    let s = annotationReducer(initialEditorState, { type: 'add', obj: box('a') })
    s = annotationReducer(s, { type: 'add', obj: box('b') })
    s = annotationReducer(s, { type: 'undo' })
    s = annotationReducer(s, { type: 'add', obj: box('c') })
    expect(s.objects.map((o) => o.id)).toEqual(['a', 'c'])
    expect(s.future).toHaveLength(0)
  })

  it('delete removes by id and is a no-op for unknown ids', () => {
    let s = annotationReducer(initialEditorState, { type: 'add', obj: box('a') })
    const before = s
    s = annotationReducer(s, { type: 'delete', id: 'zzz' })
    expect(s).toBe(before) // unchanged reference
    s = annotationReducer(s, { type: 'delete', id: 'a' })
    expect(s.objects).toHaveLength(0)
  })

  it('undo/redo on empty stacks are no-ops', () => {
    expect(annotationReducer(initialEditorState, { type: 'undo' })).toBe(initialEditorState)
    expect(annotationReducer(initialEditorState, { type: 'redo' })).toBe(initialEditorState)
  })

  it('clear wipes objects (recorded for undo) and is a no-op when empty', () => {
    expect(annotationReducer(initialEditorState, { type: 'clear' })).toBe(initialEditorState)
    let s = annotationReducer(initialEditorState, { type: 'add', obj: box('a') })
    s = annotationReducer(s, { type: 'clear' })
    expect(s.objects).toHaveLength(0)
    s = annotationReducer(s, { type: 'undo' })
    expect(s.objects.map((o) => o.id)).toEqual(['a'])
  })

  it('ignores unknown actions', () => {
    const s: EditorState = initialEditorState
    expect(annotationReducer(s, { type: 'bogus' } as unknown as { type: 'undo' })).toBe(s)
  })
})

describe('geometry', () => {
  it('nextStepNumber is contiguous and based on the max', () => {
    expect(nextStepNumber([])).toBe(1)
    expect(nextStepNumber([{ id: '1', kind: 'step', x: 0, y: 0, n: 1, color: '#f00' }, { id: '2', kind: 'step', x: 0, y: 0, n: 3, color: '#f00' }])).toBe(4)
    expect(nextStepNumber([box('b')])).toBe(1) // no steps
  })

  it('normalizeBox handles any drag direction', () => {
    const r = normalizeBox({ x: 0.4, y: 0.5 }, { x: 0.1, y: 0.2 })
    expect(r.x).toBeCloseTo(0.1)
    expect(r.y).toBeCloseTo(0.2)
    expect(r.w).toBeCloseTo(0.3)
    expect(r.h).toBeCloseTo(0.3)
  })

  it('arrowHead returns two barbs near the tip', () => {
    const { left, right } = arrowHead({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.1)
    // pointing right → barbs sit left of the tip, symmetric in y
    expect(left.x).toBeLessThan(1)
    expect(right.x).toBeLessThan(1)
    expect(left.y).toBeCloseTo(-right.y, 6)
  })

  it('isUsableDrag rejects tiny drags', () => {
    expect(isUsableDrag({ x: 0.1, y: 0.1 }, { x: 0.1005, y: 0.1005 })).toBe(false)
    expect(isUsableDrag({ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 })).toBe(true)
  })

  it('clamp01 bounds points with a small overshoot', () => {
    expect(clamp01({ x: 2, y: -1 })).toEqual({ x: 1.05, y: -0.05 })
    expect(clamp01({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 })
  })

  it('toAnnotationSet wraps objects with the schema version + base size', () => {
    expect(toAnnotationSet([box('a')], 800, 600)).toEqual({ schemaVersion: 1, objects: [box('a')], baseWidth: 800, baseHeight: 600 })
  })
})
