import { describe, it, expect } from 'vitest'
import { INBOX_KIND_RUN_STATE, inboxItemRunState, inboxKindRunState } from '../lib/inbox-run-state'
import type { InboxKind } from '../lib/inbox-model'

describe('inbox kind → run state', () => {
  it('maps every kind', () => {
    const expected: Record<InboxKind, string> = {
      question: 'needs-input', review: 'review', failed: 'failed', blocked: 'blocked', budget: 'paused', jira: 'blocked', chain: 'paused', mission: 'needs-input',
    }
    expect(INBOX_KIND_RUN_STATE).toEqual(expected)
    expect(inboxKindRunState('question')).toBe('needs-input')
  })

  it('reads a provider usage limit as blocked, like the run window, and a spend cap as paused', () => {
    expect(inboxItemRunState({ kind: 'budget', detail: 'usage_limit:claude:2026-11-23T02:00:00Z' })).toBe('blocked')
    expect(inboxItemRunState({ kind: 'budget', detail: 'usage_limit:claude:' })).toBe('blocked')
    expect(inboxItemRunState({ kind: 'budget', detail: null })).toBe('paused')
    expect(inboxItemRunState({ kind: 'blocked', detail: 'held:pausedByYou' })).toBe('paused')
  })
})
