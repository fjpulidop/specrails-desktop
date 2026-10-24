import { describe, expect, it } from 'vitest'
import {
  TRIAGE_PROMPT_VERSION, buildTriageSystemPrompt, buildTriageUserPrompt, canonicalJson, extractJsonObject, fallbackLoop, isTicketTriage,
  parseTriageOutput, rankFiles, recommendedLoopForTickets, sanitizeFilePath, similarTicketIds, triageAccuracy,
  triageContentSignature, triageTicketText, type TriageInputs, type TriageLoopOption,
} from './triage'

const LOOPS: TriageLoopOption[] = [
  { id: 'factory:implement', name: 'Implement', description: 'full pipeline' },
  { id: 'factory:sdd-quick-openspec', name: 'Quick SDD', description: 'light' },
]

const ready = (loop: string) => ({
  status: 'ready', size: 'S', recommendedLoop: loop, inputsHash: 'sha256:x', computedAt: '2026-10-22T00:00:00Z',
})

describe('canonical inputs', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }))
      .toBe(canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }))
  })

  it('bounds and normalises the ticket text (labels sorted and unique)', () => {
    const text = triageTicketText({ title: '  T  ', description: 'x'.repeat(9000), labels: ['b', 'a', 'b', 3], priority: 'high' })
    expect(text.title).toBe('T')
    expect(text.description).toHaveLength(8000)
    expect(text.labels).toEqual(['a', 'b'])
    expect(text).not.toHaveProperty('repositoryIds')
  })

  it('content signature ignores status, timestamps and stored triage', () => {
    const base = { title: 'Add login', description: 'd', labels: ['auth'], priority: 'high' }
    expect(triageContentSignature({ ...base, status: 'todo', updated_at: '1', metadata: { triage: ready('x') } } as never))
      .toBe(triageContentSignature({ ...base, status: 'done', updated_at: '2' } as never))
    expect(triageContentSignature({ ...base, title: 'Add logout' })).not.toBe(triageContentSignature(base))
  })

  it('renders the evidence as data with the prompt version outside the prompt', () => {
    const inputs: TriageInputs = {
      promptVersion: TRIAGE_PROMPT_VERSION, ticket: triageTicketText({ title: 'x' }), repoMap: null,
      similarFiles: ['a.ts'], loops: LOOPS, engine: 'claude:haiku',
    }
    const prompt = buildTriageUserPrompt(inputs)
    expect(prompt).toContain('"filesTouchedBySimilarSpecs":["a.ts"]')
    expect(prompt).not.toContain('claude:haiku')
  })

  it('never asks the model to rank Flow against Implement', () => {
    const inputs: TriageInputs = {
      promptVersion: TRIAGE_PROMPT_VERSION, ticket: triageTicketText({ title: 'x' }), repoMap: null,
      similarFiles: [], loops: LOOPS, engine: 'claude:haiku',
    }
    expect(TRIAGE_PROMPT_VERSION).toBeGreaterThanOrEqual(2)
    expect(buildTriageSystemPrompt()).not.toMatch(/recommendedMode|flow/i)
    expect(buildTriageUserPrompt(inputs)).not.toMatch(/flow/i)
  })
})

describe('similar tickets', () => {
  it('ranks by title/label overlap, deterministic tiebreak, excludes self and zero scores', () => {
    const target = { id: 1, title: 'Rail loop selector preselection', labels: ['rails'] }
    const others = [
      { id: 1, title: 'Rail loop selector preselection', labels: ['rails'] },
      { id: 4, title: 'Unrelated billing export', labels: [] },
      { id: 3, title: 'Rail selector polish', labels: ['rails'] },
      { id: 2, title: 'Rail selector polish', labels: ['rails'] },
    ]
    expect(similarTicketIds(target, others)).toEqual([2, 3])
  })

  it('ranks files by frequency then path', () => {
    expect(rankFiles(['b', 'a', 'b', 'c', 'a', 'b'], 2)).toEqual(['b', 'a'])
  })
})

