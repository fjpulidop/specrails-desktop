import { describe, expect, it } from 'vitest'
import { initDb } from '../db'
import {
  CLARIFICATION_REPLY_WINDOW_MS, buildClarificationsComment, clarificationAddendumInput, clarificationsDigest,
  importedCommentIds, insertClarificationThread, listOpenClarificationThreads, recordImportedReplies, selectClarificationReplies,
} from './jira-clarifications'

const PAUSED = {
  change: 'c', policy: 'ask-on-high', status: 'awaiting-answers' as const, recordedAt: 't',
  clarifications: [{ question: 'Q1', impact: 'high' as const, default: null }],
  blocking: [{ question: 'Q1', impact: 'high' as const, default: null }], assumptions: [],
}

describe('jira clarifications', () => {
  it('digests the record content so a different pause posts again', () => {
    expect(clarificationsDigest(PAUSED)).toBe(clarificationsDigest({ ...PAUSED, recordedAt: 'later' }))
    expect(clarificationsDigest(PAUSED)).not.toBe(clarificationsDigest({ ...PAUSED, blocking: [{ question: 'Q2', impact: 'high', default: null }] }))
  })

  it('writes questions or assumptions, falling back to the clarifications list', () => {
    expect(buildClarificationsComment(PAUSED)).toContain('1. Q1')
    expect(buildClarificationsComment({ ...PAUSED, blocking: [] })).toContain('1. Q1')
    const proceeded = buildClarificationsComment({ ...PAUSED, status: 'proceeded', blocking: [], clarifications: [{ question: 'Size?', impact: 'low', default: null }] })
    expect(proceeded).toContain('- Size? → no safe default')
  })

  it('selects human replies after the anchor only', () => {
    const marker = '[specrails:clarifications=r:ticket=1:abc]'
    const comments = [
      { id: 'a', body: 'before' },
      { id: 'b', body: `posted ${marker}` },
      { id: 'c', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ADF reply' }] }] }, created: '2026-10-22' },
      { id: 'd', body: '   ' },
      { id: 'e', body: 'already', author: { displayName: '' } },
    ]
    expect(selectClarificationReplies(comments, marker, new Set(['e']))).toEqual([{ commentId: 'c', author: null, created: '2026-10-22', text: 'ADF reply' }])
    expect(selectClarificationReplies(comments, '[specrails:other]', new Set())).toEqual([])
    const correction = clarificationAddendumInput({ commentId: 'c', author: null, created: null, text: 'No' }, null, 'assumptions')
    expect(correction).toMatchObject({ kind: 'clarification', title: 'Correction from Jira' })
  })

  it('tracks threads, closes stale ones and records imports idempotently', () => {
    const db = initDb(':memory:')
    const now = Date.parse('2026-10-22T00:00:00Z')
    expect(insertClarificationThread(db, { id: 't1', run_id: 'r', ticket_id: 1, jira_issue_id: 'I', kind: 'questions', marker: 'm', created_at: new Date(now).toISOString() })).toBe(true)
    expect(insertClarificationThread(db, { id: 't1', run_id: 'r', ticket_id: 1, jira_issue_id: 'I', kind: 'questions', marker: 'm', created_at: new Date(now).toISOString() })).toBe(false)
    insertClarificationThread(db, { id: 'old', run_id: 'r', ticket_id: 2, jira_issue_id: 'J', kind: 'assumptions', marker: 'm2', created_at: new Date(now - CLARIFICATION_REPLY_WINDOW_MS - 1).toISOString() })
    expect(listOpenClarificationThreads(db, now).map((row) => row.id)).toEqual(['t1'])
    recordImportedReplies(db, 't1', ['c1'])
    recordImportedReplies(db, 't1', ['c1', 'c2'])
    recordImportedReplies(db, 'missing', ['x'])
    const [row] = listOpenClarificationThreads(db, now)
    expect(row.state).toBe('answered')
    expect([...importedCommentIds(row)]).toEqual(['c1', 'c2'])
    expect(importedCommentIds({ imported_comment_ids: 'nope' }).size).toBe(0)
  })
})
