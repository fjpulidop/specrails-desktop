import { describe, it, expect } from 'vitest'
import { extractRailLaunchProposals, coerceRailLaunchProposal, looksLikeRailLaunch } from '../rail-launch-draft'

const block = (obj: unknown) => '```rail-launch\n' + JSON.stringify(obj) + '\n```'

describe('extractRailLaunchProposals', () => {
  it('treats a null or empty workspaceSelection and a null repositoryIds as omitted, as Codex emits them', () => {
    for (const [repositoryIds, workspaceSelection] of [[null, null], [undefined, {}], [null, {}]] as const) {
      const result = coerceRailLaunchProposal({ ticketIds: [9], railIndex: 0, mode: 'implement', aiEngine: 'codex', repositoryIds, workspaceSelection })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.proposal.repositoryIds).toBeUndefined()
        expect(result.proposal.workspaceSelection).toBeUndefined()
      }
    }
    const filled = coerceRailLaunchProposal({ ticketIds: [9], repositoryIds: ['primary-1'], workspaceSelection: {} })
    expect(filled.ok && filled.proposal.repositoryIds).toEqual(['primary-1'])
    expect(coerceRailLaunchProposal({ ticketIds: [9], repositoryIds: [] }).ok).toBe(false)
  })

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

  it('defaults mode, folds removed batch aliases into implement, accepts newRail, drops railIndex when newRail is set', () => {
    const out = extractRailLaunchProposals(block({ ticketIds: [3], newRail: { name: 'Fresh' }, railIndex: 4, mode: 'batch' }))
    expect(out.proposals[0].mode).toBe('implement')
    expect(extractRailLaunchProposals(block({ ticketIds: [3], mode: 'batch-implement' })).proposals[0].mode).toBe('implement')
    expect(extractRailLaunchProposals(block({ ticketIds: [3], mode: 'batch_implement' })).proposals[0].mode).toBe('implement')
    expect(out.proposals[0].newRail).toEqual({ name: 'Fresh' })
    expect(out.proposals[0].railIndex).toBeNull()
    expect(extractRailLaunchProposals(block({ ticketIds: [3], newRail: true })).proposals[0].newRail).toEqual({ name: null })
    expect(extractRailLaunchProposals(block({ specs: ['#5'] })).proposals[0]).toMatchObject({ mode: 'implement', ticketIds: [5], railIndex: null })
  })

  it.each(['freestyle', 'ultracode', 'Freestyle'])('reads the retired %s mode as Implement so a stored card still renders and launches', (mode) => {
    const out = extractRailLaunchProposals(block({ ticketIds: [3], mode }))
    expect(out.rejected).toEqual([])
    expect(out.proposals[0]).toMatchObject({ mode: 'implement', loopId: null })
  })

  it.each(['factory:freestyle', 'factory:sdd-quick-openspec', 'factory:openspec', 'factory:revision'])('drops the retired loop id %s and falls back to Implement', (loopId) => {
    for (const mode of ['loop', 'implement']) {
      const out = extractRailLaunchProposals(block({ ticketIds: [3], mode, loopId }))
      expect(out.proposals[0]).toMatchObject({ mode: 'implement', loopId: null })
    }
    // A custom loop id and Implement are untouched.
    expect(extractRailLaunchProposals(block({ ticketIds: [3], mode: 'loop', loopId: 'abc123' })).proposals[0]).toMatchObject({ mode: 'loop', loopId: 'abc123' })
    expect(extractRailLaunchProposals(block({ ticketIds: [3], mode: 'implement', loopId: 'factory:implement' })).proposals[0]).toMatchObject({ mode: 'implement', loopId: 'factory:implement' })
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
    expect(out.proposals[0]).toMatchObject({ ticketIds: [1, 2], mode: 'implement' }) // retired freestyle folds to Implement
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

describe('looksLikeRailLaunch (generic-fence promotion shape)', () => {
  it('requires a ticket list plus a rail/launch key', () => {
    expect(looksLikeRailLaunch({ ticketIds: [] })).toBe(false)
    expect(looksLikeRailLaunch({ ticketIds: [1] })).toBe(false)
    expect(looksLikeRailLaunch({ ticketIds: [1], loopId: 'x' })).toBe(true)
  })
})

describe('followUp on a proposal (pr-follow-up-fixes)', () => {
  it('keeps a valid follow-up scope (ids assigned, provenance kept) and drops an invalid one to null without rejecting the card', () => {
    const valid = extractRailLaunchProposals(block({ ticketIds: [191], mode: 'loop', loopId: 'gallery-loop-1', targetPrNumber: 51,
      followUp: { comments: [{ path: 'lib/api.ts', body: 'send Idempotency-Key per pair' }], scope: { excludedChanges: ['UI changes'] }, openspecChangeName: 'fix-comments' } }))
    expect(valid.proposals[0].followUp).toMatchObject({ kind: 'pr-review-fix', openspecChangeName: 'fix-comments', scope: { excludedChanges: ['UI changes'] } })
    expect(valid.proposals[0].followUp!.comments[0]).toMatchObject({ id: 'c1', source: 'user-paste', path: 'lib/api.ts' })
    const invalid = extractRailLaunchProposals(block({ ticketIds: [191], targetPrNumber: 51, followUp: { comments: [] } }))
    expect(invalid.rejected).toEqual([])
    expect(invalid.proposals[0].followUp).toBeNull()
  })
})

it('preserves workspace selections and rejects malformed selections without broadening scope', () => {
  const base = { ticketIds: [1], mode: 'implement', railIndex: 0, repositoryIds: ['skills'] }
  expect(extractRailLaunchProposals(block({ ...base, workspaceSelection: { skills: ['/skills/studio'] } })).proposals[0]).toMatchObject({ repositoryIds: ['skills'], workspaceSelection: { skills: ['/skills/studio'] } })
  for (const workspaceSelection of [{ skills: [] }, { skills: [1] }, [], 'studio']) expect(extractRailLaunchProposals(block({ ...base, workspaceSelection })).proposals).toHaveLength(0)
})
