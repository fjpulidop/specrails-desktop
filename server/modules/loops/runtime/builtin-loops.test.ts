import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { isDefinitionGraph, type LoopGraph } from './loop-graph'
import { getFactoryLoop } from './loop-factory'
import { getLoop, listLoops, publishLoop, updateLoop, duplicateLoop, builtinContentHash } from './loops-store'
import {
  EDITABLE_BUILTIN_LOOP_IDS,
  builtinLoopDefaults,
  ensureBuiltinLoops,
  resolveBuiltinLoop,
  restoreBuiltin,
  type BuiltinLoopEnvironment,
} from './builtin-loops'

const CORE = { engineV2: 1, workflowDefinitions: 1 }
const withCore: BuiltinLoopEnvironment = { loadCapabilities: async () => CORE, freestyleAvailable: () => true }
const legacyCore: BuiltinLoopEnvironment = { loadCapabilities: async () => ({}), freestyleAvailable: () => true }
const noCore: BuiltinLoopEnvironment = { loadCapabilities: async () => { throw new Error('Core unavailable') }, freestyleAvailable: () => true }

function editedGraph(base: LoopGraph): LoopGraph {
  return { ...structuredClone(base), config: { ...base.config, maxIterations: base.config.maxIterations + 1 } }
}

let db: DbInstance
beforeEach(() => { db = initDesktopDb(':memory:') })

describe('built-in loop seeding', () => {
  it('seeds one published row per editable built-in, keyed by the canonical factory id', async () => {
    const result = await ensureBuiltinLoops(db, withCore)
    expect(result.inserted.sort()).toEqual([...EDITABLE_BUILTIN_LOOP_IDS].sort())
    for (const id of EDITABLE_BUILTIN_LOOP_IDS) {
      const row = getLoop(db, id)!
      expect(row).toMatchObject({ id, builtinId: id, status: 'published', builtinModified: false, name: getFactoryLoop(id)!.name })
      expect(isDefinitionGraph(row.graph)).toBe(true)
      expect(db.prepare('SELECT published_graph FROM loops WHERE id = ?').get(id)).toEqual({ published_graph: JSON.stringify(row.graph) })
    }
    // Batch is an alias of Implement, never an editable row; aliases are not seeded.
    expect(getLoop(db, 'factory:batch')).toBeUndefined()
    expect(getLoop(db, 'factory:openspec')).toBeUndefined()
  })

  it('is idempotent, including concurrent seeders', async () => {
    await Promise.all([ensureBuiltinLoops(db, withCore), ensureBuiltinLoops(db, withCore)])
    const again = await ensureBuiltinLoops(db, withCore)
    expect(again).toMatchObject({ inserted: [], refreshed: [] })
    expect(listLoops(db).filter((loop) => loop.builtinId)).toHaveLength(EDITABLE_BUILTIN_LOOP_IDS.length)
  })

  it('seeds the legacy variant when Core is unavailable, then refreshes unedited rows once Core is known', async () => {
    await ensureBuiltinLoops(db, noCore)
    expect(isDefinitionGraph(getLoop(db, 'factory:implement')!.graph)).toBe(false)
    // Unknown capabilities never rewrite existing rows.
    expect((await ensureBuiltinLoops(db, noCore)).refreshed).toEqual([])
    const refreshed = await ensureBuiltinLoops(db, withCore)
    expect(refreshed.refreshed.sort()).toEqual([...EDITABLE_BUILTIN_LOOP_IDS].sort())
    const row = getLoop(db, 'factory:implement')!
    expect(isDefinitionGraph(row.graph)).toBe(true)
    expect(row.builtinModified).toBe(false)
    // A retained older Core (known, without definitions) moves unedited rows back.
    expect((await ensureBuiltinLoops(db, legacyCore)).refreshed).toContain('factory:implement')
  })

  it('never overwrites a user edit when the default changes', async () => {
    await ensureBuiltinLoops(db, legacyCore)
    const original = getLoop(db, 'factory:implement')!
    updateLoop(db, original.id, { graph: editedGraph(original.graph) })
    publishLoop(db, original.id)
    const result = await ensureBuiltinLoops(db, withCore)
    expect(result.refreshed).not.toContain('factory:implement')
    const row = getLoop(db, 'factory:implement')!
    expect(row.builtinModified).toBe(true)
    expect(row.graph.config.maxIterations).toBe(original.graph.config.maxIterations + 1)
    expect(isDefinitionGraph(row.graph)).toBe(false)
  })

  it('seeds Freestyle only with the capability and keeps an existing row when it disappears', async () => {
    await ensureBuiltinLoops(db, { ...withCore, freestyleAvailable: () => false })
    expect(getLoop(db, 'factory:freestyle')).toBeUndefined()
    await ensureBuiltinLoops(db, withCore)
    expect(getLoop(db, 'factory:freestyle')).toBeDefined()
    await ensureBuiltinLoops(db, { ...withCore, freestyleAvailable: () => false })
    expect(getLoop(db, 'factory:freestyle')).toBeDefined()
    expect(builtinLoopDefaults(CORE, false).map((d) => d.id)).not.toContain('factory:freestyle')
  })

  it('duplicating a built-in creates an ordinary loop', async () => {
    await ensureBuiltinLoops(db, withCore)
    const copy = duplicateLoop(db, 'factory:implement', 'copy-1', 'Implement (copy)')!
    expect(copy.builtinId).toBeUndefined()
    expect(copy.status).toBe('draft')
  })
})

