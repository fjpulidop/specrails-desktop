import { describe, it, expect } from 'vitest'
import {
  coerceBlueprint,
  countStartedSpecs,
  cutUnterminatedBlock,
  deriveDimensions,
  describeStreamingSnapshot,
  parseBlueprintDraftBlocks,
  type Blueprint,
} from '../blueprint-draft'

function snapshot(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'home cooks' },
    coreFlow: 'photo → recipes',
    platform: 'web',
    stack: { language: 'TypeScript', framework: 'Next.js', db: 'SQLite' },
    assumptions: ['no auth in M1'],
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: false,
    m1Specs: [{
      kind: 'scaffold', title: 'Scaffold', shortSummary: 'Initialize the app.', description: 'init',
      acceptanceCriteria: [], priority: 'medium', labels: ['M1'],
    }],
    ...overrides,
  }
}

function fence(payload: unknown): string {
  return '```blueprint-draft\n' + JSON.stringify(payload) + '\n```'
}

describe('parseBlueprintDraftBlocks', () => {
  it('returns text unchanged with no blocks', () => {
    const res = parseBlueprintDraftBlocks('hello')
    expect(res).toEqual({ stripped: 'hello', blueprint: null, rawBlueprint: null, hadBlocks: false, rejected: [], repaired: false, truncated: false })
  })

  it('extracts and strips a valid snapshot', () => {
    const res = parseBlueprintDraftBlocks(`intro\n${fence(snapshot())}\ntail`)
    expect(res.stripped).toBe('intro\n\ntail')
    expect(res.blueprint?.product.name).toBe('Recipely')
    expect(res.hadBlocks).toBe(true)
  })

  it('last valid snapshot wins outright', () => {
    const res = parseBlueprintDraftBlocks(`${fence(snapshot({ platform: 'web' }))}\n${fence(snapshot({ platform: 'mobile' }))}`)
    expect(res.blueprint?.platform).toBe('mobile')
    expect((res.rawBlueprint as { platform: string }).platform).toBe('mobile')
  })

  it('preserves invalid rich fields in the raw snapshot while the read model stays compatible', () => {
    const raw = snapshot({
      specsComplete: true,
      m1Specs: [{
        ...snapshot().m1Specs[0],
        kind: 'unknown' as never,
        priority: 'urgent' as never,
        dependsOnIndex: -1,
      }],
    })
    const res = parseBlueprintDraftBlocks(fence(raw))
    expect(res.blueprint?.m1Specs[0]).toMatchObject({ kind: 'feature', priority: 'medium' })
    expect(res.blueprint?.m1Specs[0].dependsOnIndex).toBeUndefined()
    expect((res.rawBlueprint as { m1Specs: Array<Record<string, unknown>> }).m1Specs[0]).toMatchObject({
      kind: 'unknown', priority: 'urgent', dependsOnIndex: -1,
    })
  })

  it('malformed JSON keeps the previous valid snapshot', () => {
    const res = parseBlueprintDraftBlocks(`${fence(snapshot())}\n\`\`\`blueprint-draft\n{ nope\n\`\`\``)
    expect(res.blueprint?.product.name).toBe('Recipely')
  })

  it('missing blueprintVersion rejects the block', () => {
    const bad = { ...snapshot() } as Record<string, unknown>
    delete bad.blueprintVersion
    expect(parseBlueprintDraftBlocks(fence(bad)).blueprint).toBeNull()
  })
})

describe('coerceBlueprint', () => {
  it('defaults missing sections and drops unknown keys', () => {
    const bp = coerceBlueprint({ blueprintVersion: 1, rocket: true })
    expect(bp?.product).toEqual({ name: '', pitch: '', audience: '' })
    expect(bp && 'rocket' in bp).toBe(false)
  })

  it('coerces milestones and m1Specs defensively', () => {
    const bp = coerceBlueprint({
      blueprintVersion: 1,
      milestones: [{ id: 'm1', title: 'A', status: 'weird' }, 'junk', { id: '', title: '' }],
      specsComplete: true,
      m1Specs: [{
        kind: 'verification', title: 'S', shortSummary: 'Summary', acceptanceCriteria: ['Criterion'],
        priority: 'high', labels: ['a', 5], dependsOnIndex: -2,
      }, { title: '' }],
    })
    expect(bp?.milestones).toHaveLength(1)
    expect(bp?.milestones[0].status).toBe('planned')
    expect(bp?.specsComplete).toBe(true)
    expect(bp?.m1Specs).toHaveLength(1)
    expect(bp?.m1Specs[0].labels).toEqual(['a'])
    expect(bp?.m1Specs[0].dependsOnIndex).toBeUndefined()
    expect(bp?.m1Specs[0]).toMatchObject({
      kind: 'verification', shortSummary: 'Summary', acceptanceCriteria: ['Criterion'], priority: 'high',
    })
  })

  it('defaults rich fields when reading a legacy blueprint', () => {
    const bp = coerceBlueprint({ blueprintVersion: 1, m1Specs: [{ title: 'Legacy', description: 'old', labels: [] }] })
    expect(bp?.specsComplete).toBe(false)
    expect(bp?.m1Specs[0]).toMatchObject({ kind: 'feature', shortSummary: '', acceptanceCriteria: [], priority: 'medium' })
  })
})