describe('parseTriageOutput', () => {
  const opts = { loops: LOOPS }

  it('parses a clean answer', () => {
    const parsed = parseTriageOutput(JSON.stringify({
      size: 'S', filesLikely: ['server/a.ts'], publicInterfaces: false, dataModel: false, securitySurface: false,
      recommendedLoop: 'factory:sdd-quick-openspec', recommendedMode: 'implement', rationale: 'Single file', confidence: 'high',
    }), opts)
    expect(parsed).toMatchObject({ ok: true, repaired: false, value: { size: 'S', recommendedLoop: 'factory:sdd-quick-openspec', recommendedLoopName: 'Quick SDD', confidence: 'high' } })
  })

  it('repairs fenced JSON, lowercase size, string booleans, bad paths and an unknown loop', () => {
    const text = 'Here you go:\n```json\n{"size":"xs","filesLikely":["/etc/passwd","../x","./ok.ts"],"dataModel":"yes","recommendedLoop":"loop:ghost","recommendedMode":"flow","confidence":"HIGH","rationale":"a {brace} \\"quoted\\""}\n```'
    const parsed = parseTriageOutput(text, opts)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.repaired).toBe(true)
    expect(parsed.value).toMatchObject({
      size: 'XS', filesLikely: ['ok.ts'], dataModel: true, publicInterfaces: false,
      recommendedLoop: 'factory:sdd-quick-openspec', confidence: 'low',
      rationale: 'a {brace} "quoted"',
    })
  })

  it('ignores a stray mode: Flow and Implement never compete', () => {
    const answer = JSON.stringify({ size: 'M', recommendedLoop: 'factory:implement', recommendedMode: 'flow', confidence: 'medium' })
    const parsed = parseTriageOutput(answer, opts)
    expect(parsed).toMatchObject({ ok: true, repaired: false, value: { recommendedLoop: 'factory:implement' } })
    if (parsed.ok) expect(parsed.value).not.toHaveProperty('recommendedMode')
  })

  it('fails without a JSON object or with an invalid size', () => {
    expect(parseTriageOutput('no json here', opts)).toEqual({ ok: false, error: 'no_json_object' })
    expect(parseTriageOutput('{"size": "huge"}', opts)).toEqual({ ok: false, error: 'invalid_size' })
    expect(parseTriageOutput('{"size": ', opts)).toEqual({ ok: false, error: 'no_json_object' })
  })

  it('falls back by size', () => {
    expect(fallbackLoop('S', LOOPS)).toBe('factory:sdd-quick-openspec')
    expect(fallbackLoop('L', LOOPS)).toBe('factory:implement')
    expect(fallbackLoop('XS', [LOOPS[0]])).toBe('factory:implement')
    expect(fallbackLoop('XS', [])).toBeNull()
  })

  it('extracts the first balanced object', () => {
    expect(extractJsonObject('x {"a":{"b":"}"}} y {"c":1}')).toBe('{"a":{"b":"}"}}')
  })

  it('sanitises paths', () => {
    expect(sanitizeFilePath('C:\\win\\a')).toBeNull()
    expect(sanitizeFilePath('src\\a.ts')).toBe('src/a.ts')
    expect(sanitizeFilePath(42)).toBeNull()
  })
})

describe('recommendation and accuracy', () => {
  it('recommends the first ready triage in rail order', () => {
    expect(recommendedLoopForTickets([
      undefined,
      { metadata: { triage: { status: 'unavailable', reason: 'x', inputsHash: 'h', computedAt: 't' } } },
      { metadata: { triage: ready('factory:implement') } },
      { metadata: { triage: ready('factory:sdd-quick-openspec') } },
    ])).toBe('factory:implement')
    expect(recommendedLoopForTickets([{ metadata: {} }])).toBeNull()
  })

  it('validates persisted records', () => {
    expect(isTicketTriage(ready('a'))).toBe(true)
    expect(isTicketTriage({ ...ready('a'), size: 'XXL' })).toBe(false)
    expect(isTicketTriage({ status: 'failed', error: 'e', inputsHash: 'h', computedAt: 't' })).toBe(true)
    expect(isTicketTriage(null)).toBe(false)
  })

  it('computes matched/total over launches with a recommendation', () => {
    expect(triageAccuracy([
      { recommendedLoop: 'a', chosenLoop: 'a' },
      { recommendedLoop: 'a', chosenLoop: 'b' },
      { recommendedLoop: null, chosenLoop: 'b' },
    ])).toEqual({ total: 2, matched: 1, rate: 0.5 })
    expect(triageAccuracy([])).toEqual({ total: 0, matched: 0, rate: null })
  })
})