describe('built-in loop resolution', () => {
  it('uses the code default when the row is missing or unedited', async () => {
    expect(resolveBuiltinLoop(db, 'factory:implement', CORE)).toMatchObject({ id: 'factory:implement', source: 'default', mode: 'implement' })
    expect(resolveBuiltinLoop(undefined, 'factory:implement', undefined)?.source).toBe('default')
    await ensureBuiltinLoops(db, withCore)
    // Unedited rows follow the current capabilities (e.g. Core temporarily unavailable).
    const resolved = resolveBuiltinLoop(db, 'factory:implement', undefined)!
    expect(resolved.source).toBe('default')
    expect(isDefinitionGraph(resolved.graph)).toBe(false)
    expect(resolveBuiltinLoop(db, 'factory:nope', CORE)).toBeUndefined()
  })

  it('runs an edited published graph, and the last published snapshot while an edit is Draft', async () => {
    await ensureBuiltinLoops(db, legacyCore)
    const row = getLoop(db, 'factory:implement')!
    const v1 = editedGraph(row.graph)
    updateLoop(db, row.id, { graph: v1 })
    // Draft edit of the seeded default: rails keep the seeded (published) graph.
    const duringFirstEdit = resolveBuiltinLoop(db, 'factory:implement', {})!
    expect(duringFirstEdit.source).toBe('published-snapshot')
    expect(duringFirstEdit.graph).toEqual(row.graph)
    publishLoop(db, row.id)
    expect(resolveBuiltinLoop(db, 'factory:implement', CORE)).toMatchObject({ source: 'edited', graph: v1 })
    const v2 = { ...v1, config: { ...v1.config, maxIterations: 7 } }
    updateLoop(db, row.id, { graph: v2, name: 'My Implement' })
    const draft = resolveBuiltinLoop(db, 'factory:implement', CORE)!
    expect(draft).toMatchObject({ source: 'published-snapshot', graph: v1, name: 'My Implement' })
  })

  it('resolves legacy aliases to their canonical built-in row', async () => {
    await ensureBuiltinLoops(db, legacyCore)
    const row = getLoop(db, 'factory:sdd-quick-openspec')!
    updateLoop(db, row.id, { graph: editedGraph(row.graph) })
    publishLoop(db, row.id)
    for (const alias of ['factory:openspec', 'factory:revision']) {
      expect(resolveBuiltinLoop(db, alias, {})).toMatchObject({ id: 'factory:sdd-quick-openspec', source: 'edited' })
    }
  })
})

describe('restoring a built-in', () => {
  it('resets content to the current default variant, published, with fresh hashes', async () => {
    await ensureBuiltinLoops(db, legacyCore)
    const row = getLoop(db, 'factory:implement')!
    updateLoop(db, row.id, { graph: editedGraph(row.graph), name: 'Renamed' })
    const restored = (await restoreBuiltin(db, 'factory:implement', withCore))!
    const expected = getFactoryLoop('factory:implement', CORE)!
    expect(restored).toMatchObject({ status: 'published', name: expected.name, builtinModified: false, graph: expected.graph })
    expect(db.prepare('SELECT builtin_default_hash, published_graph FROM loops WHERE id = ?').get(row.id)).toEqual({
      builtin_default_hash: builtinContentHash({ name: expected.name, description: expected.description, graph: expected.graph }),
      published_graph: JSON.stringify(expected.graph),
    })
    expect(resolveBuiltinLoop(db, 'factory:implement', CORE)?.source).toBe('default')
  })

  it('returns undefined for a non-built-in loop', async () => {
    expect(await restoreBuiltin(db, 'missing', withCore)).toBeUndefined()
  })
})
