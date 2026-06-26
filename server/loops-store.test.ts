import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import {
  listLoops,
  getLoop,
  createLoop,
  updateLoop,
  publishLoop,
  unpublishLoop,
  duplicateLoop,
  deleteLoop,
  importLoops,
  LoopValidationError,
} from './loops-store'
import { emptyLoopGraph, type LoopGraph } from './loop-graph'

function publishableGraph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 } },
      { id: 'e', type: 'end', position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 20 },
  }
}

let db: DbInstance

beforeEach(() => {
  db = initDesktopDb(':memory:')
})

describe('loops-store CRUD', () => {
  it('creates a loop as a Draft with the given graph', () => {
    const loop = createLoop(db, { id: 'l1', name: 'Ship & Verify', graph: publishableGraph() })
    expect(loop.id).toBe('l1')
    expect(loop.status).toBe('draft')
    expect(loop.graph.nodes).toHaveLength(3)
    expect(loop.graph.config.maxIterations).toBe(5)
    expect(loop.createdAt).toBeTruthy()
  })

  it('defaults to an empty graph when none is supplied', () => {
    const loop = createLoop(db, { id: 'l1', name: 'Blank' })
    expect(loop.graph).toEqual(emptyLoopGraph())
  })

  it('round-trips the graph through JSON storage', () => {
    createLoop(db, { id: 'l1', name: 'X', graph: publishableGraph() })
    const fetched = getLoop(db, 'l1')!
    expect(fetched.graph).toEqual(publishableGraph())
  })

  it('getLoop returns undefined for an unknown id', () => {
    expect(getLoop(db, 'nope')).toBeUndefined()
  })

  it('lists loops most-recently-updated first', () => {
    createLoop(db, { id: 'l1', name: 'First' })
    createLoop(db, { id: 'l2', name: 'Second' })
    updateLoop(db, 'l1', { name: 'First (edited)' }) // bumps updated_at
    const ids = listLoops(db).map((l) => l.id)
    expect(ids[0]).toBe('l1')
    expect(ids).toContain('l2')
  })

  it('deletes a loop', () => {
    createLoop(db, { id: 'l1', name: 'X' })
    deleteLoop(db, 'l1')
    expect(getLoop(db, 'l1')).toBeUndefined()
  })
})

describe('loops-store lifecycle', () => {
  it('publishes a loop with a valid graph', () => {
    createLoop(db, { id: 'l1', name: 'X', graph: publishableGraph() })
    const published = publishLoop(db, 'l1')!
    expect(published.status).toBe('published')
  })

  it('refuses to publish an invalid graph and leaves the loop in Draft', () => {
    createLoop(db, { id: 'l1', name: 'X' }) // empty graph → invalid
    expect(() => publishLoop(db, 'l1')).toThrow(LoopValidationError)
    expect(getLoop(db, 'l1')!.status).toBe('draft')
  })

  it('surfaces the validation errors on the thrown LoopValidationError', () => {
    createLoop(db, { id: 'l1', name: 'X' })
    try {
      publishLoop(db, 'l1')
      throw new Error('expected publishLoop to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LoopValidationError)
      const codes = (err as LoopValidationError).errors.map((e) => e.code)
      expect(codes).toContain('NO_START')
      expect(codes).toContain('NO_END')
    }
  })

  it('reverts a Published loop to Draft when it is edited', () => {
    createLoop(db, { id: 'l1', name: 'X', graph: publishableGraph() })
    publishLoop(db, 'l1')
    expect(getLoop(db, 'l1')!.status).toBe('published')
    updateLoop(db, 'l1', { name: 'X (tweaked)' })
    expect(getLoop(db, 'l1')!.status).toBe('draft')
  })

  it('unpublishes a loop without changing its content', () => {
    const graph = publishableGraph()
    createLoop(db, { id: 'l1', name: 'X', graph })
    publishLoop(db, 'l1')
    const result = unpublishLoop(db, 'l1')!
    expect(result.status).toBe('draft')
    expect(result.graph).toEqual(graph)
  })

  it('publishLoop / updateLoop / unpublishLoop return undefined for unknown ids', () => {
    expect(publishLoop(db, 'nope')).toBeUndefined()
    expect(updateLoop(db, 'nope', { name: 'x' })).toBeUndefined()
    expect(unpublishLoop(db, 'nope')).toBeUndefined()
  })
})

describe('loops-store duplicate (templates / clone)', () => {
  it('clones a loop into a fresh Draft with a new id + name, same graph', () => {
    createLoop(db, { id: 'tmpl', name: 'Ship & Green', graph: publishableGraph() })
    publishLoop(db, 'tmpl')
    const clone = duplicateLoop(db, 'tmpl', 'l2', 'My Ship & Green')!
    expect(clone.id).toBe('l2')
    expect(clone.name).toBe('My Ship & Green')
    expect(clone.status).toBe('draft') // a clone is always editable
    expect(clone.graph).toEqual(publishableGraph())
  })

  it('returns undefined when duplicating an unknown loop', () => {
    expect(duplicateLoop(db, 'nope', 'l2', 'x')).toBeUndefined()
  })

  describe('importLoops', () => {
    it('imports new loops as Drafts and skips duplicate names + invalid entries', () => {
      createLoop(db, { id: 'existing', name: 'Existing', graph: publishableGraph() })
      let n = 0
      const mintId = () => `imp-${++n}`
      const result = importLoops(
        db,
        [
          { name: 'Fresh One', graph: publishableGraph() },
          { name: 'Existing', graph: publishableGraph() }, // duplicate NAME → skipped
          { name: '', graph: publishableGraph() }, // unnamed → skipped
          { name: 'No Graph' }, // malformed → skipped
          { name: 'Fresh Two', description: 'd', graph: publishableGraph() },
        ],
        mintId
      )
      expect(result.imported.map((l) => l.name)).toEqual(['Fresh One', 'Fresh Two'])
      expect(result.skipped).toEqual(['Existing', '(invalid)', 'No Graph'])
      // imported loops exist as drafts
      const fresh = listLoops(db).find((l) => l.name === 'Fresh One')!
      expect(fresh.status).toBe('draft')
      expect(listLoops(db)).toHaveLength(3) // Existing + Fresh One + Fresh Two
    })

    it('returns empty result for non-array input', () => {
      expect(importLoops(db, null, () => 'x')).toEqual({ imported: [], skipped: [] })
    })

    it('dedups WITHIN the same import batch (second same-name entry skipped)', () => {
      let n = 0
      const result = importLoops(
        db,
        [
          { name: 'Twin', graph: publishableGraph() },
          { name: 'Twin', graph: publishableGraph() },
        ],
        () => `t-${++n}`
      )
      expect(result.imported).toHaveLength(1)
      expect(result.skipped).toEqual(['Twin'])
    })
  })
})
