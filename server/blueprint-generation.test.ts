import { describe, it, expect } from 'vitest'
import {
  SPECS_PER_DETAIL_TURN,
  MAX_GENERATION_TURNS,
  isOutlineSnapshot,
  unfilledSpecIndices,
  nextDetailRange,
  projectedGenerationTurns,
  specTitles,
  buildDetailPrompt,
  buildAuditPrompt,
  buildDetailRepairPrompt,
  buildAuditIssuesPrompt,
  parseGenerationBlocks,
  mergeSpecDetails,
  withSpecsComplete,
  rangeFilled,
  cutUnterminatedGenerationBlock,
} from './blueprint-generation'
import { premiumSpec } from './blueprint-spec-fixtures'

function outline(count = 5) {
  return {
    blueprintVersion: 1,
    specsComplete: false,
    m1Specs: Array.from({ length: count }, (_, i) => ({ ...premiumSpec(i), description: '', acceptanceCriteria: [] })),
  }
}

describe('blueprint-generation: snapshot shape helpers', () => {
  it('recognises an outline (≥ minimum specs, every body empty) and rejects anything else', () => {
    expect(isOutlineSnapshot(outline())).toBe(true)
    expect(isOutlineSnapshot(outline(4))).toBe(false) // below M1 minimum
    const partly = outline()
    partly.m1Specs[1] = premiumSpec(1)
    expect(isOutlineSnapshot(partly)).toBe(false)
    expect(isOutlineSnapshot(null)).toBe(false)
    expect(isOutlineSnapshot({ m1Specs: 'nope' })).toBe(false)
    expect(isOutlineSnapshot([])).toBe(false)
    // whitespace-only bodies still count as empty
    const ws = outline()
    ws.m1Specs[0] = { ...ws.m1Specs[0], description: '   ', acceptanceCriteria: ['  '] as string[] }
    expect(isOutlineSnapshot(ws)).toBe(true)
  })

  it('unfilledSpecIndices / nextDetailRange walk the pending specs two at a time', () => {
    const raw = outline(5)
    expect(unfilledSpecIndices(raw)).toEqual([0, 1, 2, 3, 4])
    expect(nextDetailRange(raw)).toEqual({ from: 0, to: 1 })
    raw.m1Specs[0] = premiumSpec(0)
    raw.m1Specs[1] = premiumSpec(1)
    expect(nextDetailRange(raw)).toEqual({ from: 2, to: 3 })
    raw.m1Specs[2] = premiumSpec(2)
    raw.m1Specs[3] = premiumSpec(3)
    expect(nextDetailRange(raw)).toEqual({ from: 4, to: 4 })
    raw.m1Specs[4] = premiumSpec(4)
    expect(nextDetailRange(raw)).toBeNull()
    expect(unfilledSpecIndices(null)).toEqual([])
    expect(nextDetailRange(undefined)).toBeNull()
    // a gap in the middle: the range spans from the first pending to at most perTurn
    const gap = outline(5)
    gap.m1Specs[0] = premiumSpec(0)
    gap.m1Specs[2] = premiumSpec(2)
    expect(nextDetailRange(gap)).toEqual({ from: 1, to: 2 })
    expect(nextDetailRange(gap, 3)).toEqual({ from: 1, to: 3 })
  })

  it('projects the turn budget: outline + ceil(n / per-turn) + audit', () => {
    expect(projectedGenerationTurns(5)).toBe(1 + 3 + 1)
    expect(projectedGenerationTurns(10)).toBe(1 + 5 + 1)
    expect(projectedGenerationTurns(10, 5)).toBe(1 + 2 + 1)
    expect(MAX_GENERATION_TURNS).toBeGreaterThanOrEqual(projectedGenerationTurns(10))
    expect(SPECS_PER_DETAIL_TURN).toBe(2)
  })

  it('specTitles tolerates missing/invalid titles and non-snapshots', () => {
    expect(specTitles(outline(2))).toEqual(['Scaffold the runnable project foundation', 'Deliver workflow slice 1'])
    expect(specTitles({ m1Specs: [{ title: 42 }, {}] })).toEqual(['', ''])
    expect(specTitles('x')).toEqual([])
  })

  it('rangeFilled / withSpecsComplete', () => {
    const raw = outline(3)
    expect(rangeFilled(raw, { from: 0, to: 1 })).toBe(false)
    raw.m1Specs[0] = premiumSpec(0)
    raw.m1Specs[1] = premiumSpec(1)
    expect(rangeFilled(raw, { from: 0, to: 1 })).toBe(true)
    expect(rangeFilled(raw, { from: 1, to: 5 })).toBe(false) // out of range → not filled
    expect(rangeFilled(null, { from: 0, to: 0 })).toBe(false)
    expect((withSpecsComplete(raw, true) as { specsComplete: boolean }).specsComplete).toBe(true)
    expect(withSpecsComplete('str', true)).toBe('str')
  })
})

