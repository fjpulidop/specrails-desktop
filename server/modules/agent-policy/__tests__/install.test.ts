import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createAgentAuditRecorder, createAgentAuditService } from '../../audit'
import { createSqliteAgentActionStore } from '../../audit/adapters/sqlite'
import { writeClaudeConnectorDenyFile } from '../../missions/runtime/mission-connectors-discovery'
import { claudeFrameDenials, parsePolicyDenial } from '../domain/denial'
import { hasAnyPolicyHook, mergePolicyHook, policyHookCommand, stripPolicyHook } from '../domain/settings'
import { parseDenialReport } from '../domain/report'
import { ensurePolicyHookScript, installPolicyHookIn, updateClaudeLocalSettings } from '../adapters/install'
import { drainDenialSpool, DENIAL_SPOOL_GRACE_MS, DENIAL_SPOOL_MAX_AGE_MS } from '../adapters/spool'
import { createDenialIngest } from '../adapters/ingest'
import { POLICY_HOOK_VERSION } from '../hook/policy-hook-bundle.generated'

let tmp: string
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-policy-install-'))) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); vi.unstubAllEnvs() })

const settingsFile = (dir: string) => path.join(dir, '.claude', 'settings.local.json')
const read = (dir: string) => JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'))
const COMMAND = policyHookCommand({ node: '/opt/node', script: "/h/.specrails/agent-policy/specrails-policy-hook-x.cjs", specrailsHome: '/h', platform: 'darwin' })

describe('settings merge', () => {
  it('adds our hook and keeps every other key and hook', () => {
    const user = { deniedMcpServers: [{ serverName: 'claude.ai Gmail' }], hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] }, permissions: { deny: ['WebFetch'] } }
    const merged = mergePolicyHook(user, COMMAND)
    expect(merged.deniedMcpServers).toEqual(user.deniedMcpServers)
    expect(merged.permissions).toEqual(user.permissions)
    expect((merged.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(2)
    expect((merged.hooks as Record<string, unknown[]>).Stop).toEqual(user.hooks.Stop)
    // Idempotent and replaces an older command of ours.
    expect(mergePolicyHook(mergePolicyHook(user, 'node /old/specrails-policy-hook-a.cjs'), COMMAND)).toEqual(merged)
    expect(stripPolicyHook(merged)).toEqual(user)
    expect(hasAnyPolicyHook(merged)).toBe(true)
    expect(stripPolicyHook(mergePolicyHook({}, COMMAND))).toEqual({})
  })

  it('quotes paths for the shell', () => {
    expect(policyHookCommand({ node: 'node', script: "/a b/it's.cjs", specrailsHome: '/h', platform: 'darwin' })).toBe(`'node' '/a b/it'\\''s.cjs' --specrails-home '/h'`)
  })
})

describe('local settings file in the mission cwd', () => {
  it('the policy hook and the connectors deny-list never clobber each other', () => {
    vi.stubEnv('SPECRAILS_REGISTRY_HOME', tmp)
    writeClaudeConnectorDenyFile(tmp, ['claude.ai Gmail'])
    expect(installPolicyHookIn(tmp, tmp)).toBe(true)
    expect(read(tmp).deniedMcpServers).toEqual([{ serverName: 'claude.ai Gmail' }])
    expect(hasAnyPolicyHook(read(tmp))).toBe(true)
    // Connectors re-written: hook kept.
    writeClaudeConnectorDenyFile(tmp, ['claude.ai Drive', 'claude.ai Gmail'])
    expect(hasAnyPolicyHook(read(tmp))).toBe(true)
    expect(read(tmp).deniedMcpServers).toHaveLength(2)
    // Connectors cleared: hook kept, key gone.
    writeClaudeConnectorDenyFile(tmp, [])
    expect(read(tmp).deniedMcpServers).toBeUndefined()
    expect(hasAnyPolicyHook(read(tmp))).toBe(true)
    // Policy off: our entry removed; nothing left → file removed.
    vi.stubEnv('SPECRAILS_AGENT_POLICY_HOOK', 'false')
    expect(installPolicyHookIn(tmp, tmp)).toBe(false)
    expect(fs.existsSync(settingsFile(tmp))).toBe(false)
  })

  it('writes the script once per version and points the hook at it', () => {
    const script = ensurePolicyHookScript(tmp)!
    expect(path.basename(script)).toBe(`specrails-policy-hook-${POLICY_HOOK_VERSION}.cjs`)
    expect((fs.statSync(script).mode & 0o777)).toBe(0o600)
    installPolicyHookIn(tmp, tmp)
    expect(JSON.stringify(read(tmp))).toContain(script)
  })

  it('replaces a symlinked settings file instead of writing through it', () => {
    const outside = path.join(tmp, 'outside.json')
    fs.writeFileSync(outside, '{"a":1}')
    fs.mkdirSync(path.join(tmp, 'cwd', '.claude'), { recursive: true })
    fs.symlinkSync(outside, settingsFile(path.join(tmp, 'cwd')))
    updateClaudeLocalSettings(path.join(tmp, 'cwd'), (s) => ({ ...s, b: 2 }))
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"a":1}')
    expect(fs.lstatSync(settingsFile(path.join(tmp, 'cwd'))).isSymbolicLink()).toBe(false)
    expect(read(path.join(tmp, 'cwd'))).toEqual({ a: 1, b: 2 })
  })
})

