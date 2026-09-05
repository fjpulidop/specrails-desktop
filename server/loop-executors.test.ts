// Focused tests for the ONE piece of branching logic in the otherwise
// coverage-excluded spawn glue (`loop-executors.ts`): how `runAiStep` grants a
// relocated project's repo dir to each provider so loop iterations can WRITE
// source files. Regression guard for the codex sandbox bug where every loop
// resume ran under `workspace-write` (writable root = workspace only) and repo
// edits failed with `Operation not permitted`, spinning verify→fix forever.
//
// All real spawn machinery is mocked; we assert only the `buildOpts.extraArgs`
// (and `action`) handed to `runAiCliInvocation`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  runAiCliInvocation,
  getAdapter,
  ensureFrameworkAgents,
  finaliseInvocationResult,
} = vi.hoisted(() => ({
  runAiCliInvocation: vi.fn(),
  getAdapter: vi.fn(),
  ensureFrameworkAgents: vi.fn(),
  ensureFrameworkCommandSubtrees: vi.fn(),
  finaliseInvocationResult: vi.fn(),
}))

vi.mock('./spawn-lifecycle', () => ({ runAiCliInvocation }))
vi.mock('./providers', () => ({ getAdapter }))
vi.mock('./workspace-manager', () => ({ ensureFrameworkAgents }))
vi.mock('./result-event', () => ({ finaliseInvocationResult }))

import { createLoopExecutors } from './loop-executors'

function fakeAdapter(id: string) {
  const buildRepoAccessArgs =
    id === 'codex'
      ? (paths: readonly string[]) => [
          '-c',
          `sandbox_workspace_write.writable_roots=[${paths.map((repoPath) => JSON.stringify(repoPath)).join(', ')}]`,
        ]
      : id === 'claude' || id === 'kimi'
        ? (paths: readonly string[]) =>
            paths.flatMap((repoPath) => ['--add-dir', repoPath])
        : undefined
  return {
    id,
    binary: id,
    projectDirName: `.${id}`,
    buildArgs: vi.fn(() => []),
    buildRepoAccessArgs,
    ...(id === 'kimi'
      ? {
          formatCoreCommand: (command: string, cwd?: string) =>
            command.startsWith('/skill:')
              ? `materialized:${cwd}:${command.slice('/skill:'.length)}`
              : command,
        }
      : {}),
  }
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
    buildOpts: { prompt: string; extraArgs?: string[] }
    env: Record<string, string | undefined>
  }
}

