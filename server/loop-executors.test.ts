// Focused tests for the ONE piece of branching logic in the otherwise
// coverage-excluded spawn glue (`loop-executors.ts`): how `runAiStep` grants a
// relocated project's repo dir to each provider so loop iterations can WRITE
// source files. Regression guard for the codex sandbox bug where every loop
// resume ran under `workspace-write` (writable root = workspace only) and repo
// edits failed with `Operation not permitted`, spinning verify→fix forever.
//
// All real spawn machinery is mocked; we assert only the `buildOpts.extraArgs`
// (and `action`) handed to `runAiCliInvocation`.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { runAiCliInvocation, getAdapter, ensureFrameworkAgents } = vi.hoisted(() => ({
  runAiCliInvocation: vi.fn(),
  getAdapter: vi.fn(),
  ensureFrameworkAgents: vi.fn(),
}))

vi.mock('./spawn-lifecycle', () => ({ runAiCliInvocation }))
vi.mock('./providers', () => ({ getAdapter }))
vi.mock('./workspace-manager', () => ({ ensureFrameworkAgents }))
vi.mock('./result-event', () => ({
  finaliseInvocationResult: () => ({
    result: { total_cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 },
    estimated: false,
  }),
}))

import { createLoopExecutors } from './loop-executors'

function fakeAdapter(id: string) {
  return { id, binary: id, projectDirName: `.${id}`, buildArgs: vi.fn(() => []) }
}

/** Drive runAiStep and return the single object passed to runAiCliInvocation. */
async function callStep(
  provider: string,
  opts: { repoDir?: string; cwd?: string; sessionId?: string } = {}
) {
  getAdapter.mockReturnValue(fakeAdapter(provider))
  const ex = createLoopExecutors({ env: {} })
  await ex.runAiStep({
    prompt: 'do it',
    sessionId: opts.sessionId,
    provider,
    model: 'm',
    effort: undefined,
    cwd: opts.cwd ?? '/ws',
    repoDir: opts.repoDir,
  })
  return runAiCliInvocation.mock.calls[0][0] as {
    action: string
    buildOpts: { extraArgs?: string[] }
  }
}

describe('loop-executors runAiStep — relocated-repo sandbox grant', () => {
  beforeEach(() => {
    runAiCliInvocation.mockReset()
    getAdapter.mockReset()
    ensureFrameworkAgents.mockReset()
    runAiCliInvocation.mockResolvedValue({
      spawnFailed: false,
      code: 0,
      events: [],
      sessionId: 'sid',
      stderrTail: '',
    })
  })

  it('codex relocated → adds repo + cwd to sandbox writable_roots', async () => {
    const inv = await callStep('codex', { repoDir: '/Users/x/Projects/MyProject', cwd: '/ws' })
    expect(inv.buildOpts.extraArgs).toEqual([
      '-c',
      'sandbox_workspace_write.writable_roots=["/Users/x/Projects/MyProject", "/ws"]',
    ])
  })

  it('codex relocated → writable_roots also applied on resume (the bug path)', async () => {
    const inv = await callStep('codex', { repoDir: '/repo', cwd: '/ws', sessionId: 'prev' })
    expect(inv.action).toBe('chat-resume')
    expect(inv.buildOpts.extraArgs?.[0]).toBe('-c')
    expect(inv.buildOpts.extraArgs?.[1]).toContain('writable_roots=["/repo", "/ws"]')
  })

  it('claude relocated → uses --add-dir, never writable_roots', async () => {
    const inv = await callStep('claude', { repoDir: '/repo', cwd: '/ws' })
    expect(inv.buildOpts.extraArgs).toEqual(['--add-dir', '/repo'])
  })

  it('non-relocated (no repoDir) → no extraArgs for codex', async () => {
    const inv = await callStep('codex', { cwd: '/repo' })
    expect(inv.buildOpts.extraArgs).toBeUndefined()
  })

  it('non-relocated (no repoDir) → no extraArgs for claude', async () => {
    const inv = await callStep('claude', { cwd: '/repo' })
    expect(inv.buildOpts.extraArgs).toBeUndefined()
  })

  it('unknown provider relocated → no extraArgs (no sandbox grant emitted)', async () => {
    const inv = await callStep('gemini', { repoDir: '/repo', cwd: '/ws' })
    expect(inv.buildOpts.extraArgs).toBeUndefined()
  })

  it('first iteration (no sessionId) → rail-job; resume → chat-resume', async () => {
    expect((await callStep('codex', { repoDir: '/repo', cwd: '/ws' })).action).toBe('rail-job')
    runAiCliInvocation.mockClear()
    expect(
      (await callStep('codex', { repoDir: '/repo', cwd: '/ws', sessionId: 's' })).action
    ).toBe('chat-resume')
  })
})
