import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeRuntimeRecovery } from './agent-runtime-recovery'
const fixture = vi.hoisted(() => ({ cli: '' }))
vi.mock('./agent-runtime-package', () => ({ resolveRetainedAgentRuntime: () => fixture.cli }))
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-bridge-')); fixture.cli = path.join(root, 'core.cjs') })
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
