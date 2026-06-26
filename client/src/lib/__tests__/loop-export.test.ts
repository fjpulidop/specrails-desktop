import { describe, it, expect } from 'vitest'
import { buildExportEnvelope, parseImportFile, exportFilename, EXPORT_VERSION } from '../loop-export'
import type { LoopDefinition } from '../loops-api'

function loop(over: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: 'l1',
    name: 'Ship & Green',
    description: 'desc',
    status: 'published',
    graph: { nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 } }], edges: [], config: { maxIterations: 5, timeoutMinutes: 20 } },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  }
}

describe('loop-export', () => {
  it('buildExportEnvelope strips id/status/timestamps, keeps name/description/graph', () => {
    const env = buildExportEnvelope([loop()])
    expect(env.specrailsLoops).toBe(EXPORT_VERSION)
    expect(env.loops).toEqual([{ name: 'Ship & Green', description: 'desc', graph: loop().graph }])
    expect(env.loops[0]).not.toHaveProperty('id')
    expect(env.loops[0]).not.toHaveProperty('status')
  })

  it('round-trips: parse(build(loops)) recovers the loop list', () => {
    const text = JSON.stringify(buildExportEnvelope([loop(), loop({ name: 'Other' })]))
    const back = parseImportFile(text)
    expect(back.map((l) => l.name)).toEqual(['Ship & Green', 'Other'])
  })

  it('parse accepts a bare array and a single loop object', () => {
    expect(parseImportFile(JSON.stringify([{ name: 'A', graph: loop().graph }])).map((l) => l.name)).toEqual(['A'])
    expect(parseImportFile(JSON.stringify({ name: 'Solo', graph: loop().graph }))[0].name).toBe('Solo')
  })

  it('parse throws on invalid JSON and on JSON with no loops', () => {
    expect(() => parseImportFile('{not json')).toThrow('invalid-json')
    expect(() => parseImportFile(JSON.stringify({ foo: 1 }))).toThrow('no-loops')
    expect(() => parseImportFile(JSON.stringify({ loops: [{ nope: true }] }))).toThrow('no-loops')
  })

  it('exportFilename slugifies a single loop, counts for multi', () => {
    expect(exportFilename([loop({ name: 'Ship & Green!' })])).toBe('ship-green.loop.json')
    expect(exportFilename([loop(), loop()])).toBe('specrails-loops-2.json')
  })
})
