import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const retained = vi.hoisted(() => ({ cli: '' }))
vi.mock('./agent-runtime-package', () => ({ resolveRetainedAgentRuntime: () => retained.cli }))

import { retainedRuntimeSupportsPause, runAgentRuntimeControl } from './agent-runtime-bridge'

// Core `runtime pause` (capability pauseRuns): the retained CLI is a fake that
// asserts the exact argv and answers like Core.
let directory: string, contextPath: string
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'runtime-pause-'))
  contextPath = path.join(directory, 'desktop-context.json')
  writeFileSync(contextPath, JSON.stringify({ runId: 'run-1' }))
  retained.cli = path.join(directory, 'runtime.cjs')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function fakeCore(capabilities: Record<string, number>, outcome = 'requested', overrides: Record<string, unknown> = {}): void {
  writeFileSync(retained.cli, `const args = process.argv.slice(2)
if (args[0] === 'api') { process.stdout.write(JSON.stringify({ type: 'runtime-api', capabilities: ${JSON.stringify(capabilities)} }) + '\\n'); process.exit(0) }
require('node:assert/strict').deepEqual(args, ['pause', '--context', ${JSON.stringify(contextPath)}, '--request-id', 'budget:1', '--reason', 'budget'])
process.stdout.write(JSON.stringify({ type: 'runtime-pause-result', runId: 'run-1', requestId: 'budget:1', reason: 'budget', outcome: ${JSON.stringify(outcome)}, status: 'running', ...${JSON.stringify(overrides)} }) + '\\n')`)
}
const pause = () => runAgentRuntimeControl({ kind: 'pause', runId: 'run-1', contextPath, cwd: directory, env: process.env, requestId: 'budget:1', reason: 'budget' })

it('requests a cooperative pause through the retained Core and returns its outcome', async () => {
  fakeCore({ pauseRuns: 1 })
  await expect(pause()).resolves.toEqual({ kind: 'pause', requestId: 'budget:1', reason: 'budget', outcome: 'requested', status: 'running' })
})

it('reports a terminal run as a no-op outcome', async () => {
  fakeCore({ pauseRuns: 1 }, 'terminal')
  await expect(pause()).resolves.toMatchObject({ outcome: 'terminal' })
})

it('refuses with engine_unsupported when the retained Core lacks pauseRuns', async () => {
  fakeCore({ engineV2: 1 })
  await expect(retainedRuntimeSupportsPause({ runId: 'run-1', contextPath, cwd: directory, env: process.env })).resolves.toBe(false)
  await expect(pause()).rejects.toThrow('engine_unsupported')
})

it('rejects an acknowledgement for another request or run', async () => {
  fakeCore({ pauseRuns: 1 }, 'requested', { requestId: 'other' })
  await expect(pause()).rejects.toThrow('did not acknowledge')
  fakeCore({ pauseRuns: 1 }, 'requested', { runId: 'other-run' })
  await expect(pause()).rejects.toThrow('did not acknowledge')
})

it('validates the reason token and the frozen run scope before spawning', async () => {
  fakeCore({ pauseRuns: 1 })
  await expect(runAgentRuntimeControl({ kind: 'pause', runId: 'run-1', contextPath, cwd: directory, env: process.env, requestId: 'budget:1', reason: 'Budget!' })).rejects.toThrow('invalid_arguments')
  await expect(runAgentRuntimeControl({ kind: 'pause', runId: 'run-2', contextPath, cwd: directory, env: process.env, requestId: 'budget:1', reason: 'budget' })).rejects.toThrow('runtime_scope_changed')
})
