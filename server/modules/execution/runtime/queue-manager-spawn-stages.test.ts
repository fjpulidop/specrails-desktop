// Characterization tests for the `_startJob` spawn stages that the main queue
// suite did not pin: output chaining, plugin resolution (degraded broadcast,
// snapshot env, plugin telemetry attrs), PR-delivery git env, the value-free
// environment notice, the synthetic OTEL bridge lifecycle and the raw event
// persistence fail-stop. Written against the pre-split implementation so the
// stage extraction is provably behaviour-preserving.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Module from 'module'
import { initDb, updateProjectSettings } from '../../../db'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))
vi.mock('../../../ids', () => ({ newId: vi.fn(() => 'stage-job') }))
vi.mock('tree-kill', () => ({ default: vi.fn() }))
vi.mock('../../../hooks', () => ({ resetPhases: vi.fn(), setActivePhases: vi.fn() }))

const bridge = {
  consumeEvent: vi.fn(),
  finalize: vi.fn(() => Promise.resolve()),
}
vi.mock('../../accounting/runtime/codex-otel-bridge', () => ({
  createCodexOtelBridge: vi.fn(() => bridge),
}))

import { spawn as mockSpawn, execSync as mockExecSync } from 'child_process'
import treeKill from 'tree-kill'
import { newId as mockId } from '../../../ids'
import { createCodexOtelBridge } from '../../accounting/runtime/codex-otel-bridge'
import { QueueManager } from './queue-manager'
import { __resetBinaryProbeCacheForTest } from '../../../binary-probe'