describe('blueprint-generation: prompts', () => {
  it('detail prompt names each requested index + title and the spec-detail shape', () => {
    const p = buildDetailPrompt({ from: 2, to: 3 }, ['a', 'b', 'Third spec', 'Fourth spec'])
    expect(p).toContain('APP CONTINUE')
    expect(p).toContain('- index 2: "Third spec"')
    expect(p).toContain('- index 3: "Fourth spec"')
    expect(p).toContain('every spec')
    expect(p).toContain('```spec-detail')
    const single = buildDetailPrompt({ from: 4, to: 4 }, ['a', 'b', 'c', 'd'])
    expect(single).toContain('- index 4: ""')
    expect(single).toContain('the spec at the depth')
  })

  it('audit / repair / issues prompts are byte-stable apart from their detail', () => {
    expect(buildAuditPrompt()).toBe(buildAuditPrompt())
    expect(buildAuditPrompt()).toContain('APP AUDIT')
    expect(buildAuditPrompt()).toContain('```spec-audit')
    const repair = buildDetailRepairPrompt({ from: 0, to: 1 }, ['One', 'Two'], 'block cut off')
    expect(repair).toContain('APP CHECK')
    expect(repair).toContain('- index 1: "Two"')
    expect(repair).toContain('Problem: block cut off')
    expect(buildDetailRepairPrompt({ from: 0, to: 0 }, ['One'], '')).not.toContain('Problem:')
    const issues = buildAuditIssuesPrompt(['spec 2: only 3 criteria', 'spec 4: forward dependency'])
    expect(issues).toContain('- spec 2: only 3 criteria')
    expect(issues).toContain('- spec 4: forward dependency')
    expect(issues).toContain('per AFFECTED spec')
  })
})

