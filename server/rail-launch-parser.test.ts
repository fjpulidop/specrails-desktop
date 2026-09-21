import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { extractRailLaunchProposals, coerceRailLaunchProposal, looksLikeRailLaunch } from './rail-launch-parser'
import { promoteAgentProtocolFences } from './agent-fence-promotion'

const block = (obj: unknown) => '```rail-launch\n' + JSON.stringify(obj) + '\n```'

describe('extractRailLaunchProposals', () => {
  it('parses a full proposal, strips the fence and keeps the prose', () => {
    const text = 'I suggest this:\n' + block({
      version: 1, railIndex: 1, ticketIds: [12, '#14'], mode: 'implement', aiEngine: 'claude', model: 'opus',
      reasoning_effort: 'high', profileName: 'fast', loopId: 'factory:implement', targetPrNumber: 7, baseBranch: 'main',
      railName: 'Auth', rationale: 'both touch auth', ignored: true,
    }) + '\nShall I?'
    const out = extractRailLaunchProposals(text)
    expect(out.body).toBe('I suggest this:\n\nShall I?')
    expect(out.rejected).toEqual([])
    expect(out.proposals).toHaveLength(1)
    const p = out.proposals[0]
    expect(p).toEqual({
      version: 1, railIndex: 1, newRail: null, ticketIds: [12, 14], mode: 'implement', loopId: 'factory:implement',
      aiEngine: 'claude', model: 'opus', reasoningEffort: 'high', profileName: 'fast', targetPrNumber: 7,
      baseBranch: 'main', railName: 'Auth', rationale: 'both touch auth', followUp: null,
    })
    expect('ignored' in p).toBe(false)
  })

  it('defaults mode, accepts batch alias and newRail, drops railIndex when newRail is set', () => {
    const out = extractRailLaunchProposals(block({ ticketIds: [3], newRail: { name: 'Fresh' }, railIndex: 4, mode: 'batch' }))
    expect(out.proposals[0].mode).toBe('batch-implement')
    expect(out.proposals[0].newRail).toEqual({ name: 'Fresh' })
    expect(out.proposals[0].railIndex).toBeNull()
    expect(extractRailLaunchProposals(block({ ticketIds: [3], newRail: true })).proposals[0].newRail).toEqual({ name: null })
    expect(extractRailLaunchProposals(block({ specs: ['#5'] })).proposals[0]).toMatchObject({ mode: 'implement', ticketIds: [5], railIndex: null })
  })

  it('keeps every valid block in order (one card per block)', () => {
    const out = extractRailLaunchProposals(block({ ticketIds: [1] }) + '\n' + block({ ticketIds: [2], railIndex: 0 }))
    expect(out.proposals.map((p) => p.ticketIds)).toEqual([[1], [2]])
  })

  it('reports rejected blocks instead of dropping them silently', () => {
    const out = extractRailLaunchProposals(
      block({ ticketIds: [] }) + block([1, 2]) + block({ ticketIds: [1], version: 9 }) + block({ ticketIds: [1], mode: 'yolo' }) + '```rail-launch\n{not json\n```',
    )
    expect(out.proposals).toEqual([])
    expect(out.rejected.map((r) => r.reason)).toEqual(['no_tickets', 'not_object', 'unsupported_version', 'invalid_mode', 'invalid_json'])
    expect(out.rejected[4].excerpt).toContain('{not json')
    expect(out.body).toBe('')
  })

  it('repairs small-model JSON (trailing commas, comments) and flags it', () => {
    const out = extractRailLaunchProposals('```rail-launch\n{ "ticketIds": [1, 2,], // both\n "mode": "freestyle", }\n```')
    expect(out.proposals[0]).toMatchObject({ ticketIds: [1, 2], mode: 'freestyle' })
    expect(out.repaired).toBe(true)
  })

  it('cuts an open fence while streaming and marks pending', () => {
    const out = extractRailLaunchProposals('Plan:\n```rail-launch\n{"ticketIds": [1', true)
    expect(out.body).toBe('Plan:')
    expect(out.pending).toBe(true)
    expect(out.truncated).toBe(false)
    expect(out.proposals).toEqual([])
  })

  it('accepts a lenient tail (closing fence dropped) and reports truncation when settled + unreadable', () => {
    const ok = extractRailLaunchProposals('```rail-launch\n{"ticketIds": [9]}')
    expect(ok.proposals[0].ticketIds).toEqual([9])
    expect(ok.truncated).toBe(false)
    const bad = extractRailLaunchProposals('```rail-launch\n{"ticketIds": [9')
    expect(bad.truncated).toBe(true)
    expect(bad.rejected[0].reason).toBe('invalid_json')
    expect(bad.body).toBe('')
  })

  it('is a no-op without the fence', () => {
    expect(extractRailLaunchProposals('plain text')).toMatchObject({ body: 'plain text', proposals: [], rejected: [], pending: false })
    expect(extractRailLaunchProposals('')).toMatchObject({ body: '', proposals: [] })
  })

  it('coerces odd but honest inputs', () => {
    expect(coerceRailLaunchProposal(null)).toEqual({ ok: false, reason: 'not_object' })
    const r = coerceRailLaunchProposal({ ticketIds: ['12', 12, 'x', -1, 3.5], railIndex: '2', targetPrNumber: 0, effort: 'max', name: '  Named  ' })
    expect(r.ok && r.proposal).toMatchObject({ ticketIds: [12], railIndex: 2, targetPrNumber: null, reasoningEffort: 'max', railName: 'Named' })
  })
})

