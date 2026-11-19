import { describe, expect, it } from 'vitest'
import i18n from '../../../lib/i18n'
import { inboxItemText } from '../lib/inbox-item-text'
import { inboxAttentionText } from '../hooks/useInboxAttention'
import type { InboxItem } from '../lib/inbox-model'

const mk = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'p1:review:d1', projectId: 'p1', projectName: 'Alpha', kind: 'review', title: 'Add login', detail: null,
  at: new Date().toISOString(), version: 'v', action: 'open-review', subjectId: 'd1', conversationId: null, diagnosis: null, cap: null, ...over,
})
const text = (item: InboxItem) => inboxItemText(item, i18n.t.bind(i18n), 'en')

describe('inboxItemText: attempt chains', () => {
  it('names the attempt of a continued run', () => {
    expect(text(mk({ title: 'Implement · #14', attempt: { number: 3, of: 3 } })).title).toBe('Implement · #14 · attempt 3')
    expect(text(mk({ title: 'Implement · #14' })).title).toBe('Implement · #14')
  })
})

describe('one wording per inbox item (row, live board card, notification)', () => {
  it('names a reached cap by the cap, with its figures, and says the work is paused', () => {
    const cap = mk({ id: 'p1:budget:cap', kind: 'budget', action: 'raise-cap', title: 'Daily cap reached', cap: { scope: 'project', period: 'day', budgetUsd: 5, spentUsd: 5.12, resetsAt: '' } })
    expect(text(cap)).toEqual({ title: 'Project daily limit reached', kindLabel: 'Work paused', detail: '$5.12 of $5.00 spent', rawDetail: null })
    // The notification says the same words, never the server's raw title.
    expect(inboxAttentionText(cap)).toEqual({ title: 'Work paused', body: 'Alpha · Project daily limit reached · $5.12 of $5.00 spent' })
  })

  it('names a provider usage-limit pause by that limit and says when it continues', () => {
    const resumeAt = new Date(Date.now() + 60 * 60_000).toISOString()
    const paused = mk({ kind: 'budget', action: 'resume-run', title: 'Loop "Implement" paused', detail: `usage_limit:claude:${resumeAt}` })
    const words = text(paused)
    expect(words.kindLabel).toBe('Paused at the Claude usage limit')
    expect(words.detail).toMatch(/^Continues on its own at .+[^.]$/)
    expect(text({ ...paused, detail: 'usage_limit:claude:' }).detail).toBeNull()
    expect(inboxAttentionText(paused)).toEqual({ title: words.kindLabel, body: `Alpha · Loop "Implement" paused · ${words.detail}` })
  })

  it('says a failure without a known cause in the app\'s words and keeps the raw outcome for a hover', () => {
    const failed = mk({ kind: 'failed', action: 'open-run', title: 'Rail 2 · #2', detail: 'implementation_failed' })
    expect(text(failed)).toMatchObject({ kindLabel: 'Failed', detail: 'Stopped before delivery', rawDetail: 'implementation_failed' })
    expect(inboxAttentionText(failed).body).toBe('Alpha · Rail 2 · #2 · Stopped before delivery')
  })

  it('keeps the server detail of a question (the question itself)', () => {
    const question = mk({ kind: 'question', action: 'open-run', title: 'Split check', detail: 'Every 10 lines or 8?' })
    expect(text(question)).toMatchObject({ kindLabel: 'Needs you', detail: 'Every 10 lines or 8?' })
  })
})
