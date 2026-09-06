import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runAiCliInvocation } = vi.hoisted(() => ({ runAiCliInvocation: vi.fn() }))
vi.mock('../spawn-lifecycle', () => ({ runAiCliInvocation }))
vi.mock('../workspace-manager', async (original) => ({
  ...await original<typeof import('../workspace-manager')>(),
  ensureFrameworkAgents: vi.fn(), ensureFrameworkCommandSubtrees: vi.fn(),
}))
import { PluginManager } from '../plugin-manager'
import { BUNDLED_PLUGINS } from './index'
import { setPluginManagerForTesting } from './manager'
import { buildCodexPluginArgs } from './codex-spawn'
import { codexAdapter } from '../providers/codex-adapter'
import { createLoopExecutors } from '../loop-executors'

let root: string
let stateRoot: string
let repositoryPath: string
function state(plugins: unknown) {
  fs.mkdirSync(path.join(stateRoot, '.specrails', 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(stateRoot, '.specrails', 'plugins', 'state.json'), JSON.stringify({ schemaVersion: 1, plugins }))
}
function build(legacyProviderId = 'codex') {
  return buildCodexPluginArgs({ providerId: 'codex', stateRoot, repositoryPath, legacyProviderId })
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-'))
  stateRoot = path.join(root, 'Artifact workspace')
  repositoryPath = path.join(root, 'Worktree José', 'API & UI')
  fs.mkdirSync(repositoryPath, { recursive: true })
  setPluginManagerForTesting(new PluginManager(BUNDLED_PLUGINS))
  runAiCliInvocation.mockReset().mockResolvedValue({ spawnFailed: false, code: 0, events: [], sessionId: 'sid', stderrTail: '' })
})
afterEach(() => {
  setPluginManagerForTesting(null)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('installed Codex plugins reach the real provider invocation', () => {
  it('loads shared project activation for first and resumed loop steps in an isolated source worktree', async () => {
    state({ serena: { providers: { codex: { active: true } } } })
    const ex = createLoopExecutors({ env: {}, pluginScope: () => ({ stateRoot, legacyProviderId: 'claude' }) })
    for (const sessionId of [undefined, 'existing-session']) {
      await ex.runAiStep({ provider: 'codex', prompt: 'Inspect source', model: 'gpt-6-astra', cwd: repositoryPath, repoDir: repositoryPath, sessionId })
    }
    expect(runAiCliInvocation).toHaveBeenCalledTimes(2)
    expect(runAiCliInvocation.mock.calls.map(([input]) => input.action)).toEqual(['rail-job', 'chat-resume'])
    for (const [input] of runAiCliInvocation.mock.calls) {
      expect(input.buildOpts.extraArgs).toContain('mcp_servers.serena.command="uvx"')
      const entry = input.buildOpts.extraArgs.find((arg: string) => arg.startsWith('mcp_servers.serena.args='))
      const args: string[] = JSON.parse(entry.slice(entry.indexOf('=') + 1))
      expect(args[args.indexOf('--project') + 1]).toBe(repositoryPath)
      expect(input.env.CODEX_HOME).toBeUndefined()
    }
    expect(fs.existsSync(path.join(repositoryPath, '.specrails', 'plugins', 'state.json'))).toBe(false)
  })

  it.each(['rail-job', 'chat-turn', 'chat-resume'] as const)('binds Serena to the source worktree for %s without replacing the auth home', (action) => {
    state({ serena: { providers: { codex: { active: true } } } })
    const authHome = path.join(root, 'User Codex Login')
    vi.stubEnv('CODEX_HOME', authHome)
    const extraArgs = build('claude') // per-provider activation wins over primary provider
    const args = codexAdapter.buildArgs(action, { prompt: 'Inspect this code', model: 'gpt-6-astra', sessionId: 'existing-session', extraArgs })
    expect(args).toContain('mcp_servers.serena.command="uvx"')
    expect(args).toContain('mcp_servers.serena.enabled=true')
    const value = args.find((arg) => arg.startsWith('mcp_servers.serena.args='))!
    const commandArgs = JSON.parse(value.slice(value.indexOf('=') + 1)) as string[]
    expect(commandArgs[commandArgs.indexOf('--project') + 1]).toBe(repositoryPath)
    expect(commandArgs).toContain('--enable-web-dashboard')
    expect(process.env.CODEX_HOME).toBe(authHome)
    expect(args.some((arg) => arg.includes(authHome))).toBe(false)
    expect(args.some((arg) => arg.startsWith('mcp_servers.specrails'))).toBe(false)
  })

  it.each([
    { serena: { providers: { codex: { active: false } } } },
    { serena: { providers: { claude: { active: true } } } },
    { unknownPlugin: { providers: { codex: { active: true } } } },
    { serena: null },
  ])('does not activate absent, inactive, orphaned or malformed records', (plugins) => {
    state(plugins)
    expect(build()).toEqual([])
  })

  it('limits old provider-agnostic records to the legacy owning provider and the selected project', () => {
    state({ serena: { version: '1.0.0' } })
    expect(build()).not.toEqual([])
    expect(build('claude')).toEqual([])
    expect(buildCodexPluginArgs({ providerId: 'codex', stateRoot: root, repositoryPath })).toEqual([])
    expect(buildCodexPluginArgs({ providerId: 'claude', stateRoot, repositoryPath })).toEqual([])
  })

  it('tolerates a missing or incomplete optional state file', () => {
    expect(build()).toEqual([])
    state(undefined)
    expect(build()).toEqual([])
  })
})
