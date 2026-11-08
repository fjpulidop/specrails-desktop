import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { invokeRuntimeRecovery } from './agent-runtime-recovery'
const fixture = vi.hoisted(() => ({ cli: '', timeoutMs: undefined as number | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile: typeof actual.execFile = ((command: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    return actual.execFile(command, args, { ...options, ...(fixture.timeoutMs && args?.includes('recovery') ? { timeout: fixture.timeoutMs } : {}) }, callback)
  }) as typeof actual.execFile
  return { ...actual, execFile }
})
vi.mock('./agent-runtime-package', () => ({ resolveRetainedAgentRuntime: () => fixture.cli }))
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-bridge-')); fixture.cli = path.join(root, 'core.cjs'); fixture.timeoutMs = undefined })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const call = () => invokeRuntimeRecovery({ contextPath: path.join(root, 'context with spaces.json'), cwd: root, env: process.env, request: { action: 'inspect' } })
it('uses structured argv/stdin and the retained Core capability', async () => {
  fs.writeFileSync(fixture.cli, 'if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { let input=""; process.stdin.on("data",s=>input+=s); process.stdin.on("end",()=>console.log(JSON.stringify({type:"runtime-recovery",schemaVersion:1,result:{input:JSON.parse(input),args:process.argv.slice(2)}}))); }')
  expect(await call()).toEqual({ input: { action: 'inspect' }, args: ['recovery', '--context', path.join(root, 'context with spaces.json'), '--stdin'] })
})
it('does not invoke recovery in an old retained Core', async () => {
  fs.writeFileSync(fixture.cli, 'if(process.argv[2]!=="api") throw Error("must not run"); console.log(JSON.stringify({capabilities:{}}))')
  await expect(call()).rejects.toThrow('retained original Core does not support')
})
it('preserves a Core rejection and refuses malformed outcomes', async () => {
  fs.writeFileSync(fixture.cli, 'if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { console.log(JSON.stringify({error:"Original worktree changed"})); process.exitCode=1 }')
  await expect(call()).rejects.toThrow('Original worktree changed')
  fs.writeFileSync(fixture.cli, 'console.log(JSON.stringify({capabilities:{scopedRecovery:1}}))')
  await expect(call()).rejects.toThrow('Invalid Core recovery response')
})

const unsupported = { type: 'runtime-result', status: 'failed', error: { code: 'recovery_unsupported_engine', message: 'Recovery inspect cannot establish journal authority.', details: { action: 'inspect', recommendation: 'Preserve the worktree and fork the run after inspection.' } } }
function failWith(response: unknown) {
  fs.writeFileSync(fixture.cli, `if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { console.log(${JSON.stringify(JSON.stringify(response))}); process.exitCode=1 }`)
}
it('[spec:guided-run-recovery/actionable-unsupported-error-across-desktop-transport] propagates a bounded structured unsupported error from actual nonzero Core stdout', async () => {
  failWith(unsupported)
  await expect(call()).rejects.toMatchObject({ name: 'RecoveryUnsupportedEngineError', code: 'recovery_unsupported_engine', action: 'inspect', recommendation: unsupported.error.details.recommendation, message: expect.stringContaining(unsupported.error.details.recommendation) })
  await expect(call()).rejects.toThrow(unsupported.error.message)
})
it('keeps other structured Core errors readable without classifying them as unsupported', async () => {
  failWith({ ...unsupported, error: { ...unsupported.error, code: 'scope_mismatch' } })
  const error = await call().catch(error => error)
  expect(error.message).toContain(unsupported.error.message)
  expect(error.code).toBeUndefined()
})
it.each([
  { ...unsupported, error: { ...unsupported.error, details: {} } },
  { ...unsupported, error: { ...unsupported.error, message: '' } },
  { ...unsupported, error: { ...unsupported.error, message: 'x'.repeat(6001) } },
  { ...unsupported, error: { ...unsupported.error, details: { action: 'inspect', recommendation: 'x'.repeat(6001) } } },
  { ...unsupported, error: { ...unsupported.error, details: { action: 'x'.repeat(65), recommendation: 'Fork' } } },
  { ...unsupported, error: { ...unsupported.error, details: { action: 'patch', recommendation: 'Fork' } } },
  { type: 'other', error: unsupported.error },
])('retains uncertainty guidance for malformed or oversized unsupported fields %#', async response => {
  failWith(response)
  const error = await call().catch(error => error)
  expect(error.code).toBeUndefined(); expect(error.message).toContain('inspect its history before retrying')
})
it('retains uncertainty guidance for malformed or oversized stdout', async () => {
  fs.writeFileSync(fixture.cli, 'if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { console.log("{invalid"); process.exitCode=1 }')
  await expect(call()).rejects.toThrow('inspect its history before retrying')
  fs.writeFileSync(fixture.cli, 'if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else process.stdout.write("x".repeat(3*1024*1024))')
  await expect(call()).rejects.toThrow('inspect its history before retrying')
})
it('does not classify a cancelled child from partial structured error output', async () => {
  fs.writeFileSync(fixture.cli, `if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { console.log(${JSON.stringify(JSON.stringify(unsupported))}); setInterval(()=>{},1000) }`)
  const error = await invokeRuntimeRecovery({ contextPath: path.join(root, 'context.json'), cwd: root, env: process.env, request: { action: 'inspect' }, onSpawn: child => {
    if (child.spawnargs.includes('recovery')) child.stdout!.once('data', () => child.kill())
  } }).catch(error => error)
  expect(error.code).toBeUndefined(); expect(error.message).toContain('inspect its history before retrying')
})
it('keeps timeout outcomes uncertain even after structured output', async () => {
  fs.writeFileSync(fixture.cli, `if(process.argv[2]==="api") console.log(JSON.stringify({capabilities:{scopedRecovery:1}})); else { console.log(${JSON.stringify(JSON.stringify(unsupported))}); setInterval(()=>{},1000) }`)
  fixture.timeoutMs = 3000
  const error = await call().catch(error => error)
  expect(error.code).toBeUndefined(); expect(error.message).toContain('inspect its history before retrying')
})
