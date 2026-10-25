import { describe, expect, it } from 'vitest'
import {
  FLOW_SUMMARY_LIMIT_BYTES, buildFlowSummary, buildSpecRewriteText, extractFlowDecisions, flowEffectKey, flowJiraCreateKey, nextDueEffect, summarizeSettlement,
} from '..'
import { FLOW_SPEC_SEED_LIMIT, ORIGINAL_SPEC_COMMENT_HEADING, buildOriginalSpecComment, buildSpecSeedBriefing, failedAttempt, finishedEffect, flowJiraUpdateKey, inFlowWindow, plannedSettlementEffects, replyFirstLine, settlementRetryAt, timestampMs } from '../domain'

const NOW = '2026-10-21T10:00:00.000Z'
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

describe('Flow conversation summary', () => {
  const messages = [
    { role: 'user', content: 'Build a kanban board' },
    { role: 'assistant', content: 'Working on it.\nDecision: columns are fixed (todo, doing, done)\n**Decision:** drag and drop uses the native API' },
    { role: 'tool', content: 'npm test output' },
    { role: 'user', content: 'Make cards editable' },
    { role: 'assistant', content: 'Decision: columns are fixed (todo, doing, done)' },
  ]

  it('keeps the idea, user messages, the first line of each final reply and decisions, with transcriptTurns front matter', () => {
    const summary = buildFlowSummary({ idea: 'Kanban', messages })
    expect(summary.startsWith('---\ntranscriptTurns: 2\n---\n')).toBe(true)
    expect(summary).toContain('## Idea\n\nKanban')
    expect(summary).toContain('1. Build a kanban board\n   ↳ Agent: Working on it.')
    expect(summary).toContain('2. Make cards editable')
    // A reply made only of decision lines adds no first line (the decision is listed once).
    expect(summary).not.toContain('2. Make cards editable\n   ↳')
    expect(summary).not.toContain('npm test output')
    expect(extractFlowDecisions(messages)).toEqual(['columns are fixed (todo, doing, done)', 'drag and drop uses the native API'])
  })

  it('keeps the agent\'s FINAL reply of each turn and leaves automated briefings out', () => {
    const summary = buildFlowSummary({ idea: null, messages: [
      { role: 'user', content: 'Add more effects' },
      { role: 'assistant', content: 'Looking at the code first.' },
      { role: 'assistant', content: '## Plan\n\nI added 27 effects, each toggleable in Options.' },
      { role: 'user', content: '[Specrails run-failure briefing — automatic]', automated: true },
      { role: 'assistant', content: 'The run failed while deriving the spec.' },
    ] })
    expect(summary).toContain('transcriptTurns: 1')
    expect(summary).toContain('1. Add more effects\n   ↳ Agent: Plan')
    expect(summary).not.toContain('briefing')
    expect(summary).not.toContain('Looking at the code first')
  })

  it('takes the first prose line of a reply, skipping fences and decisions, bounded', () => {
    expect(replyFirstLine('```ts\ncode\n```')).toBe('code')
    expect(replyFirstLine('Decision: x\n\n- **Done**: the toggles work')).toBe('**Done**: the toggles work')
    expect(replyFirstLine('   \n')).toBeNull()
    expect(replyFirstLine('x'.repeat(500))!.length).toBeLessThanOrEqual(241)
  })

  it('handles an empty conversation', () => {
    const summary = buildFlowSummary({ idea: null, messages: [] })
    expect(summary).toContain('transcriptTurns: 0')
    expect(summary).toContain('(none)')
  })

  it('stays within the Core bound, dropping the oldest user messages first', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `message ${i} ` + 'ñ'.repeat(1500) }))
    const summary = buildFlowSummary({ idea: 'idea', messages: [...many, { role: 'assistant', content: 'Decision: keep me' }] })
    expect(bytes(summary)).toBeLessThanOrEqual(FLOW_SUMMARY_LIMIT_BYTES)
    expect(summary).toContain('message 99 ')
    expect(summary).not.toContain('message 0 ')
    expect(summary).toContain('- keep me')
    const turns = Number(/transcriptTurns: (\d+)/.exec(summary)![1])
    expect(turns).toBeGreaterThan(0)
    expect(turns).toBeLessThan(100)
  })

  it('cuts at the byte bound when only the idea remains too large', () => {
    const summary = buildFlowSummary({ idea: '界'.repeat(4000), messages: [] }, 600)
    expect(bytes(summary)).toBeLessThanOrEqual(600)
    expect(summary).not.toContain('�')
  })
})

describe('Flow conversation window', () => {
  it('compares SQLite and ISO timestamps as instants (the empty-summary regression)', () => {
    // Flow rows are ISO; agent_messages use datetime('now'). As strings every
    // message of the Flow's own day sorted BEFORE its start.
    expect('2026-10-22 12:49:34' >= '2026-10-22T12:49:06.950Z').toBe(false)
    expect(inFlowWindow('2026-10-22 12:49:34', '2026-10-22T12:49:06.950Z', null)).toBe(true)
    expect(inFlowWindow('2026-10-22 12:48:51', '2026-10-22T12:49:06.950Z', null)).toBe(false)
    expect(timestampMs('2026-10-22 12:49:34')).toBe(Date.parse('2026-10-22T12:49:34Z'))
  })

  it('keeps a message written in the second the Flow started, honours the end and never drops unparseable times', () => {
    expect(inFlowWindow('2026-10-22 12:49:06', '2026-10-22T12:49:06.950Z', null)).toBe(true)
    expect(inFlowWindow('2026-10-22 13:00:00', '2026-10-22T12:00:00.000Z', '2026-10-22T12:30:00.000Z')).toBe(false)
    expect(inFlowWindow('not a date', '2026-10-22T12:00:00.000Z', null)).toBe(true)
    expect(inFlowWindow('2026-10-22 13:00:00', 'garbage', null)).toBe(true)
    expect(timestampMs('2026-10-22T12:00:00+02:00')).toBe(Date.parse('2026-10-22T10:00:00Z'))
  })
})