describe('blueprint-generation: fenced blocks', () => {
  const detail = (index: number, spec: unknown = premiumSpec(index)) => '```spec-detail\n' + JSON.stringify({ index, spec }) + '\n```'

  it('returns the text untouched when no generation fence is present', () => {
    const r = parseGenerationBlocks('plain prose with ```json\n{}\n```')
    expect(r.hadBlocks).toBe(false)
    expect(r.stripped).toBe('plain prose with ```json\n{}\n```')
    expect(parseGenerationBlocks('').stripped).toBe('')
  })

  it('extracts spec-detail and spec-audit blocks in document order and strips them', () => {
    const text = `Intro.\n${detail(0)}\nmiddle\n${detail(1)}\n\`\`\`spec-audit\n{"specsComplete": false, "issues": ["x"], "fixes": [{"index": 1, "spec": {"title": "t"}}, {"bogus": true}]}\n\`\`\`\nOutro.`
    const r = parseGenerationBlocks(text)
    expect(r.hadBlocks).toBe(true)
    expect(r.details.map((d) => d.index)).toEqual([0, 1])
    expect(r.audit).toEqual({ specsComplete: false, issues: ['x'], fixes: [{ index: 1, spec: { title: 't' } }] })
    expect(r.stripped.replace(/\s+/g, ' ').trim()).toBe('Intro. middle Outro.')
    expect(r.rejected).toEqual([])
    expect(r.truncated).toBe(false)
  })

  it('rejects malformed detail payloads with a model-facing reason but keeps the good ones', () => {
    const text = [
      '```spec-detail\n{"index": "zero", "spec": {}}\n```',
      '```spec-detail\n{"index": -1, "spec": {}}\n```',
      '```spec-detail\n{"index": 1}\n```',
      '```spec-detail\n{"index": 2, "spec": {"kind": "feature" "title": "x"}}\n```',
      '```spec-audit\n[1,2]\n```',
      detail(3),
    ].join('\n')
    const r = parseGenerationBlocks(text)
    expect(r.details.map((d) => d.index)).toEqual([3])
    expect(r.audit).toBeNull()
    expect(r.rejected).toHaveLength(5)
    expect(r.rejected.filter((x) => x.includes('expected { "index": <integer>'))).toHaveLength(3)
    expect(r.rejected.some((x) => x.startsWith('detail block:'))).toBe(true)
    expect(r.rejected.some((x) => x.includes('spec-audit block: expected an object'))).toBe(true)
  })

  it('tolerant JSON repair accepts trailing commas / comments inside a block', () => {
    const r = parseGenerationBlocks('```spec-detail\n{ "index": 0, /* c */ "spec": { "title": "T", }, }\n```')
    expect(r.details).toEqual([{ index: 0, spec: { title: 'T' } }])
  })

  it('flags an open (cut-off) fence as truncated and cuts it from the transcript', () => {
    const r = parseGenerationBlocks(`${detail(0)}\nAnd then \`\`\`spec-detail\n{"index": 1, "spec": {"title": "half`)
    expect(r.details.map((d) => d.index)).toEqual([0])
    expect(r.truncated).toBe(true)
    expect(r.hadBlocks).toBe(true)
    expect(r.rejected).toEqual(['a generation block was cut off before its closing fence'])
    expect(r.stripped).toBe('\nAnd then ')
    const onlyOpen = parseGenerationBlocks('prose ```spec-audit\n{"specsComplete": tr')
    expect(onlyOpen.truncated).toBe(true)
    expect(onlyOpen.details).toEqual([])
    expect(onlyOpen.stripped).toBe('prose ')
  })

  it('cutUnterminatedGenerationBlock mirrors the live-stream cut', () => {
    expect(cutUnterminatedGenerationBlock('')).toBe('')
    expect(cutUnterminatedGenerationBlock('no fences')).toBe('no fences')
    expect(cutUnterminatedGenerationBlock(`${detail(0)}\ntail`)).toBe(`${detail(0)}\ntail`)
    expect(cutUnterminatedGenerationBlock('before ```spec-detail\n{"index": 0')).toBe('before ')
  })
})

describe('blueprint-generation: merging', () => {
  it('merges detail blocks by index, keeps outline keys a patch omitted, ignores out-of-range', () => {
    const raw = outline(3)
    raw.m1Specs[1] = { ...raw.m1Specs[1], labels: ['M1', 'keep-me'], dependsOnIndex: 0 } as typeof raw.m1Specs[1]
    const merged = mergeSpecDetails(raw, [
      { index: 1, spec: { description: 'body', acceptanceCriteria: ['a'] } },
      { index: 7, spec: { description: 'ignored' } },
    ]) as { m1Specs: Array<Record<string, unknown>> }
    expect(merged.m1Specs).toHaveLength(3)
    expect(merged.m1Specs[1]).toEqual(expect.objectContaining({ description: 'body', acceptanceCriteria: ['a'], labels: ['M1', 'keep-me'], dependsOnIndex: 0, kind: 'feature' }))
    expect(merged.m1Specs[0].description).toBe('')
    // immutability: the source snapshot is untouched
    expect(raw.m1Specs[1].description).toBe('')
  })

  it('returns non-snapshots unchanged', () => {
    expect(mergeSpecDetails(null, [{ index: 0, spec: {} }])).toBeNull()
    expect(mergeSpecDetails({ m1Specs: 'x' }, [{ index: 0, spec: {} }])).toEqual({ m1Specs: 'x' })
    const withNonObject = mergeSpecDetails({ m1Specs: ['str', null] }, [{ index: 0, spec: { title: 'T' } }]) as { m1Specs: unknown[] }
    expect(withNonObject.m1Specs[0]).toEqual({ title: 'T' })
    expect(withNonObject.m1Specs[1]).toBeNull()
  })
})
