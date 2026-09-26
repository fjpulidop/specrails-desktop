import { describe, expect, it } from 'vitest'
import { validateDefinitionResumeControls as validate } from './loop-definition-controls'
import type { DefinitionRunProbe } from './loop-definition-recovery'

const probe: DefinitionRunProbe = {
  runId: 'run', engineVersion: 2, status: 'paused', resumable: true, lease: null,
  recoverableSteps: [{ attemptId: 'attempt-3', nodePath: 'write', scopeId: 'branch-a' }],
  pendingInterrupts: [{ id: 'question-2', kind: 'question', nodePath: 'ask' }, { id: 'approval-1', kind: 'approval', nodePath: 'write' }],
  completion: null, coreRevision: 4, eventCursor: 12, probedAt: '2026-09-26T12:00:00Z',
}
describe('definition resume controls', () => {
  it('resolves one pending question and retains exact attempt identities', () => {
    expect(validate({ answer: 'yes', recover: ['attempt-3'] }, probe)).toEqual({ answer: 'yes', interruptId: 'question-2', recover: ['attempt-3'] })
    expect(validate({ approve: ['approval-1'] }, probe)).toEqual({ approve: ['approval-1'] })
  })
  it('requires explicit selection when questions share a node', () => {
    const multiple = { ...probe, pendingInterrupts: [...probe.pendingInterrupts, { id: 'question-3', kind: 'question' as const, nodePath: 'ask' }] }
    expect(() => validate({ answer: 'yes' }, multiple)).toThrow('exact pending question')
    expect(validate({ answer: 'yes', interruptId: 'question-3' }, multiple).interruptId).toBe('question-3')
  })
  it.each([
    { recover: ['write'] }, { recover: ['attempt-3', 'attempt-3'] },
    { answer: 'yes', approve: ['approval-1'] }, { approve: ['question-2'] }, { approve: ['expired'] },
    { answer: 'yes', interruptId: 'approval-1' }, { interruptId: 'question-2' },
    { interruptId: 'expired', answer: 'yes' }, { answer: 'x'.repeat(20_001) },
    { recover: 'attempt-3' }, { approve: [null] }, { answer: 1 }, { force: true }, null, [],
  ])('rejects stale, ambiguous or malformed controls %j', body => {
    expect(() => validate(body, probe)).toThrow()
  })
})