function child() {
  const c = new EventEmitter() as any
  c.stdout = new Readable({ read() {} })
  c.stderr = new Readable({ read() {} })
  c.pid = 4242
  return c
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

type SpawnCall = [string, string[], { env: NodeJS.ProcessEnv; cwd: string }]

describe('QueueManager spawn stages (characterization)', () => {
  const saved = {
    interactive: process.env.SPECRAILS_INTERACTIVE_JOBS,
    explorer: process.env.SPECRAILS_CODE_EXPLORER,
    pr: process.env.SPECRAILS_RAIL_DELIVER_PR,
    home: process.env.SPECRAILS_REGISTRY_HOME,
  }
  let broadcast: ReturnType<typeof vi.fn>
  let home: string

  beforeEach(() => {
    vi.resetAllMocks()
    bridge.finalize.mockImplementation(() => Promise.resolve())
    vi.mocked(createCodexOtelBridge).mockImplementation(() => bridge as any)
    __resetBinaryProbeCacheForTest()
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    delete process.env.SPECRAILS_RAIL_DELIVER_PR
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-stages-home-'))
    process.env.SPECRAILS_REGISTRY_HOME = home
    broadcast = vi.fn()
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
  })

  afterEach(() => {
    for (const [key, env] of [
      ['interactive', 'SPECRAILS_INTERACTIVE_JOBS'],
      ['explorer', 'SPECRAILS_CODE_EXPLORER'],
      ['pr', 'SPECRAILS_RAIL_DELIVER_PR'],
      ['home', 'SPECRAILS_REGISTRY_HOME'],
    ] as const) {
      if (saved[key] === undefined) delete process.env[env]
      else process.env[env] = saved[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('chains the parent result into the dependent system prompt, truncated at 10k chars', async () => {
    const parent = child()
    const dependent = child()
    vi.mocked(mockSpawn).mockReturnValueOnce(parent).mockReturnValueOnce(dependent)
    let n = 0
    vi.mocked(mockId).mockImplementation(() => `chain-${++n}` as any)
    const qm = new QueueManager(broadcast)
    qm.enqueue('/parent')
    qm.enqueue('/child', { dependsOnJobId: 'chain-1' })
    const longResult = 'R'.repeat(10_050)
    parent.stdout.push(JSON.stringify({ type: 'result', result: longResult }) + '\n')
    await tick()
    parent.emit('close', 0)
    await tick()
    const [, args] = vi.mocked(mockSpawn).mock.calls[1] as unknown as SpawnCall
    const joined = args.join('\n')
    expect(joined).toContain(`Previous step output:\n\n${'R'.repeat(10_000)}\n\n[output truncated]\n\n---\n\nNow execute the following command.\n\n`)
    expect(joined).not.toContain('R'.repeat(10_001))
    qm.shutdown()
  })

  it('broadcasts degraded plugins, snapshots them and injects plugin env + telemetry attrs', async () => {
    // The snapshotter is loaded with a lazy CommonJS require (resolvable once
    // compiled); give the test runtime a loader for exactly that module.
    const extensions = (Module as unknown as { _extensions: Record<string, unknown> })._extensions
    const savedTs = extensions['.ts']
    const snapshotPluginsForJob = vi.fn(() => '/snapshots/plugin-job/plugins.json')
    extensions['.ts'] = (mod: { exports: unknown }, filename: string) => {
      if (!filename.endsWith(path.join('plugins', 'rail-integration.ts'))) throw new Error(`unexpected require ${filename}`)
      mod.exports = { snapshotPluginsForJob }
    }
    const proc = child()
    vi.mocked(mockSpawn).mockReturnValue(proc)
    vi.mocked(mockId).mockReturnValue('plugin-job' as any)
    const db = initDb(':memory:')
    updateProjectSettings(db, { pipelineTelemetryEnabled: true })
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-stages-repo-'))
    const resolvePluginsForSpawn = vi.fn(async () => ({
      active: [{ name: 'alpha', version: '1.2.3' }],
      degraded: [{ name: 'beta', reason: 'verify timed out' }],
    }))
    const qm = new QueueManager(broadcast, db, [], cwd, {
      provider: 'claude',
      projectId: 'p1',
      projectSlug: 'proj',
      desktopPort: 4321,
      resolvePluginsForSpawn,
    })
    try {
      qm.enqueue('/specrails:implement #1')
      await vi.waitFor(() => expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1))
      expect(resolvePluginsForSpawn).toHaveBeenCalledWith(cwd, 'p1', 'plugin-job', 'claude', 'claude', 'proj')
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'plugin.degraded',
        projectId: 'p1',
        name: 'beta',
        providerId: 'claude',
        reason: 'verify timed out',
        jobId: 'plugin-job',
      }))
      expect(snapshotPluginsForJob).toHaveBeenCalledWith(
        'proj', 'plugin-job', 'p1',
        [{ name: 'alpha', version: '1.2.3' }],
        [{ name: 'beta', reason: 'verify timed out' }],
      )
      const [, , options] = vi.mocked(mockSpawn).mock.calls[0] as unknown as SpawnCall
      expect(options.env.SPECRAILS_PLUGINS_ACTIVE).toBe('alpha')
      expect(options.env.SPECRAILS_PLUGINS_SNAPSHOT).toBe('/snapshots/plugin-job/plugins.json')
      expect(options.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
        'specrails.job_id=plugin-job,specrails.project_id=p1,' +
        'specrails.plugins.active=["alpha"],specrails.plugins.versions={"alpha":"1.2.3"},' +
        'specrails.plugins.degraded=["beta"]',
      )
      expect(options.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4321/otlp')
      proc.emit('close', 0)
    } finally {
      if (savedTs === undefined) delete extensions['.ts']
      else extensions['.ts'] = savedTs
      qm.shutdown()
      db.close()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('sets SPECRAILS_GIT_AUTO=false only while PR delivery is enabled at spawn', async () => {
    const first = child()
    const second = child()
    vi.mocked(mockSpawn).mockReturnValueOnce(first).mockReturnValueOnce(second)
    let n = 0
    vi.mocked(mockId).mockImplementation(() => `git-auto-${++n}` as any)
    const qm = new QueueManager(broadcast)
    qm.enqueue('/one')
    const [, , on] = vi.mocked(mockSpawn).mock.calls[0] as unknown as SpawnCall
    expect(on.env.SPECRAILS_GIT_AUTO).toBe('false')
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    qm.enqueue('/two')
    first.emit('close', 0)
    await tick()
    const [, , off] = vi.mocked(mockSpawn).mock.calls[1] as unknown as SpawnCall
    expect(off.env.SPECRAILS_GIT_AUTO).toBe(process.env.SPECRAILS_GIT_AUTO)
    qm.shutdown()
  })

  it('writes the value-free environment notice as the first stderr log line', async () => {
    const proc = child()
    vi.mocked(mockSpawn).mockReturnValue(proc)
    vi.mocked(mockId).mockReturnValue('env-notice-job' as any)
    const db = initDb(':memory:')
    const name = 'SPECRAILS_TEST_SURELY_MISSING_VAR'
    delete process.env[name]
    updateProjectSettings(db, { worktreeEnvPassthrough: [name] })
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
    try {
      qm.enqueue('/plain')
      const rows = db.prepare(`SELECT seq, event_type, source, payload FROM events WHERE job_id = 'env-notice-job' ORDER BY seq`).all() as Array<{ seq: number; event_type: string; source: string; payload: string }>
      expect(rows[0]).toMatchObject({ seq: 0, event_type: 'log', source: 'stderr' })
      expect(JSON.parse(rows[0].payload).line).toMatch(new RegExp(`^\\[environment\\] ${name} not available`))
      expect(qm.getLogBuffer()[0]).toMatchObject({ type: 'log', source: 'stderr', processId: 'env-notice-job' })
      proc.emit('close', 0)
    } finally {
      qm.shutdown()
      db.close()
    }
  })

  it('creates the codex OTEL bridge when telemetry is on and finalizes it on close', async () => {
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/codex'))
    const proc = child()
    vi.mocked(mockSpawn).mockReturnValue(proc)
    vi.mocked(mockId).mockReturnValue('codex-otel-job' as any)
    const db = initDb(':memory:')
    updateProjectSettings(db, { pipelineTelemetryEnabled: true })
    const qm = new QueueManager(broadcast, db, [], undefined, {
      provider: 'codex',
      projectId: 'p1',
      desktopPort: 4999,
      resolvedModel: 'gpt-5.4-mini',
    })
    try {
      qm.enqueue('/specrails:implement #1')
      await vi.waitFor(() => expect(vi.mocked(mockSpawn)).toHaveBeenCalledTimes(1))
      expect(createCodexOtelBridge).toHaveBeenCalledWith({
        jobId: 'codex-otel-job',
        projectId: 'p1',
        desktopPort: 4999,
        model: 'gpt-5.4-mini',
      })
      const [, , options] = vi.mocked(mockSpawn).mock.calls[0] as unknown as SpawnCall
      expect(options.env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined()
      proc.stdout.push(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n')
      await tick()
      proc.emit('close', 3)
      expect(bridge.finalize).toHaveBeenCalledWith({ exitCode: 3 })
    } finally {
      qm.shutdown()
      db.close()
    }
  })

  it('fail-stops the queue and kills the child when raw event persistence fails', async () => {
    const proc = child()
    vi.mocked(mockSpawn).mockReturnValue(proc)
    vi.mocked(mockId).mockReturnValue('persist-fail-job' as any)
    const db = initDb(':memory:')
    const qm = new QueueManager(broadcast, db, [], undefined, { projectId: 'p1' })
    try {
      qm.enqueue('/plain')
      db.exec(`
        CREATE TRIGGER reject_event BEFORE INSERT ON events
        WHEN NEW.job_id = 'persist-fail-job'
        BEGIN SELECT RAISE(ABORT, 'simulated event failure'); END;
      `)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      proc.stdout.push(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n')
      await tick()
      expect(qm.isPaused()).toBe(true)
      expect(vi.mocked(treeKill)).toHaveBeenCalledWith(4242, 'SIGTERM', expect.any(Function))
      expect(errors).toHaveBeenCalledWith('[queue-manager] event persistence failed for persist-fail-job:', expect.any(Error))
      expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event', jobId: 'persist-fail-job' }))
      proc.emit('close', null)
      await tick()
      expect(qm.getJobs().find((job) => job.id === 'persist-fail-job')?.status).toBe('failed')
    } finally {
      qm.shutdown()
      db.close()
    }
  })
})
