import { describe, it, expect } from 'vitest'
import { INBOX_KIND_RUN_STATE, inboxKindRunState } from '../lib/inbox-run-state'
import type { InboxKind } from '../lib/inbox-model'

describe('inbox kind → run state', () => {
  it('maps every kind', () => {
    const expected: Record<InboxKind, string> = {
      question: 'needs-input', review: 'review', failed: 'failed', blocked: 'blocked', budget: 'paused', jira: 'blocked', chain: 'paused', mission: 'needs-input',
    }
    expect(INBOX_KIND_RUN_STATE).toEqual(expected)
    expect(inboxKindRunState('question')).toBe('needs-input')
  })
})
