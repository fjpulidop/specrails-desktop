import { describe, it, expect } from 'vitest'
import { premiumDescription, premiumCriteria } from './premium-spec-fixture'
import i18n from '../i18n'
import { analyzeBlueprintSpecQuality } from '../blueprint-spec-quality'
import { deriveReadiness, localizeQualityIssue, qualityIssueKey } from '../blueprint-readiness'
import { coerceBlueprint, type Blueprint } from '../blueprint-draft'

const BOUNDS = { minSpecs: 5, maxSpecs: 10 }
const OPTIONS = { milestoneLabel: 'M1', minSpecs: 5, maxSpecs: 10, requireScaffold: true }

function description(readme: boolean): string {
  return premiumDescription({ readme })
}

function complete(): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'p', audience: 'a' },
    coreFlow: 'flow',
    platform: 'web',
    stack: { language: 'ts', framework: 'next', db: 'sqlite' },
    assumptions: [],
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: true,
    m1Specs: Array.from({ length: 5 }, (_, i) => ({
      kind: i === 0 ? 'scaffold' as const : 'feature' as const,
      title: i === 0 ? 'Scaffold the project' : `Deliver slice ${i}`,
      shortSummary: `Deliver slice ${i}.`,
      description: description(i === 0),
      acceptanceCriteria: premiumCriteria(`slice ${i}`),
      priority: 'medium' as const,
      labels: ['M1', i === 0 ? 'foundation' : 'workflow'],
      ...(i > 0 ? { dependsOnIndex: i - 1 } : {}),
    })),
  }
}

function readiness(raw: unknown) {
  const bp = coerceBlueprint(raw)
  return deriveReadiness(bp, raw, analyzeBlueprintSpecQuality(raw, OPTIONS), BOUNDS)
}

describe('deriveReadiness', () => {
  it('no blueprint → every step pending, not ready', () => {
    const r = deriveReadiness(null, null, analyzeBlueprintSpecQuality(null, OPTIONS), BOUNDS)
    expect(r.ready).toBe(false)
    expect(r.steps.map((s) => [s.key, s.state])).toEqual([['blueprint', 'pending'], ['specs', 'pending'], ['audit', 'pending']])
    expect(r.steps[0].params).toEqual({ filled: 0, total: 5 })
    expect(r.issues).toEqual([])
  })

  it('interview snapshot (dimensions filled, no specs) → blueprint done, specs pending', () => {
    const raw = { ...complete(), specsComplete: false, m1Specs: [] }
    const r = readiness(raw)
    expect(r.ready).toBe(false)
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'pending', 'pending'])
    expect(r.steps[1].params).toEqual({ count: 0, written: 0, min: 5, max: 10 })
  })

  it('complete valid batch → all done, ready', () => {
    const r = readiness(complete())
    expect(r.ready).toBe(true)
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(r.steps[2].params).toEqual({ count: 0 })
  })

  it('specs out of bounds → specs blocked; specs present but not claimed complete → pending', () => {
    const tooFew = { ...complete(), m1Specs: complete().m1Specs.slice(0, 2) }
    expect(readiness(tooFew).steps[1]).toMatchObject({ state: 'blocked', params: { count: 2, min: 5, max: 10 } })
    const notClaimed = { ...complete(), specsComplete: false }
    expect(readiness(notClaimed).steps[1].state).toBe('pending')
    expect(readiness(notClaimed).steps[2].state).toBe('done')
  })

  it('audit issues → audit blocked with the count, batch-level codes excluded from the list', () => {
    const raw = complete() as unknown as { m1Specs: Array<Record<string, unknown>> }
    raw.m1Specs[2].priority = 'urgent'
    raw.m1Specs[3].labels = ['M1']
    const r = readiness(raw)
    expect(r.ready).toBe(false)
    expect(r.steps[2]).toMatchObject({ state: 'blocked', params: { count: 2 } })
    expect(r.issues.map((i) => i.code)).toEqual(['invalid_priority', 'domain_label'])
    expect(r.issues.every((i) => i.code !== 'batch_incomplete' && i.code !== 'spec_count')).toBe(true)
  })
})