describe('denial marker', () => {
  const reason = 'Blocked by Specrails policy: Force-pushing rewrites shared history. Do not retry it another way; continue without it or explain what you need. [specrails-policy:git-force-push]'

  it('parses Claude hook errors and ignores look-alikes', () => {
    expect(parsePolicyDenial(`PreToolUse:Bash hook error: ${reason}`)).toEqual({ rule: 'git-force-push', reason: 'Force-pushing rewrites shared history.' })
    expect(parsePolicyDenial(`Exit code 1\n${reason}`)).toBeNull()
    expect(parsePolicyDenial('PreToolUse:Bash hook error: [specrails-policy:not-a-rule]')).toBeNull()
  })

  it('reads denials from a Claude stream-json user frame', () => {
    const frame = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: `PreToolUse:Bash hook error: ${reason}` }, { type: 'tool_result', tool_use_id: 't2', is_error: true, content: `Exit code 1\n${reason}` }] },
      tool_result_meta: [{ id: 't1', permission_decision: { decision: 'reject', source: 'hook' } }],
    }
    expect(claudeFrameDenials(frame)).toEqual([{ rule: 'git-force-push', reason: 'Force-pushing rewrites shared history.', toolUseId: 't1' }])
    expect(claudeFrameDenials({ type: 'assistant' })).toEqual([])
    expect(claudeFrameDenials(null)).toEqual([])
  })
})

describe('denial spool → audit', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  function audit() {
    const store = createSqliteAgentActionStore(db)
    const recorder = createAgentAuditRecorder({ store, schedule: () => ({ cancel() {} }) })
    return { recorder, service: createAgentAuditService({ store, recorder }), store }
  }

  function spool(dir: string, report: Record<string, unknown>, ageMs: number): string {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${Math.random()}.json`)
    fs.writeFileSync(file, JSON.stringify(report))
    const at = (Date.now() - ageMs) / 1000
    fs.utimesSync(file, at, at)
    return file
  }

  const report = (projectDir: string) => ({ v: 1, at: new Date().toISOString(), rule: 'git-force-push', reason: 'no', tool: 'Bash', target: 'git push --force --token=abc123', toolUseId: 't9', sessionId: 's', projectDir, cwd: projectDir })

  it('records runs found through rail_worktrees, once, and redacts the command', () => {
    const a = audit()
    db.prepare("INSERT INTO rail_worktrees (id, rail_index, ticket_id, run_id, branch, worktree_path) VALUES ('w1', 0, 1, 'run-7', 'feat/x', '/wt/run-7')").run()
    const dir = path.join(tmp, 'denials')
    const ingest = createDenialIngest({ missionCwd: () => '/h/.specrails/agent-cwd', projects: () => [{ db, audit: a }] })
    const young = spool(dir, report('/wt/run-7'), 0)
    expect(drainDenialSpool({ dir, ingest })).toBe(0)
    expect(fs.existsSync(young)).toBe(true) // grace period: the stream records first
    fs.utimesSync(young, (Date.now() - DENIAL_SPOOL_GRACE_MS - 1000) / 1000, (Date.now() - DENIAL_SPOOL_GRACE_MS - 1000) / 1000)
    expect(drainDenialSpool({ dir, ingest })).toBe(1)
    expect(fs.existsSync(young)).toBe(false)
    a.recorder.flush()
    const rows = a.store.listByRun('run-7', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'exec', source: 'policy-hook' })
    expect(rows[0]!.target).toMatch(/^denied by policy \(git-force-push\): git push --force --token=\*\*\*/)
    // A second report of the same denial (stream + spool) is not recorded twice.
    spool(dir, report('/wt/run-7'), DENIAL_SPOOL_GRACE_MS + 1000)
    drainDenialSpool({ dir, ingest })
    a.recorder.flush()
    expect(a.store.listByRun('run-7', 10)).toHaveLength(1)
  })

  it('skips mission cwd reports and keeps unknown ones until they expire', () => {
    const dir = path.join(tmp, 'denials')
    const ingest = createDenialIngest({ missionCwd: () => '/h/.specrails/agent-cwd', projects: () => [] })
    const mission = spool(dir, report('/h/.specrails/agent-cwd'), DENIAL_SPOOL_GRACE_MS + 1000)
    const unknown = spool(dir, report('/somewhere'), DENIAL_SPOOL_GRACE_MS + 1000)
    const expired = spool(dir, report('/elsewhere'), DENIAL_SPOOL_MAX_AGE_MS + 1000)
    const junk = path.join(dir, 'junk.json'); fs.writeFileSync(junk, 'nope'); fs.utimesSync(junk, 0, 0)
    drainDenialSpool({ dir, ingest })
    expect(fs.existsSync(mission)).toBe(false)
    expect(fs.existsSync(unknown)).toBe(true)
    expect(fs.existsSync(expired)).toBe(false)
    expect(fs.existsSync(junk)).toBe(false)
    expect(parseDenialReport('{"v":2}')).toBeNull()
  })
})