describe('generic-fence promotion for rail-launch', () => {
  it('re-tags a ```json launch-shaped object and leaves spec drafts alone', () => {
    const body = JSON.stringify({ ticketIds: [1], railIndex: 0 })
    expect(promoteAgentProtocolFences('```json\n' + body + '\n```')).toContain('```rail-launch\n')
    const draft = JSON.stringify({ title: 'T', description: 'D', labels: [], ticketIds: [1], mode: 'implement' })
    expect(promoteAgentProtocolFences('```json\n' + draft + '\n```')).toContain('```spec-draft\n')
    expect(looksLikeRailLaunch({ ticketIds: [] })).toBe(false)
    expect(looksLikeRailLaunch({ ticketIds: [1] })).toBe(false)
    expect(looksLikeRailLaunch({ ticketIds: [1], loopId: 'x' })).toBe(true)
  })
})

describe('client mirror parity', () => {
  it('client/src/lib/rail-launch-draft.ts is byte-identical except for the mirror note', () => {
    const server = fs.readFileSync(path.join(__dirname, 'rail-launch-parser.ts'), 'utf8')
    const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'lib', 'rail-launch-draft.ts'), 'utf8')
    const norm = (s: string) => s.replace(/lives at [^\n]+ and MUST stay byte-identical/, 'MIRROR')
    expect(norm(client)).toBe(norm(server))
  })
})

describe('followUp on a proposal (pr-follow-up-fixes)', () => {
  it('keeps a valid follow-up scope (ids assigned, provenance kept) and drops an invalid one to null without rejecting the card', () => {
    const valid = extractRailLaunchProposals(block({ ticketIds: [191], mode: 'loop', loopId: 'factory:sdd-quick-openspec', targetPrNumber: 51,
      followUp: { comments: [{ path: 'lib/api.ts', body: 'send Idempotency-Key per pair' }], scope: { excludedChanges: ['UI changes'] }, openspecChangeName: 'fix-comments' } }))
    expect(valid.proposals[0].followUp).toMatchObject({ kind: 'pr-review-fix', openspecChangeName: 'fix-comments', scope: { excludedChanges: ['UI changes'] } })
    expect(valid.proposals[0].followUp!.comments[0]).toMatchObject({ id: 'c1', source: 'user-paste', path: 'lib/api.ts' })
    const invalid = extractRailLaunchProposals(block({ ticketIds: [191], targetPrNumber: 51, followUp: { comments: [] } }))
    expect(invalid.rejected).toEqual([])
    expect(invalid.proposals[0].followUp).toBeNull()
  })

  it('client/src/lib/pr-follow-up-scope.ts is byte-identical to server/pr-follow-up-scope.ts except for the mirror note', () => {
    const server = fs.readFileSync(path.join(__dirname, 'pr-follow-up-scope.ts'), 'utf8')
    const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'lib', 'pr-follow-up-scope.ts'), 'utf8')
    const norm = (text: string) => text.replace(/(client|server) copy lives at\n\/\/ [^\n]+ and MUST stay byte-identical/, 'MIRROR')
    expect(norm(client)).toBe(norm(server))
  })
})
