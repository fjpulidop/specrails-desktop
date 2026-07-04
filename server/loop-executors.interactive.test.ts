// Tests for the production interactive-plan builder in createLoopExecutors
// (S2: all jobs interactive by default, loop path). Kept SEPARATE from
// loop-executors.test.ts, which module-mocks './providers' — these pins need
// the REAL claude adapter so the chat-stream argv shape is asserted for real.
// planInteractiveAiStep is pure argv/env derivation (no spawn) and is the
// contract the loop engine's interactive branch consumes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createLoopExecutors } from './loop-executors'
import type { InteractivePlanInput } from './loop-run-manager'
import './providers' // populate the adapter registry

const baseEnv = { PATH: '/usr/bin' } as NodeJS.ProcessEnv

function plan(input: Partial<InteractivePlanInput> = {}) {
  const executors = createLoopExecutors({ env: baseEnv })
  return executors.planInteractiveAiStep!({
    provider: 'claude',
    model: 'sonnet',
    cwd: '/repo',
    ...input,
  })
}

describe('createLoopExecutors.planInteractiveAiStep', () => {
  beforeEach(() => {
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
    delete process.env.SPECRAILS_RAIL_DELIVER_PR
  })
  afterEach(() => {
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
    delete process.env.SPECRAILS_RAIL_DELIVER_PR
  })

  it('returns a chat-stream plan for claude by default (interactive jobs default ON)', () => {
    const p = plan()
    expect(p).toBeTruthy()
    expect(p!.adapter.id).toBe('claude')
    expect(p!.spec.binary).toBe('claude')
    expect(p!.spec.cwd).toBe('/repo')
    // Persistent-stdin transport: the prompt rides stdin, not argv.
    expect(p!.spec.args).toContain('-p')
    const i = p!.spec.args.indexOf('--input-format')
    expect(p!.spec.args[i + 1]).toBe('stream-json')
    // Default step bound mirrors the one-shot executor's 15-minute cap.
    expect(p!.stepTimeoutMs).toBe(15 * 60_000)
  })

  it('threads the graph-config ai-step timeout as the step bound', () => {
    expect(plan({ aiStepTimeoutMs: 120_000 })!.stepTimeoutMs).toBe(120_000)
  })

  it('resumes a prior step session (mid-pass continuity)', () => {
    const p = plan({ sessionId: 'sess-9' })!
    const i = p.spec.args.indexOf('--resume')
    expect(i).toBeGreaterThan(-1)
    expect(p.spec.args[i + 1]).toBe('sess-9')
    // Fresh pass ⇒ no --resume.
    expect(plan()!.spec.args).not.toContain('--resume')
  })

  it('KILL-SWITCH: SPECRAILS_INTERACTIVE_JOBS=false returns null (byte-identical one-shot)', () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    expect(plan()).toBeNull()
  })

  it('returns null for providers without persistent stdin (codex, gemini)', () => {
    expect(plan({ provider: 'codex', model: 'gpt-5.5' })).toBeNull()
    expect(plan({ provider: 'gemini', model: 'gemini-2.5-pro' })).toBeNull()
  })

  it('relocated/worktree pin: SPECRAILS_REPO_DIR + claude --add-dir + the given cwd', () => {
    // rail-isolated-launch passes the worktree as BOTH cwd and repoDir — the
    // session spawn spec must preserve that exactly like the one-shot spawn.
    const p = plan({ cwd: '/wt/ticket-42', repoDir: '/wt/ticket-42' })!
    expect(p.spec.cwd).toBe('/wt/ticket-42')
    expect(p.spec.env!.SPECRAILS_REPO_DIR).toBe('/wt/ticket-42')
    const i = p.spec.args.indexOf('--add-dir')
    expect(i).toBeGreaterThan(-1)
    expect(p.spec.args[i + 1]).toBe('/wt/ticket-42')
  })

  it('legacy (non-relocated) pin: no SPECRAILS_REPO_DIR, no --add-dir', () => {
    const p = plan()!
    expect(p.spec.env!.SPECRAILS_REPO_DIR).toBeUndefined()
    expect(p.spec.args).not.toContain('--add-dir')
  })

  it('safe-PR flow: injects SPECRAILS_GIT_AUTO=false when PR delivery is on (default)', () => {
    // Default (flag unset) = PR delivery ON → core's implement must not self-ship.
    expect(plan()!.spec.env!.SPECRAILS_GIT_AUTO).toBe('false')
  })

  it('safe-PR flow off (SPECRAILS_RAIL_DELIVER_PR=0): env untouched', () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = '0'
    const p = plan()!
    expect(p.spec.env!.SPECRAILS_GIT_AUTO).toBeUndefined()
    // Base env preserved.
    expect(p.spec.env!.PATH).toBe('/usr/bin')
  })
})
