import { describe, expect, it } from 'vitest'
import { classifyMessage, compactQuestion, signatureOf } from '../domain'

const question = {
  interruptId: 'int-1', kind: 'question', asker: 'planner', text: 'Which database should the API use?',
  options: [{ id: 'pg', label: 'PostgreSQL' }, { id: 'sqlite', label: 'SQLite' }], recommended: 'pg', endsRun: [], mayEndRun: false, canReject: false,
}

describe('classifyMessage', () => {
  it('ignores stream frames, unknown and malformed messages', () => {
    for (const msg of [null, 42, 'x', {}, { type: 'log', line: 'x' }, { type: 'agent_stream', delta: 'x' }, { type: 'event', jobId: 'j', event_type: 'step_started' }, { type: 'rail.job_started' }]) {
      expect(classifyMessage(msg)).toEqual([])
    }
  })

  it('records run lifecycle transitions with settled and failure attention', () => {
    expect(classifyMessage({ type: 'rail.job_started', projectId: 'p1', railIndex: 0, jobId: 'j1', mode: 'implement' })[0])
      .toMatchObject({ projectId: 'p1', refKind: 'run', refId: 'j1', kind: 'run.status', status: 'running', settled: false, attention: null, data: { railIndex: 0 } })
    expect(classifyMessage({ type: 'rail.job_completed', projectId: 'p1', railIndex: 0, jobId: 'j1', status: 'failed', ticketIds: [3] })[0])
      .toMatchObject({ status: 'failed', settled: true, attention: 'failed', data: { ticketIds: [3] } })
    expect(classifyMessage({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'j2', railIndex: null, status: 'completed', ticketIds: [] })[0])
      .toMatchObject({ refId: 'j2', status: 'completed', settled: true, attention: null })
    expect(classifyMessage({ type: 'rail.job_stopped', projectId: 'p1', railIndex: 1, jobId: 'j3' })[0]).toMatchObject({ status: 'canceled', settled: true })
    expect(classifyMessage({ type: 'job.finalized', projectId: 'p1', jobId: 'j4', status: 'zombie_terminated', totals: {} })[0]).toMatchObject({ settled: true, attention: 'failed' })
  })

  it('turns questions and approvals into needs-you holds carrying the compact question', () => {
    const [paused] = classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r1', railIndex: 0, reason: 'question', ticketIds: [], question })
    expect(paused).toMatchObject({ refKind: 'run', kind: 'run.hold', hold: 'question', attention: 'question', detail: question.text })
    expect(paused.data?.question).toEqual({ interruptId: 'int-1', kind: 'question', text: question.text, options: [{ id: 'pg', label: 'PostgreSQL' }, { id: 'sqlite', label: 'SQLite' }], recommended: 'pg' })
    const [gate] = classifyMessage({ type: 'job.interactive', projectId: 'p1', jobId: 'j1', acceptingTurns: true, settleMode: 'auto', timestamp: 't', pendingInterrupts: [{ id: 'g', nodePath: 'x', kind: 'gate' }] })
    expect(gate).toMatchObject({ hold: 'approval', attention: 'approval' })
    const [cleared] = classifyMessage({ type: 'job.interactive', projectId: 'p1', jobId: 'j1', acceptingTurns: false, settleMode: 'auto', timestamp: 't' })
    expect(cleared).toMatchObject({ hold: null, attention: null, status: 'running' })
  })

  it('classifies budget, provider limit, user pause, queue wait and stuck steps', () => {
    expect(classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r', reason: 'cap', pauseKind: 'budget_paused', budget: { scope: 'desktop', budgetUsd: 5, spentUsd: 5.2, resetsAt: null }, ticketIds: [], railIndex: 0 })[0])
      .toMatchObject({ hold: 'budget', attention: 'budget', data: { scope: 'desktop', budgetUsd: 5, spentUsd: 5.2 } })
    expect(classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r', reason: 'limit', pauseKind: 'limit_paused', limit: { providerId: 'claude', resumeAt: '2026-11-21T22:00:00Z', autoResume: true, message: 'Session limit', pausedAt: 'x', switchable: true }, ticketIds: [], railIndex: 0 })[0])
      .toMatchObject({ hold: 'provider_limit', attention: 'blocked', detail: 'Session limit', data: { resumeAt: '2026-11-21T22:00:00Z' } })
    expect(classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r', reason: 'paused by you', pauseKind: 'user_paused', ticketIds: [], railIndex: 0 })[0])
      .toMatchObject({ hold: 'paused', attention: null })
    expect(classifyMessage({ type: 'loop.run_queued', projectId: 'p1', loopRunId: 'r', railIndex: 0, waitingFor: 'run_slots', position: 2 })[0])
      .toMatchObject({ status: 'queued', hold: 'queued', data: { waitingFor: 'run_slots' } })
    expect(classifyMessage({ type: 'job.stuck', projectId: 'p1', jobId: 'j', stepKey: 'build', staleMs: 600_000, timestamp: 't' })[0])
      .toMatchObject({ hold: 'stuck', attention: 'blocked', detail: 'build · 10 min' })
    expect(classifyMessage({ type: 'loop.provider_limit', projectId: 'p1', runId: 'r9', provider: 'codex', kind: 'quota', message: 'Quota', resetsAt: 'z', timestamp: 't' })[0])
      .toMatchObject({ refId: 'r9', hold: 'provider_limit', data: { resumeAt: 'z' } })
  })

  it('only takes active jobs from the queue snapshot', () => {
    const drafts = classifyMessage({ type: 'queue', projectId: 'p1', activeJobId: null, paused: false, timestamp: 't', jobs: [{ id: 'a', status: 'queued' }, { id: 'b', status: 'running' }, { id: 'c', status: 'completed' }] })
    expect(drafts.map((d) => [d.refId, d.status, d.hold])).toEqual([['a', 'queued', 'queued'], ['b', 'running', null]])
  })

  it('records delivery decisions, chains, Intent sessions and specs', () => {
    expect(classifyMessage({ type: 'rail.pr_state', projectId: 'p1', railIndex: 0, prDeliveryId: 'd1', railKey: 'k', ticketIds: [1], baseBranch: 'main', branch: 'feat/x', prUrl: null, prNumber: null, prState: 'local-only', decision: 'on_review' })[0])
      .toMatchObject({ refKind: 'delivery', refId: 'd1', status: 'on_review', attention: 'review', settled: true, title: 'feat/x' })
    expect(classifyMessage({ type: 'rail.pr_state', projectId: 'p1', prDeliveryId: 'd1', decision: 'building' })[0]).toMatchObject({ settled: false, attention: null })
    expect(classifyMessage({ type: 'agent_pr_decision', conversationId: 'c', projectId: 'p1', prDeliveryId: 'd1', decision: 'pr_failed', statusCode: 'push_rejected' })[0])
      .toMatchObject({ refKind: 'delivery', attention: 'failed', detail: 'push_rejected' })
    expect(classifyMessage({ type: 'milestone.chain_changed', projectId: 'p1', timestamp: 't', chain: { id: 'ch1', milestoneN: 2, status: 'awaiting_approval', nextChunk: 1, totalChunks: 3, pauseReason: null } })[0])
      .toMatchObject({ refKind: 'chain', refId: 'ch1', attention: 'approval', settled: true, title: 'M2 · 1/3' })
    expect(classifyMessage({ type: 'flow.state', projectId: 'p1', conversationId: 'c', flowId: 'f1', timestamp: 't', flow: { id: 'f1', state: 'needs-review', branch: 'intent/x' } })[0])
      .toMatchObject({ refKind: 'intent', attention: 'review', settled: true })
    expect(classifyMessage({ type: 'ticket_updated', projectId: 'p1', timestamp: 't', ticket: { id: 14, status: 'done', title: 'Add login' } })[0])
      .toMatchObject({ refKind: 'spec', refId: '14', status: 'done', settled: true, title: 'Add login' })
    expect(classifyMessage({ type: 'ticket_deleted', projectId: 'p1', ticketId: 14, timestamp: 't' })[0]).toMatchObject({ status: 'deleted', settled: true })
    expect(classifyMessage({ type: 'smash.failed', projectId: 'p1', ticketId: 3, runId: 'x', reason: 'timeout', timestamp: 't' })[0]).toMatchObject({ attention: 'failed', detail: 'timeout' })
  })

  it('records spend caps, installs, blueprint commits and mission turns', () => {
    expect(classifyMessage({ type: 'daily_budget_exceeded', projectId: 'p1', dailySpend: 10.5, budget: 10, queuePaused: true })[0])
      .toMatchObject({ refKind: 'project', refId: 'p1', kind: 'project.budget', attention: 'budget', data: { scope: 'project', spentUsd: 10.5, budgetUsd: 10 } })
    expect(classifyMessage({ type: 'setup_error', projectId: 'p1', error: 'npm failed' })[0]).toMatchObject({ kind: 'project.setup', attention: 'failed', detail: 'npm failed' })
    expect(classifyMessage({ type: 'setup_checkpoint', projectId: 'p1', checkpoint: 'install', status: 'running' })).toEqual([])
    expect(classifyMessage({ type: 'blueprint.commit_failed', commitId: 'b1', step: 'repo', error: 'exists', timestamp: 't' })[0]).toMatchObject({ refKind: 'blueprint', projectId: null, attention: 'failed' })
    expect(classifyMessage({ type: 'agent_done', conversationId: 'm1', fullText: 'secret text', timestamp: 't' })[0]).toMatchObject({ refKind: 'mission', status: 'completed', detail: null })
    // Core-session turns settle the mission too (status from the turn).
    expect(classifyMessage({ type: 'agent_turn_done', conversationId: 'm1', turnId: 't1', status: 'completed', fullText: 'x', timestamp: 't' } as never)[0]).toMatchObject({ refKind: 'mission', refId: 'm1', status: 'completed', settled: true, attention: null })
    expect(classifyMessage({ type: 'agent_turn_done', conversationId: 'm1', turnId: 't2', status: 'failed', timestamp: 't' } as never)[0]).toMatchObject({ status: 'failed', attention: 'failed', settled: true })
    expect(classifyMessage({ type: 'agent_turn_done', conversationId: 'm1', turnId: 't3', status: 'interrupted', timestamp: 't' } as never)[0]).toMatchObject({ status: 'cancelled', settled: true })
    expect(classifyMessage({ type: 'agent_limit_continue', conversationId: 'm1', at: 'z', timestamp: 't' })[0]).toMatchObject({ hold: 'provider_limit', attention: 'blocked' })
    expect(classifyMessage({ type: 'agent_run_failure', conversationId: 'm1', messageId: 'x', kind: 'run-failure', runId: 'r1', railIndex: 0, projectId: 'p1', prDeliveryId: 'd', ticketIds: [], code: 'tests_failed', detail: 'npm test', timestamp: 't' })[0])
      .toMatchObject({ refKind: 'run', refId: 'r1', attention: 'failed', detail: 'tests_failed: npm test' })
  })

  it('bounds untrusted text and question options', () => {
    const long = 'x'.repeat(5000)
    const q = compactQuestion({ interruptId: 'i', kind: 'approval', text: long, options: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, label: long })) })!
    expect(q.text.length).toBeLessThanOrEqual(240)
    expect(q.options).toHaveLength(6)
    expect(q.options[0].label.length).toBeLessThanOrEqual(80)
    expect(compactQuestion({ kind: 'question' })).toBeNull()
  })

  it('signs a transition by status, hold, attention, detail and question id', () => {
    const [a] = classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r1', question })
    const [b] = classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r1', question: { ...question, interruptId: 'int-2' } })
    expect(signatureOf(a)).not.toBe(signatureOf(b))
    expect(signatureOf(a)).toBe(signatureOf(classifyMessage({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r1', question })[0]))
  })
})

describe('repository clones', () => {
  it('turns clone frames into app-global clone rows: running with progress, completed with the project, failed with the reason', () => {
    expect(classifyMessage({ type: 'repository.clone_started', cloneId: 'c1', path: '/tmp/repo' })[0]).toMatchObject({ projectId: null, refKind: 'clone', refId: 'c1', kind: 'clone.status', status: 'running', settled: false, detail: null, data: { path: '/tmp/repo' } })
    expect(classifyMessage({ type: 'repository.clone_progress', cloneId: 'c1', phase: 'receiving', percent: 42.4 })[0]).toMatchObject({ status: 'running', detail: 'receiving 42%', data: { phase: 'receiving', percent: 42.4 } })
    expect(classifyMessage({ type: 'repository.clone_done', cloneId: 'c1', path: '/tmp/repo', newProjectId: 'p9', slug: 'repo' })[0]).toMatchObject({ status: 'completed', settled: true, attention: null, data: { path: '/tmp/repo', projectId: 'p9', slug: 'repo' } })
    expect(classifyMessage({ type: 'repository.clone_failed', cloneId: 'c1', error: 'Clone failed', code: 'clone_failed' })[0]).toMatchObject({ status: 'failed', settled: true, attention: 'failed', detail: 'Clone failed', data: { code: 'clone_failed' } })
    expect(classifyMessage({ type: 'repository.clone_progress', phase: 'receiving', percent: 1 })).toEqual([])
    // Each new percent is a new row; a repeat is not (same signature).
    const a = classifyMessage({ type: 'repository.clone_progress', cloneId: 'c1', phase: 'receiving', percent: 10 })[0]
    expect(signatureOf(a)).not.toBe(signatureOf(classifyMessage({ type: 'repository.clone_progress', cloneId: 'c1', phase: 'receiving', percent: 20 })[0]))
  })
})