describe('loop-executors runAiStep — relocated-repo sandbox grant', () => {
  beforeEach(() => {
    runAiCliInvocation.mockReset()
    getAdapter.mockReset()
    ensureFrameworkAgents.mockReset()
    finaliseInvocationResult.mockReset()
    finaliseInvocationResult.mockImplementation(
      (_adapter: unknown, _events: unknown, options: { durationMs?: number }) => ({
        result: {
          total_cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          duration_ms: options.durationMs,
        },
        estimated: false,
      }),
    )
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

  it('kimi relocated → uses its provider-native --add-dir grant', async () => {
    const inv = await callStep('kimi', { repoDir: '/repo', cwd: '/ws' })
    expect(inv.buildOpts.extraArgs).toEqual(['--add-dir', '/repo'])
  })

  it('materializes a Kimi loop skill at the execution cwd before invocation', async () => {
    getAdapter.mockReturnValue(fakeAdapter('kimi'))
    const ex = createLoopExecutors({ env: {} })
    await ex.runAiStep({
      prompt: '/skill:specrails-implement #7 --yes',
      provider: 'kimi',
      model: 'k3',
      effort: undefined,
      cwd: '/workspace',
      repoDir: '/repo',
    })
    const invocation = runAiCliInvocation.mock.calls[0][0]
    expect(invocation.buildOpts.prompt)
      .toBe('materialized:/workspace:specrails-implement #7 --yes')
  })

  it('passes a wall-clock fallback so Kimi loop analytics retain duration', async () => {
    getAdapter.mockReturnValue(fakeAdapter('kimi'))
    const ex = createLoopExecutors({ env: {} })
    const result = await ex.runAiStep({
      prompt: 'implement',
      provider: 'kimi',
      model: 'k3',
      effort: 'high',
      cwd: '/workspace',
      repoDir: '/repo',
    })
    const finaliseOptions = finaliseInvocationResult.mock.calls.at(-1)?.[2] as {
      fallbackModel?: string
      durationMs?: number
    }
    expect(finaliseOptions.fallbackModel).toBe('k3')
    expect(finaliseOptions.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBe(finaliseOptions.durationMs)
  })

  it('non-relocated (no repoDir) → no extraArgs for codex', async () => {
    const inv = await callStep('codex', { cwd: '/repo' })
    expect(inv.buildOpts.extraArgs).toBeUndefined()
  })

  it('non-relocated (no repoDir) → no extraArgs for claude', async () => {
    const inv = await callStep('claude', { cwd: '/repo' })
    expect(inv.buildOpts.extraArgs).toBeUndefined()
  })

  it('provider without a repo-access hook → no extraArgs (no sandbox grant emitted)', async () => {
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

  describe('spawn env — per-run repoDir pin + lazy base-env provider (isolated rails)', () => {
    const step = { prompt: 'x', provider: 'claude', model: 'm', effort: undefined }

    it('SPECRAILS_REPO_DIR follows the run repoDir (the WORKTREE for isolated runs), overriding any base-env value', async () => {
      getAdapter.mockReturnValue(fakeAdapter('claude'))
      // A relocated project's base env must never leak the LIVE repo into an
      // isolated spawn — the worktree always wins; the workspace artifact
      // indirection rides through untouched.
      const ex = createLoopExecutors({
        env: {
          SPECRAILS_REPO_DIR: '/real/repo',
          SPECRAILS_TICKETS_PATH: '/home/ws/.specrails/local-tickets.json',
          SPECRAILS_BACKLOG_CONFIG_PATH: '/home/ws/.specrails/backlog-config.json',
        },
      })
      await ex.runAiStep({ ...step, cwd: '/wt/ticket-1', repoDir: '/wt/ticket-1' })
      const inv = runAiCliInvocation.mock.calls[0][0] as { env: Record<string, string | undefined> }
      expect(inv.env.SPECRAILS_REPO_DIR).toBe('/wt/ticket-1')
      expect(inv.env.SPECRAILS_TICKETS_PATH).toBe('/home/ws/.specrails/local-tickets.json')
      expect(inv.env.SPECRAILS_BACKLOG_CONFIG_PATH).toBe('/home/ws/.specrails/backlog-config.json')
    })

    it('accepts a LAZY env provider, re-resolved on every step (relocation picked up without restart)', async () => {
      getAdapter.mockReturnValue(fakeAdapter('claude'))
      let ticketsPath = '/a/local-tickets.json'
      const ex = createLoopExecutors({ env: () => ({ SPECRAILS_TICKETS_PATH: ticketsPath }) })
      await ex.runAiStep({ ...step, cwd: '/wt' })
      ticketsPath = '/b/local-tickets.json'
      await ex.runAiStep({ ...step, cwd: '/wt' })
      const envs = runAiCliInvocation.mock.calls.map((c) => (c[0] as { env: Record<string, string | undefined> }).env)
      expect(envs[0].SPECRAILS_TICKETS_PATH).toBe('/a/local-tickets.json')
      expect(envs[1].SPECRAILS_TICKETS_PATH).toBe('/b/local-tickets.json')
    })
  })

  describe('git-agnostic signal (SPECRAILS_GIT_AUTO)', () => {
    const ORIG = process.env.SPECRAILS_RAIL_DELIVER_PR
    afterEach(() => {
      if (ORIG === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
      else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG
    })

    it('injects SPECRAILS_GIT_AUTO=false when the delivery flag is ON (default)', async () => {
      delete process.env.SPECRAILS_RAIL_DELIVER_PR
      const inv = await callStep('claude', { repoDir: '/repo', cwd: '/ws' })
      expect(inv.env.SPECRAILS_GIT_AUTO).toBe('false')
    })

    it('does NOT inject the signal when the flag is explicitly OFF', async () => {
      process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
      const inv = await callStep('claude', { repoDir: '/repo', cwd: '/ws' })
      expect(inv.env.SPECRAILS_GIT_AUTO).toBeUndefined()
    })
  })
})

describe('loop-executors — idle watchdog (loop-step-idle)', () => {
  beforeEach(() => {
    runAiCliInvocation.mockReset()
    getAdapter.mockReset()
    ensureFrameworkAgents.mockReset()
    finaliseInvocationResult.mockReset()
    finaliseInvocationResult.mockImplementation(
      (_adapter: unknown, _events: unknown, options: { durationMs?: number }) => ({
        result: { total_cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: options.durationMs },
        estimated: false,
      }),
    )
    runAiCliInvocation.mockResolvedValue({ spawnFailed: false, code: 0, events: [], sessionId: 'sid', stderrTail: '' })
  })

  async function run(idleTimeoutMs?: number) {
    getAdapter.mockReturnValue(fakeAdapter('claude'))
    const ex = createLoopExecutors({ env: {} })
    const lines: string[] = []
    const res = await ex.runAiStep({
      prompt: 'do it', provider: 'claude', model: 'm', cwd: '/ws',
      aiStepTimeoutMs: 0, idleTimeoutMs,
      onLine: (l: string) => { lines.push(l) },
    })
    const inv = runAiCliInvocation.mock.calls[0][0] as { inactivityTimeoutMs?: number; timeoutMs?: number; onInactivityTimeout?: () => void }
    return { res, inv, lines }
  }

  it('passes the idle bound as the spawn inactivity watchdog (untimed step keeps NO wall-clock cap)', async () => {
    const { inv } = await run(1_800_000)
    expect(inv.inactivityTimeoutMs).toBe(1_800_000)
    expect(inv.timeoutMs).toBeUndefined()
    expect(typeof inv.onInactivityTimeout).toBe('function')
  })

  it('0 / absent ⇒ no inactivity watchdog (byte-identical untimed legacy)', async () => {
    const a = await run(0)
    expect(a.inv.inactivityTimeoutMs).toBeUndefined()
    runAiCliInvocation.mockClear()
    const b = await run(undefined)
    expect(b.inv.inactivityTimeoutMs).toBeUndefined()
  })

  it('an inactivity teardown surfaces as a STALLED result, not a plain timeout', async () => {
    runAiCliInvocation.mockImplementation(async (hooks: { onInactivityTimeout?: () => void }) => {
      hooks.onInactivityTimeout?.()
      return { spawnFailed: false, code: null, timedOut: true, events: [], sessionId: 'sid', stderrTail: '' }
    })
    const { res, lines } = await run(60_000)
    expect(res.stalled).toBe(true)
    expect(res.failed).toBe(true)
    expect(res.errorText).toBe('AI step stalled')
    expect(res.sessionId).toBe('sid')
    expect(lines.join('\n')).toContain('produced no output for 60s — stalled')
  })

  it('a wall-clock timeout without inactivity stays a plain timeout (no stalled flag)', async () => {
    runAiCliInvocation.mockResolvedValue({ spawnFailed: false, code: null, timedOut: true, events: [], sessionId: 'sid', stderrTail: '' })
    const { res } = await run(60_000)
    expect(res.stalled).toBeUndefined()
    expect(res.failed).toBe(true)
    expect(res.errorText).toContain('timed out')
  })

  it('planInteractiveAiStep threads the idle bound into the plan (and omits it when 0)', () => {
    getAdapter.mockReturnValue({ ...fakeAdapter('claude'), capabilities: { persistentStdin: true } })
    const ex = createLoopExecutors({ env: {} })
    const plan = ex.planInteractiveAiStep!({ provider: 'claude', model: 'm', cwd: '/ws', aiStepTimeoutMs: 0, idleTimeoutMs: 90_000 })
    expect(plan?.idleTimeoutMs).toBe(90_000)
    expect(plan?.stepTimeoutMs).toBe(0)
    const none = ex.planInteractiveAiStep!({ provider: 'claude', model: 'm', cwd: '/ws', aiStepTimeoutMs: 0, idleTimeoutMs: 0 })
    expect(none?.idleTimeoutMs).toBeUndefined()
  })
})
