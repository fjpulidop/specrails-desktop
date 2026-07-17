import { describe, it, expect } from 'vitest'
import {
  coerceBlueprint,
  cutUnterminatedBlock,
  parseBlueprintDraftBlocks,
} from './blueprint-draft-parser'
import { Blueprint } from './blueprint-types'

function snapshot(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'home cooks' },
    coreFlow: 'photo pantry → get recipes → cook',
    platform: 'web',
    stack: { language: 'TypeScript', framework: 'Next.js', db: 'SQLite' },
    assumptions: ['no auth in M1'],
    milestones: [
      { id: 'm1', title: 'Walking skeleton', goal: 'end-to-end flow', status: 'planned', plannedSpecs: [] },
      { id: 'm2', title: 'Accounts', goal: 'auth + profiles', status: 'planned', plannedSpecs: ['signup', 'login'] },
    ],
    specsComplete: false,
    m1Specs: [],
    ...overrides,
  }
}

function fence(payload: unknown): string {
  return '```blueprint-draft\n' + JSON.stringify(payload, null, 2) + '\n```'
}

describe('parseBlueprintDraftBlocks', () => {
  it('returns text unchanged when no blocks present', () => {
    const res = parseBlueprintDraftBlocks('hello, thinking about your idea')
    expect(res.stripped).toBe('hello, thinking about your idea')
    expect(res.blueprint).toBeNull()
    expect(res.hadBlocks).toBe(false)
  })

  it('handles empty/undefined text', () => {
    expect(parseBlueprintDraftBlocks('').stripped).toBe('')
    expect(parseBlueprintDraftBlocks(undefined as unknown as string).stripped).toBe('')
  })

  it('parses a valid snapshot and strips the fence', () => {
    const text = `Here is the plan.\n\n${fence(snapshot())}\n\nThoughts?`
    const res = parseBlueprintDraftBlocks(text)
    expect(res.stripped).toBe('Here is the plan.\n\n\n\nThoughts?')
    expect(res.blueprint?.product.name).toBe('Recipely')
    expect((res.rawBlueprint as { product: { name: string } }).product.name).toBe('Recipely')
    expect(res.blueprint?.milestones).toHaveLength(2)
    expect(res.hadBlocks).toBe(true)
  })

  it('last valid block wins outright (full snapshot, no merge)', () => {
    const first = snapshot({ platform: 'web' })
    const second = snapshot({ platform: 'mobile', assumptions: [] })
    const res = parseBlueprintDraftBlocks(`${fence(first)}\nmid\n${fence(second)}`)
    expect(res.blueprint?.platform).toBe('mobile')
    expect(res.blueprint?.assumptions).toEqual([])
  })

  it('malformed JSON is dropped silently, previous valid snapshot retained', () => {
    const text = `${fence(snapshot())}\n\`\`\`blueprint-draft\n{ broken json\n\`\`\``
    const res = parseBlueprintDraftBlocks(text)
    expect(res.blueprint?.product.name).toBe('Recipely')
    expect(res.stripped).not.toContain('broken json')
    expect(res.hadBlocks).toBe(true)
  })

  it('later invalid (schema) block does not clobber earlier valid one', () => {
    const invalid = { ...snapshot(), blueprintVersion: 'nope' }
    const res = parseBlueprintDraftBlocks(`${fence(snapshot())}\n${fence(invalid)}`)
    expect(res.blueprint?.blueprintVersion).toBe(1)
    expect((res.rawBlueprint as { blueprintVersion: number }).blueprintVersion).toBe(1)
  })

  it('preserves raw invalid spec fields instead of laundering them through compatibility defaults', () => {
    const raw = snapshot({
      specsComplete: true,
      m1Specs: [{
        kind: 'unknown', title: 'Raw contract', shortSummary: 'A summary.', description: 'body',
        acceptanceCriteria: [], priority: 'urgent', labels: ['M1'], dependsOnIndex: -1,
      } as never],
    })
    const res = parseBlueprintDraftBlocks(fence(raw))
    expect(res.blueprint?.m1Specs[0]).toMatchObject({ kind: 'feature', priority: 'medium' })
    expect(res.blueprint?.m1Specs[0].dependsOnIndex).toBeUndefined()
    expect((res.rawBlueprint as { m1Specs: Array<Record<string, unknown>> }).m1Specs[0]).toMatchObject({
      kind: 'unknown', priority: 'urgent', dependsOnIndex: -1,
    })
  })

  it('missing blueprintVersion rejects the block', () => {
    const payload = snapshot() as unknown as Record<string, unknown>
    delete payload.blueprintVersion
    const res = parseBlueprintDraftBlocks(fence(payload))
    expect(res.blueprint).toBeNull()
    expect(res.hadBlocks).toBe(true)
  })

  it('unterminated trailing block is not parsed (tail cut)', () => {
    const text = 'streaming…\n```blueprint-draft\n{"blueprintVersion": 1, "product"'
    const res = parseBlueprintDraftBlocks(text)
    expect(res.blueprint).toBeNull()
    // the open fence stays in stripped output — stream renderers use cutUnterminatedBlock
    expect(res.stripped).toContain('```blueprint-draft')
  })
})