describe('cutUnterminatedBlock', () => {
  it('cuts only an open trailing fence', () => {
    const complete = fence(snapshot())
    expect(cutUnterminatedBlock(`${complete}\nafter`)).toBe(`${complete}\nafter`)
    expect(cutUnterminatedBlock('thinking…\n```blueprint-draft\n{"blue')).toBe('thinking…\n')
  })
})

describe('deriveDimensions', () => {
  it('all false for null', () => {
    expect(Object.values(deriveDimensions(null)).every((v) => v === false)).toBe(true)
  })

  it('derives per-dimension completion', () => {
    const d = deriveDimensions(snapshot({ platform: '' }))
    expect(d.product).toBe(true)
    expect(d.platform).toBe(false)
    expect(d.stack).toBe(true)
    expect(d.milestones).toBe(true)
  })
})

describe('rejection diagnostics + tolerant repair (harden-project-builder-snapshots)', () => {
  it('invalid JSON is reported, not dropped', () => {
    const res = parseBlueprintDraftBlocks('x\n```blueprint-draft\n{"blueprintVersion": 1, "product": {"name": "A" "pitch": "p"}}\n```')
    expect(res.blueprint).toBeNull()
    expect(res.hadBlocks).toBe(true)
    expect(res.rejected).toEqual([expect.objectContaining({ index: 0, reason: 'invalid_json' })])
    expect(res.stripped).toBe('x\n')
  })

  it('repairs raw newlines / trailing commas / inner quotes and flags repaired', () => {
    const body = '{\n "blueprintVersion": 1,\n "product": { "name": "Say "hi"", "pitch": "a\nb", "audience": "x", },\n "m1Specs": [],\n}'
    const res = parseBlueprintDraftBlocks('```blueprint-draft\n' + body + '\n```')
    expect(res.blueprint?.product.name).toBe('Say "hi"')
    expect(res.blueprint?.product.pitch).toBe('a\nb')
    expect(res.repaired).toBe(true)
  })

  it('an unterminated trailing block is cut from the transcript and reported as truncated', () => {
    const res = parseBlueprintDraftBlocks('Generating…\n```blueprint-draft\n{"blueprintVersion":1,"m1Specs":[{"title":"a"},{"title":"b"},{"tit')
    expect(res.truncated).toBe(true)
    expect(res.stripped).toBe('Generating…\n')
    expect(res.rejected[0]).toMatchObject({ reason: 'truncated' })
    expect(res.rejected[0].detail).toMatch(/after 2 spec title/)
  })

  it('a nested json fence inside the block is unwrapped (orphan closing fence removed)', () => {
    const res = parseBlueprintDraftBlocks('Here.\n```blueprint-draft\n```json\n' + JSON.stringify(snapshot()) + '\n```\n```\nDone.')
    expect(res.blueprint?.product.name).toBe('Recipely')
    expect(res.stripped).toBe('Here.\n\nDone.')
  })

  it('describeStreamingSnapshot reports live generation only while a fence is open', () => {
    expect(describeStreamingSnapshot(null)).toEqual({ generating: false, specsStarted: 0 })
    expect(describeStreamingSnapshot('plain text')).toEqual({ generating: false, specsStarted: 0 })
    expect(describeStreamingSnapshot('Generating…\n```blueprint-draft\n{"m1Specs":[{"title":"a"},{"title":"b"}')).toEqual({ generating: true, specsStarted: 2 })
    expect(describeStreamingSnapshot('```blueprint-draft\n{"blueprintVersion":1}\n```\ndone')).toEqual({ generating: false, specsStarted: 0 })
    expect(countStartedSpecs('{"product":{"title":"x"},"m1Specs":[{"title":"a"}')).toBe(1)
  })
})
