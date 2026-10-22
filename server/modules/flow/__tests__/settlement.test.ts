import { describe, expect, it } from 'vitest'
import {
  FLOW_SUMMARY_LIMIT_BYTES, buildFlowSummary, buildSpecRewriteText, extractFlowDecisions, flowEffectKey, flowJiraCreateKey, nextDueEffect, summarizeSettlement,
} from '..'
import { failedAttempt, finishedEffect, plannedSettlementEffects, settlementRetryAt } from '../domain'

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

  it('keeps the idea, user messages and decisions only, with transcriptTurns front matter', () => {
    const summary = buildFlowSummary({ idea: 'Kanban', messages })
    expect(summary.startsWith('---\ntranscriptTurns: 2\n---\n')).toBe(true)
    expect(summary).toContain('## Idea\n\nKanban')
    expect(summary).toContain('1. Build a kanban board')
    expect(summary).toContain('2. Make cards editable')
    expect(summary).not.toContain('Working on it')
    expect(summary).not.toContain('npm test output')
    expect(extractFlowDecisions(messages)).toEqual(['columns are fixed (todo, doing, done)', 'drag and drop uses the native API'])
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