describe('batched generation: writing / partial batches (premium-milestone-progress D7)', () => {
  function outline(written: number) {
    const raw = complete() as unknown as { specsComplete: boolean; m1Specs: Array<Record<string, unknown>> }
    raw.specsComplete = false
    raw.m1Specs = raw.m1Specs.map((spec, i) => (i < written ? spec : { ...spec, description: '', acceptanceCriteria: [] }))
    return raw
  }

  it('while the drive writes, specs + audit read as writing and NO audit issue is listed', () => {
    const raw = outline(2)
    const r = deriveReadiness(coerceBlueprint(raw), raw, analyzeBlueprintSpecQuality(raw, OPTIONS), BOUNDS, { generating: true })
    expect(r.ready).toBe(false)
    expect(r.steps[1]).toMatchObject({ state: 'writing', params: { count: 5, written: 2 } })
    expect(r.steps[2]).toMatchObject({ state: 'writing', params: { count: 0 } })
    expect(r.issues).toEqual([])
  })

  it('a halted partial batch keeps only the issues of WRITTEN specs; the unwritten tail is not an audit failure', () => {
    const raw = outline(2)
    raw.m1Specs[1].labels = ['M1'] // a real defect on a written spec
    const r = deriveReadiness(coerceBlueprint(raw), raw, analyzeBlueprintSpecQuality(raw, OPTIONS), BOUNDS)
    expect(r.steps[1]).toMatchObject({ state: 'pending', params: { count: 5, written: 2 } })
    expect(r.issues.map((i) => [i.specIndex, i.code])).toEqual([[1, 'domain_label']])
    expect(r.steps[2]).toMatchObject({ state: 'blocked', params: { count: 1 } })
    // No defect on the written specs → the audit simply waits.
    const clean = outline(2)
    const r2 = deriveReadiness(coerceBlueprint(clean), clean, analyzeBlueprintSpecQuality(clean, OPTIONS), BOUNDS)
    expect(r2.issues).toEqual([])
    expect(r2.steps[2]).toMatchObject({ state: 'pending' })
  })

  it('a complete batch ignores the generating flag semantics once specsComplete is true', () => {
    const raw = complete()
    const r = deriveReadiness(coerceBlueprint(raw), raw, analyzeBlueprintSpecQuality(raw, OPTIONS), BOUNDS, { generating: false })
    expect(r.steps[1].state).toBe('done')
    expect(r.steps[2].state).toBe('done')
  })
})

describe('qualityIssueKey + localizeQualityIssue', () => {
  it('maps field/code pairs to builder:quality keys', () => {
    expect(qualityIssueKey({ field: 'shortSummary', code: 'summary' })).toBe('quality.summary')
    expect(qualityIssueKey({ field: 'shortSummary', code: 'required' })).toBe('quality.summary')
    expect(qualityIssueKey({ field: 'title', code: 'required' })).toBe('quality.title_required')
    expect(qualityIssueKey({ field: 'title', code: 'duplicate' })).toBe('quality.title_duplicate')
    expect(qualityIssueKey({ field: 'description', code: 'empty_section' })).toBe('quality.empty_section')
  })

  it('localizes with the structured params (spec number, heading, label, bounds)', () => {
    const t = i18n.getFixedT(null, 'builder')
    expect(localizeQualityIssue(t, { specIndex: 2, field: 'description', code: 'empty_section', message: 'x', params: { n: 3, heading: 'Out of Scope' } }))
      .toBe('Spec 3 has an empty "Out of Scope" section.')
    expect(localizeQualityIssue(t, { specIndex: null, field: 'm1Specs', code: 'spec_count', message: 'x', params: { min: 5, max: 10, count: 2 } }))
      .toBe('The batch needs 5–10 specs (currently 2).')
    expect(localizeQualityIssue(t, { specIndex: 0, field: 'labels', code: 'milestone_label', message: 'x', params: { n: 1, label: 'M2' } }))
      .toBe('Spec 1 needs the M2 label.')
    // Server-shaped issues without params still resolve the spec number.
    expect(localizeQualityIssue(t, { specIndex: 4, field: 'priority', code: 'invalid_priority', message: 'x' }))
      .toBe('Spec 5 needs a valid priority.')
  })

  it('unknown codes fall back to the English message', () => {
    const t = i18n.getFixedT(null, 'builder')
    expect(localizeQualityIssue(t, { specIndex: 0, field: 'x', code: 'brand_new_code', message: 'Raw fallback.' })).toBe('Raw fallback.')
  })
})