describe('settlement plan', () => {
  it('plans the three keyed effects in order', () => {
    const effects = plannedSettlementEffects('f1', NOW)
    expect(effects.map((effect) => [effect.key, effect.seq, effect.status])).toEqual([
      ['flow:f1:rewrite-spec', 0, 'pending'], ['flow:f1:jira-create', 1, 'pending'], ['flow:f1:jira-review', 2, 'pending'],
    ])
    expect(flowEffectKey('f1', 'jira-create')).toBe('flow:f1:jira-create')
    expect(flowJiraCreateKey('f1')).toBe('flow:f1:create')
  })

  it('never lets a later effect overtake a pending earlier one', () => {
    const [rewrite, create, review] = plannedSettlementEffects('f1', NOW)
    const waiting = failedAttempt(rewrite!, 'boom', NOW)
    expect(nextDueEffect([review!, create!, waiting], NOW)).toBeNull()
    expect(nextDueEffect([review!, create!, waiting], waiting.nextAttemptAt!)?.kind).toBe('rewrite-spec')
    expect(nextDueEffect([finishedEffect(rewrite!, 'done', NOW), create!, review!], NOW)?.kind).toBe('jira-create')
    expect(nextDueEffect(plannedSettlementEffects('f1', NOW).map((effect) => finishedEffect(effect, 'skipped', NOW)), NOW)).toBeNull()
  })

  it('backs off exponentially and gives up at the attempt limit', () => {
    expect(settlementRetryAt(NOW, 1)).toBe('2026-10-21T10:00:15.000Z')
    expect(settlementRetryAt(NOW, 20)).toBe('2026-10-21T10:05:00.000Z')
    let effect = plannedSettlementEffects('f1', NOW)[0]!
    for (let i = 0; i < 3; i++) effect = failedAttempt(effect, 'x'.repeat(5000), NOW)
    expect(effect).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null })
    expect(effect.lastError).toHaveLength(2000)
    expect(summarizeSettlement([effect])).toEqual({ specRewrite: 'failed', jiraCreate: null, jiraReview: null })
  })
})

describe('spec rewrite input', () => {
  it('describes delivered work from the derived change, diffstat and conversation', () => {
    const text = buildSpecRewriteText({ title: 'Kanban', derived: { changeName: 'kanban', proposal: '## Why\nBoards', design: null, diffstat: ' a.ts | 1 +' }, summary: 'transcriptTurns: 1' })
    expect(text).toContain('ALREADY EXISTS')
    expect(text).toContain('OpenSpec change: kanban')
    expect(text).toContain('## Derived proposal (proposal.md)\n\n## Why\nBoards')
    expect(text).not.toContain('Derived design')
    expect(text).toContain('## Diffstat')
    expect(text).toContain('untrusted user input')
  })
})

describe('Flow from an existing spec: texts', () => {
  const spec = { id: 12, title: 'Calmer onboarding', description: '## Acceptance criteria\n- [ ] Progress rail\n\n## Contract Layer\n\nInputs: none', status: 'todo', nonGoals: ['No analytics'], repositoryIds: [], addenda: '## Open addenda\n\n1. [clarification] Use the brand colors' }

  it('seeds the first Flow turn with the whole spec, marked as automatic context', () => {
    const seed = buildSpecSeedBriefing(spec)
    expect(seed.startsWith('[Flow started from spec #12 — automatic context, not typed by the user]')).toBe(true)
    expect(seed).toContain('## Spec #12: Calmer onboarding')
    expect(seed).toContain('## Contract Layer')
    expect(seed).toContain('## Out of scope\n\n- No analytics')
    expect(seed).toContain('Use the brand colors')
    expect(seed).toContain('Conduct:')
    expect(buildSpecSeedBriefing({ ...spec, description: 'x'.repeat(60_000), addenda: 'y'.repeat(60_000) }).length).toBeLessThanOrEqual(FLOW_SPEC_SEED_LIMIT)
  })

  it('keeps the original spec untruncated in its comment', () => {
    const long = 'z'.repeat(50_000)
    const comment = buildOriginalSpecComment({ title: 'Calmer onboarding', description: long, nonGoals: ['No analytics'], flowId: 'flow-1' })
    expect(comment.startsWith(`## ${ORIGINAL_SPEC_COMMENT_HEADING}`)).toBe(true)
    expect(comment).toContain(long)
    expect(comment).toContain('### Out of scope\n\n- No analytics')
    expect(flowJiraUpdateKey('flow-1')).toBe('flow:flow-1:update')
  })

  it('asks the rewrite to start over from what was built, quoting the original as context only', () => {
    const text = buildSpecRewriteText({ title: 'Calmer onboarding', derived: { changeName: 'calmer', proposal: '## Why', design: null, diffstat: null }, summary: '', original: { title: 'Calmer onboarding', description: 'ORIGINAL' } })
    expect(text).toContain('Rewrite the spec ENTIRELY from what was built')
    expect(text).toContain('## Original spec before Flow (context only; the delivered code wins): Calmer onboarding\n\nORIGINAL')
    expect(buildSpecRewriteText({ title: 'X', derived: { changeName: null, proposal: 'p', design: null, diffstat: null }, summary: '' })).not.toContain('Original spec before Flow')
  })
})
