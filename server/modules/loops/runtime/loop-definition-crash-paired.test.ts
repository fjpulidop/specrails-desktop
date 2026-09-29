import { expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type { LoopRunRequest } from './loop-run-manager'

const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
const fixtures = path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__')
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
// Retaining four complete dependency closures concurrently saturates the Windows
// runner's disk. Serialize admission there, then overlap the real lease waits
// and recovery. No production lease or execution timeout is shortened.
let admission = Promise.resolve()
async function reserveAdmission(): Promise<() => void> {
  if (process.platform !== 'win32') return () => {}
  const previous = admission
  let release!: () => void
  admission = new Promise<void>(resolve => { release = resolve })
  await previous
  return release
}
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
}

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).concurrent.each(['read', 'write', 'pause', 'between'] as const)(
  'recovers the real Loop Manager after a host/Core process crash during %s without duplicate billing', async mode => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'loop crash ')))
    const children: ChildProcess[] = []
    const json = (name: string) => JSON.parse(readFileSync(path.join(root, name + '.json'), 'utf8'))
    const calls = () => readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    try {
      const cwd = path.join(root, 'repository'), backlog = path.join(root, 'backlog')
      mkdirSync(path.join(cwd, '.specrails'), { recursive: true })
      mkdirSync(path.join(backlog, '.specrails'), { recursive: true })
      expect(spawnSync('git', ['init', '-q', cwd]).status).toBe(0)
      writeFileSync(path.join(cwd, 'value.txt'), 'baseline')
      expect(spawnSync('git', ['-C', cwd, 'add', '.']).status).toBe(0)
      expect(spawnSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
      const config = JSON.parse(readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), 'utf8'))
      config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', `if(require('node:fs').readFileSync('value.txt','utf8')!==${JSON.stringify(mode === 'write' ? 'complete' : 'baseline')})process.exit(9)`] }]
      writeFileSync(path.join(cwd, '.specrails/agent-runtime.json'), JSON.stringify(config))
      const request: LoopRunRequest = { runId: 'crash-' + mode, loopId: 'crash-fixture', projectId: 'project', repositoryId: 'repo', cwd, provider: 'claude', model: 'fixture', profileName: null, spec: { id: 1, title: 'Complete the frozen request', description: 'Recover without repeating completed work', acceptanceCriteria: ['Host verification passes'] },
        graph: { nodes: [
          { id: 'start', type: 'start', position: { x: 0, y: 0 } },
          { id: 'work', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Complete the frozen request', access: mode === 'write' ? 'write' : 'read', sentinel: 'blocked', timeoutMs: 0, idleTimeoutMs: 0 } } },
          { id: 'verify', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'verify', params: { commands: 'configured' } } },
          { id: 'done', type: 'end', position: { x: 0, y: 300 }, data: { outcome: 'success', requiresVerified: true } },
          { id: 'failed', type: 'end', position: { x: 200, y: 300 }, data: { outcome: 'failure' } },
        ], edges: [ ['start', 'work', ''], ['work', 'verify', 'next'], ['work', 'failed', 'failed'], ['work', 'failed', 'blocked'], ['verify', 'done', 'pass'], ['verify', 'failed', 'fail'], ['verify', 'failed', 'failed'] ].map(([source, target, label], index) => ({ id: String(index), source, target, ...(label ? { label } : {}) })),
        config: { maxIterations: 3, maxTransitions: 20, timeoutMinutes: 0, journal: 'ledger-only', change: 'none' } } }
      writeFileSync(path.join(root, 'request.json'), JSON.stringify(request))
      const env = { ...process.env, SPECRAILS_CORE_RUNTIME_PATH: path.join(core!, 'dist/agent-runtime/index.js'), SPECRAILS_CORE_BIN: path.join(core!, 'bin/specrails-core.mjs'),
        SPECRAILS_REGISTRY_HOME: path.join(root, 'home'), SPECRAILS_TICKETS_PATH: path.join(backlog, '.specrails/local-tickets.json'), SPECRAILS_CRASH_ROOT: root, SPECRAILS_CRASH_MODE: mode,
        NODE_OPTIONS: `--import=${pathToFileURL(path.join(fixtures, 'loop-crash-executor-preload.mjs')).href}` }
      const launch = (action: string) => {
        const child = spawn(process.execPath, ['--import', tsx, path.join(fixtures, 'loop-crash-worker.mjs'), root, action], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        children.push(child)
        let output = ''
        child.stdout.on('data', data => { output += String(data) }); child.stderr.on('data', data => { output += String(data) })
        const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
        return { child, exit, output: () => output }
      }
      const releaseAdmission = await reserveAdmission()
      try {
        const original = launch('start'), boundary = path.join(root, mode === 'pause' ? 'paused.json' : mode === 'between' ? 'between-entered' : 'provider-entered')
        const deadline = Date.now() + (process.platform === 'win32' ? 120_000 : 60_000)
        while (!existsSync(boundary)) {
          if (original.child.exitCode !== null || original.child.signalCode !== null) throw new Error('Host exited before crash boundary: ' + original.output())
          if (Date.now() > deadline) throw new Error('Timed out before crash boundary: ' + original.output())
          await sleep(50)
        }
        expect(calls()).toHaveLength(1)
        expect(readFileSync(path.join(cwd, 'value.txt'), 'utf8')).toBe(mode === 'write' ? 'partial' : 'baseline')
        killTree(original.child); await original.exit
        if (process.platform !== 'win32') expect(original.child.signalCode).toBe('SIGKILL')
      } finally {
        releaseAdmission()
      }
      expect(existsSync(path.join(root, 'unexpected-result.json'))).toBe(false)
      // Restart must use the admitted config, even if today's project settings are invalid.
      writeFileSync(path.join(cwd, '.specrails/agent-runtime.json'), JSON.stringify({ schemaVersion: 999 }))
      const restarted = launch('recover')
      const recoveryDeadline = Date.now() + (process.platform === 'win32' ? 180_000 : 110_000)
      while (restarted.child.exitCode === null && restarted.child.signalCode === null) {
        if (Date.now() > recoveryDeadline) throw new Error('Recovery timed out: ' + restarted.output())
        await sleep(50)
      }
      expect(await restarted.exit, restarted.output()).toBe(0)
      const initial = json('initial-probe'), recovery = json('recovery-probe'), final = json('result')
      expect(initial.status).toBe(mode === 'pause' ? 'paused' : 'running')
      if (mode !== 'pause') expect(initial.lease.active).toBe(true)
      expect(recovery.recoverableSteps).toHaveLength(mode === 'write' ? 1 : 0)
      if (mode === 'write') expect(recovery.recoverableSteps[0]).toMatchObject({ nodePath: 'work' })
      expect(final.result).toMatchObject({ outcome: 'success', totalCostUsd: null })
      expect(final.probe).toMatchObject({ status: 'succeeded', completion: { ok: true, verified: true } })
      expect(final.claim).toBeNull()
      expect(calls()).toHaveLength(mode === 'between' ? 1 : 2)
      expect(final.invocations).toHaveLength(mode === 'between' ? 1 : 2)
      expect(new Set(final.invocations.map((row: { id: string }) => row.id)).size).toBe(mode === 'between' ? 1 : 2)
      expect(final.job.total_cost_usd).toBeNull()
      if (mode === 'read' || mode === 'write') {
        expect(final.invocations.filter((row: { status: string }) => row.status === 'aborted')).toMatchObject([{ tokens_in: null, tokens_out: null, total_cost_usd: null, duration_ms: null }])
        expect(final.invocations.filter((row: { status: string }) => row.status === 'success')).toHaveLength(1)
      }
      if (mode === 'pause') expect(calls()[1].prompt).toContain('Human answer:\n{"answer":"Complete the frozen request"}')
      expect(readFileSync(path.join(cwd, 'value.txt'), 'utf8')).toBe(mode === 'write' ? 'complete' : 'baseline')
    } finally {
      for (const child of children) killTree(child)
      await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => child.once('exit', () => resolve()))))
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, process.platform === 'win32' ? 660_000 : 180_000,
)