describe('coerceBlueprint', () => {
  it('rejects non-objects', () => {
    expect(coerceBlueprint(null)).toBeNull()
    expect(coerceBlueprint([1])).toBeNull()
    expect(coerceBlueprint('x')).toBeNull()
  })

  it('rejects non-integer blueprintVersion', () => {
    expect(coerceBlueprint({ ...snapshot(), blueprintVersion: 1.5 })).toBeNull()
    expect(coerceBlueprint({ ...snapshot(), blueprintVersion: '1' })).toBeNull()
  })

  it('drops unknown top-level keys', () => {
    const bp = coerceBlueprint({ ...snapshot(), rocket: 'ship' }) as unknown as Record<string, unknown>
    expect(bp).not.toBeNull()
    expect('rocket' in bp).toBe(false)
  })

  it('defaults missing sub-objects to empty values', () => {
    const bp = coerceBlueprint({ blueprintVersion: 1 })
    expect(bp).not.toBeNull()
    expect(bp?.product).toEqual({ name: '', pitch: '', audience: '' })
    expect(bp?.stack.language).toBe('')
    expect(bp?.assumptions).toEqual([])
    expect(bp?.milestones).toEqual([])
    expect(bp?.specsComplete).toBe(false)
    expect(bp?.m1Specs).toEqual([])
  })

  it('coerces milestones: bad status → planned, skips empty entries, keeps ticketIds ints', () => {
    const bp = coerceBlueprint({
      blueprintVersion: 1,
      milestones: [
        { id: 'm1', title: 'A', goal: 'g', status: 'bogus', plannedSpecs: ['x', 42] },
        { id: '', title: '' },
        'junk',
        { id: 'm2', title: 'B', status: 'committed', ticketIds: [1, 2.5, 'x', 3] },
      ],
    })
    expect(bp?.milestones).toHaveLength(2)
    expect(bp?.milestones[0].status).toBe('planned')
    expect(bp?.milestones[0].plannedSpecs).toEqual(['x'])
    expect(bp?.milestones[1].status).toBe('committed')
    expect(bp?.milestones[1].ticketIds).toEqual([1, 3])
  })

  it('coerces m1Specs: skips titleless entries, keeps valid dependsOnIndex only', () => {
    const bp = coerceBlueprint({
      blueprintVersion: 1,
      m1Specs: [
        {
          kind: 'scaffold', title: 'Scaffold', shortSummary: 'Initialize the app.', description: 'd',
          acceptanceCriteria: ['a'], priority: 'high', labels: ['M1'], dependsOnIndex: -1,
        },
        { title: '', description: 'orphan' },
        { kind: 'bogus', title: 'Auth', description: 'd', labels: ['M1', 7], dependsOnIndex: 0, priority: 'bogus' },
      ],
    })
    expect(bp?.m1Specs).toHaveLength(2)
    expect(bp?.m1Specs[0].dependsOnIndex).toBeUndefined()
    expect(bp?.m1Specs[0]).toMatchObject({ kind: 'scaffold', shortSummary: 'Initialize the app.', acceptanceCriteria: ['a'], priority: 'high' })
    expect(bp?.m1Specs[1].dependsOnIndex).toBe(0)
    expect(bp?.m1Specs[1].labels).toEqual(['M1'])
    expect(bp?.m1Specs[1]).toMatchObject({ kind: 'feature', shortSummary: '', acceptanceCriteria: [], priority: 'medium' })
  })

  it('round-trips rich spec fields and the completion signal', () => {
    const bp = coerceBlueprint({
      ...snapshot(),
      specsComplete: true,
      m1Specs: [{
        kind: 'verification', title: 'Verify release', shortSummary: 'Prove the release path.',
        description: 'rich', acceptanceCriteria: ['The build passes.'], priority: 'critical', labels: ['M1', 'release'],
      }],
    })
    expect(bp?.specsComplete).toBe(true)
    expect(bp?.m1Specs[0]).toMatchObject({
      kind: 'verification', shortSummary: 'Prove the release path.',
      acceptanceCriteria: ['The build passes.'], priority: 'critical',
    })
  })

  it('stack.notes kept only when non-empty string', () => {
    const withNotes = coerceBlueprint({ blueprintVersion: 1, stack: { language: 'ts', framework: 'x', db: 'y', notes: 'n' } })
    expect(withNotes?.stack.notes).toBe('n')
    const emptyNotes = coerceBlueprint({ blueprintVersion: 1, stack: { language: 'ts', framework: 'x', db: 'y', notes: '' } })
    expect(emptyNotes?.stack.notes).toBeUndefined()
  })
})

describe('cutUnterminatedBlock', () => {
  it('no fence → unchanged', () => {
    expect(cutUnterminatedBlock('plain text')).toBe('plain text')
    expect(cutUnterminatedBlock('')).toBe('')
  })

  it('complete block → unchanged', () => {
    const text = `before\n${fence(snapshot())}\nafter`
    expect(cutUnterminatedBlock(text)).toBe(text)
  })

  it('open trailing fence → cut from the fence onward', () => {
    const text = 'thinking…\n```blueprint-draft\n{"blueprintVersion": 1'
    expect(cutUnterminatedBlock(text)).toBe('thinking…\n')
  })

  it('complete block followed by open fence → cuts only the open one', () => {
    const complete = fence(snapshot())
    const text = `${complete}\ntail\n\`\`\`blueprint-draft\n{"blue`
    expect(cutUnterminatedBlock(text)).toBe(`${complete}\ntail\n`)
  })
})
