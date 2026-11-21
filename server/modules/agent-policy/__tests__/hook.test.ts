import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POLICY_HOOK_SOURCE } from '../hook/policy-hook-bundle.generated'
import { runPolicyHook, type HookEnvironment } from '../hook/policy-hook'
import { parsePolicyDenial } from '../domain/denial'

let dir: string
let script: string
let home: string
let run: string

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-policy-hook-')))
  home = path.join(dir, 'home')
  run = path.join(dir, 'run')
  fs.mkdirSync(path.join(run, '.git'), { recursive: true })
  fs.writeFileSync(path.join(run, '.git', 'HEAD'), 'ref: refs/heads/feat/1-x\n')
  fs.mkdirSync(path.join(run, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
  fs.writeFileSync(path.join(run, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/trunk\n')
  fs.mkdirSync(home, { recursive: true })
  script = path.join(dir, 'specrails-policy-hook-test.cjs')
  fs.writeFileSync(script, POLICY_HOOK_SOURCE)
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function invoke(stdin: string, env: Record<string, string> = {}): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [script, '--specrails-home', home], {
    input: stdin,
    env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PROJECT_DIR: run, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  })
  return { stdout: result.stdout, status: result.status }
}

const payload = (tool: string, input: unknown) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', session_id: 's1', cwd: run })

describe('bundled policy hook (the file Claude runs)', () => {
  it('denies with a valid PreToolUse decision Claude understands', () => {
    const { stdout, status } = invoke(payload('Bash', { command: 'git push --force origin feat/1-x' }))
    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(parsePolicyDenial(`PreToolUse:Bash hook error: ${out.hookSpecificOutput.permissionDecisionReason}`)).toMatchObject({ rule: 'git-force-push' })
  })

  it('reads the default branch from the run checkout', () => {
    expect(JSON.parse(invoke(payload('Bash', { command: 'git push origin trunk' })).stdout).hookSpecificOutput.permissionDecisionReason).toContain('[specrails-policy:git-push-protected]')
  })

  it('spools each denial for the audit', () => {
    invoke(payload('Read', { file_path: '~/.ssh/id_rsa' }))
    const spool = path.join(home, '.specrails', 'agent-policy', 'denials')
    const reports = fs.readdirSync(spool).map((name) => JSON.parse(fs.readFileSync(path.join(spool, name), 'utf8')))
    expect(reports.some((report) => report.rule === 'secret-access' && report.toolUseId === 'toolu_1' && report.projectDir === run)).toBe(true)
  })

  it('makes no decision (never "allow") for allowed calls', () => {
    expect(invoke(payload('Bash', { command: 'npm test' })).stdout).toBe('{}')
    expect(invoke(payload('Read', { file_path: path.join(run, 'a.ts') })).stdout).toBe('{}')
  })

  it('fails open on malformed input', () => {
    for (const input of ['', 'not json', '[]', '{"tool_name":42}', JSON.stringify({ hook_event_name: 'Stop' })]) {
      const { stdout, status } = invoke(input)
      expect(status).toBe(0)
      expect(stdout).toBe('{}')
    }
  })

  it('answers within the hook budget', () => {
    const started = Date.now()
    invoke(payload('Bash', { command: 'ls' }))
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('runPolicyHook failure policy', () => {
  const brokenFs: HookEnvironment['fs'] = {
    readFile: () => { throw new Error('boom') },
    realpath: () => { throw new Error('boom') },
    isDir: () => { throw new Error('boom') },
    exists: () => { throw new Error('boom') },
  }
  const env: HookEnvironment = { argv: [], env: { CLAUDE_PROJECT_DIR: '/r' }, home: '/h', tmpdir: '/tmp', fs: brokenFs }

  it('fails closed only for deny-list shapes when evaluation throws', () => {
    expect(JSON.parse(runPolicyHook(payload('Bash', { command: 'git push --force' }), env).output).hookSpecificOutput.permissionDecisionReason).toContain('[specrails-policy:policy-error]')
    expect(runPolicyHook(payload('Bash', { command: 'git push origin feat' }), env).output).toBe('{}')
  })
})

describe('generated bundle', () => {
  it('is in sync with the hook sources', () => {
    execFileSync(process.execPath, ['scripts/build-policy-hook.mjs', '--check'], { cwd: path.resolve(__dirname, '../../../..'), stdio: 'pipe' })
  })
})
