import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { Plugin, WsMessage } from './types'
import {
  PluginManager,
  PluginAlreadyInstalledError,
  PluginInstallError,
  PluginNotFoundError,
  PluginNotInstalledError,
} from './plugin-manager'

let tmpDir: string
let captured: WsMessage[]
const broadcast = (m: WsMessage) => { captured.push(m) }

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mgr-'))
  captured = []
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeSerena(opts: Partial<{ verifyOk: boolean; verifyReason: string; throwOnInstall: boolean }> = {}): Plugin {
  return {
    manifest: {
      name: 'serena',
      version: '1.0.0',
      description: 'semantic nav',
      whatItDoes: ['x'],
      requirements: [{ name: 'uv', minVersion: '0.1.0' }],
      owns: { mcpServers: ['serena'], agentFragments: ['.claude/agents/custom-serena.md'] },
    },
    install: async (ctx) => {
      if (opts.throwOnInstall) throw new Error('boom')
      await PluginManager.mergeMcpServers(ctx.projectPath, {
        serena: { command: 'uvx', args: ['serena'] },
      })
      const fragRel = '.claude/agents/custom-serena.md'
      const frag = path.join(ctx.projectPath, fragRel)
      fs.mkdirSync(path.dirname(frag), { recursive: true })
      fs.writeFileSync(frag, '# serena')
      ctx.recordInstalledFile(fragRel)
      ctx.log('installed')
    },
    uninstall: async (ctx) => {
      await PluginManager.removeMcpServers(ctx.projectPath, ['serena'])
      const frag = path.join(ctx.projectPath, '.claude/agents/custom-serena.md')
      if (fs.existsSync(frag)) fs.unlinkSync(frag)
    },
    verify: async () => ({
      ok: opts.verifyOk ?? true,
      reason: opts.verifyReason,
      checkedAt: new Date().toISOString(),
    }),
    expectedMcpEntry: () => ({ command: 'uvx', args: ['serena'] }),
  }
}

function makeProviderAwareSerena(): Plugin {
  return {
    manifest: {
      name: 'serena',
      version: '1.0.0',
      description: 'semantic nav',
      whatItDoes: ['x'],
      owns: { mcpServers: ['serena'] },
      providerSupport: {
        claude: { mcpEntry: { command: 'uvx', args: ['serena'] } },
        codex: { mcpEntry: { command: 'uvx', args: ['serena'] } },
        kimi: { mcpEntry: { command: 'uvx', args: ['serena'] } },
      },
      claudeMdInstructions: '## Serena provider instructions',
    },
    install: async (ctx) => {
      await PluginManager.mergeMcpServers(
        ctx.projectPath,
        { serena: { command: 'uvx', args: ['serena'] } },
        ctx.providerId,
      )
    },
    uninstall: async (ctx) => {
      await PluginManager.removeMcpServers(ctx.projectPath, ['serena'], ctx.providerId)
    },
    verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    expectedMcpEntry: () => ({ command: 'uvx', args: ['serena'] }),
  }
}

describe('PluginManager.listAvailable', () => {
  it('reports not-installed for fresh project', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    const list = await m.listAvailable(tmpDir)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('not-installed')
  })

  it('reports installed after install + verify', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const list = await m.listAvailable(tmpDir)
    expect(list[0].status).toBe('installed')
    expect(list[0].installedAt).toBeDefined()
  })

  it('reports orphan for plugin in state.json but not in registry', async () => {
    const stateDir = path.join(tmpDir, '.specrails', 'plugins')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: { 'old-thing': { version: '0.1.0', installedAt: 'now', installedFiles: [] } },
    }))
    const m = new PluginManager([])
    const list = await m.listAvailable(tmpDir)
    expect(list[0].status).toBe('orphan')
  })

  it('reports installed (active) immediately after install — .mcp.json has the key', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    expect((await m.listAvailable(tmpDir))[0].status).toBe('installed')
  })

  it('setActive(false) removes mcp entry → status deactivated; setActive(true) re-adds → installed', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    expect((await m.listAvailable(tmpDir))[0].status).toBe('installed')

    await m.setActive(tmpDir, 'pid', 'serena', false, broadcast)
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena).toBeUndefined()
    expect((await m.listAvailable(tmpDir))[0].status).toBe('deactivated')

    await m.setActive(tmpDir, 'pid', 'serena', true, broadcast)
    const mcp2 = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp2.mcpServers.serena).toBeDefined()
    expect((await m.listAvailable(tmpDir))[0].status).toBe('installed')
  })

  it('install writes CLAUDE.md block when manifest declares claudeMdInstructions', async () => {
    const plugin = makeSerena()
    plugin.manifest.claudeMdInstructions = '## serena hint'
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const md = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(md).toContain('## serena hint')
    expect(md).toContain('specrails-desktop-managed:serena')
  })

  it('uninstall removes CLAUDE.md block but preserves user content', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\nMy notes.\n')
    const plugin = makeSerena()
    plugin.manifest.claudeMdInstructions = '## serena hint'
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await m.uninstall(tmpDir, 'pid', 'serena', broadcast)
    const md = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(md).toContain('My notes.')
    expect(md).not.toContain('serena hint')
    expect(md).not.toContain('specrails-desktop-managed:serena')
  })

  it('setActive(false) removes CLAUDE.md block; setActive(true) restores it', async () => {
    const plugin = makeSerena()
    plugin.manifest.claudeMdInstructions = '## hint'
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await m.setActive(tmpDir, 'pid', 'serena', false, broadcast)
    // CLAUDE.md is deleted when the managed block was the only content.
    const claudeMd = path.join(tmpDir, 'CLAUDE.md')
    if (fs.existsSync(claudeMd)) {
      expect(fs.readFileSync(claudeMd, 'utf8')).not.toContain('## hint')
    }
    await m.setActive(tmpDir, 'pid', 'serena', true, broadcast)
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('## hint')
  })

  it('setActive preserves user-authored sibling mcpServers entries', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await m.setActive(tmpDir, 'pid', 'serena', false, broadcast)
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.myown.command).toBe('me')
    expect(mcp.mcpServers.serena).toBeUndefined()
  })

  it('reports degraded when health is degraded', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    // Manually mark degraded.
    const sf = path.join(tmpDir, '.specrails', 'plugins', 'state.json')
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'))
    s.plugins.serena.health = 'degraded'
    fs.writeFileSync(sf, JSON.stringify(s))
    const list = await m.listAvailable(tmpDir)
    expect(list[0].status).toBe('degraded')
  })
})

describe('PluginManager provider-scoped state', () => {
  it('installs the same plugin independently for Claude and Kimi', async () => {
    const m = new PluginManager([makeProviderAwareSerena()])
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'claude', 'slug', 'claude')
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'kimi', 'slug', 'claude')

    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')))
      .toHaveProperty('mcpServers.serena')
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.kimi-code', 'mcp.json'), 'utf8')))
      .toHaveProperty('mcpServers.serena')
    expect((await m.listAvailable(tmpDir, 'claude', 'claude'))[0].status).toBe('installed')
    expect((await m.listAvailable(tmpDir, 'kimi', 'claude'))[0].status).toBe('installed')

    const state = m.getProjectState(tmpDir).plugins.serena
    expect(Object.keys(state.providers ?? {}).sort()).toEqual(['claude', 'kimi'])
  })

  it('uninstalling Kimi preserves the Claude registration and provider state', async () => {
    const m = new PluginManager([makeProviderAwareSerena()])
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'claude', 'slug', 'claude')
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'kimi', 'slug', 'claude')
    await m.uninstall(tmpDir, 'pid', 'serena', broadcast, 'kimi', 'slug', 'claude')

    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')))
      .toHaveProperty('mcpServers.serena')
    expect((await m.listAvailable(tmpDir, 'claude', 'claude'))[0].status).toBe('installed')
    expect((await m.listAvailable(tmpDir, 'kimi', 'claude'))[0].status).toBe('not-installed')
    expect(m.getProjectState(tmpDir).plugins.serena.providers)
      .toEqual(expect.objectContaining({ claude: expect.any(Object) }))
  })

  it('keeps Codex and Kimi instruction contributions independent on uninstall', async () => {
    const m = new PluginManager([makeProviderAwareSerena()])
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'kimi', 'slug', 'kimi')
    await m.install(tmpDir, 'pid', 'serena', broadcast, 'codex', 'slug', 'kimi')

    const codexAgents = path.join(tmpDir, 'AGENTS.md')
    const kimiAgents = path.join(tmpDir, '.kimi-code', 'AGENTS.md')
    expect(fs.readFileSync(codexAgents, 'utf8')).toContain('Serena provider instructions')
    expect(fs.readFileSync(kimiAgents, 'utf8')).toContain('Serena provider instructions')

    await m.uninstall(tmpDir, 'pid', 'serena', broadcast, 'kimi', 'slug', 'kimi')
    expect(fs.existsSync(kimiAgents)).toBe(false)
    expect(fs.readFileSync(codexAgents, 'utf8')).toContain('Serena provider instructions')

    await m.uninstall(tmpDir, 'pid', 'serena', broadcast, 'codex', 'slug', 'kimi')
    expect(fs.existsSync(codexAgents)).toBe(false)
  })
})

describe('PluginManager.previewInstall', () => {
  it('marks .mcp.json as create on a fresh project', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    const preview = await m.previewInstall(tmpDir, 'pid', 'serena')
    const mcp = preview.files.find((f) => f.path === '.mcp.json')
    expect(mcp?.op).toBe('create')
    expect(preview.files.some((f) => f.path === '.specrails/plugins/state.json')).toBe(true)
  })

  it('marks .mcp.json as modify when present', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    const preview = await m.previewInstall(tmpDir, 'pid', 'serena')
    const mcp = preview.files.find((f) => f.path === '.mcp.json')
    expect(mcp?.op).toBe('modify')
  })

  it('throws PluginNotFoundError for unknown plugin', async () => {
    const m = new PluginManager([])
    await expect(m.previewInstall(tmpDir, 'pid', 'nope')).rejects.toBeInstanceOf(PluginNotFoundError)
  })

  it('does not mutate the project filesystem', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.previewInstall(tmpDir, 'pid', 'serena')
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'))).toBe(false)
  })
})

describe('PluginManager.install', () => {
  it('creates .mcp.json with the serena entry', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena.command).toBe('uvx')
  })

  it('writes state.json with installedFiles', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.serena.version).toBe('1.0.0')
    expect(s.plugins.serena.installedFiles).toContain('.claude/agents/custom-serena.md')
    expect(s.plugins.serena.health).toBe('ok')
  })

  it('preserves user-authored mcpServers entries', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.myown.command).toBe('me')
    expect(mcp.mcpServers.serena).toBeDefined()
  })

  it('rejects install when the user already has an mcpServers.<owned> entry', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { command: 'mine' } } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/already has/)
  })

  it('rolls back .mcp.json byte-identical when install throws', async () => {
    const before = JSON.stringify({ mcpServers: { existing: {} } }, null, 2)
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), before)
    const m = new PluginManager([makeSerena({ throwOnInstall: true })])
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toBeInstanceOf(PluginInstallError)
    expect(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')).toBe(before)
  })

  it('rolls back when verify reports !ok', async () => {
    const before = JSON.stringify({ mcpServers: { existing: {} } }, null, 2)
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), before)
    const m = new PluginManager([makeSerena({ verifyOk: false, verifyReason: 'uv-not-on-path' })])
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/verify failed/)
    expect(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8')).toBe(before)
    // state.json should not contain serena.
    const sf = path.join(tmpDir, '.specrails', 'plugins', 'state.json')
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'))
      expect(s.plugins.serena).toBeUndefined()
    }
  })

  it('emits plugin.installed on success', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    expect(captured.some((m) => m.type === 'plugin.installed')).toBe(true)
  })

  it('throws PluginAlreadyInstalledError on second install', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toBeInstanceOf(PluginAlreadyInstalledError)
  })

  it('rejects with PluginInstallError (not a raw SyntaxError → 500) when .mcp.json is malformed', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{ this is : not valid json')
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toBeInstanceOf(PluginInstallError)
  })

  it('rolls back an agent-fragment file byte-identically even with non-UTF8 bytes', async () => {
    const fragRel = '.claude/agents/custom-serena.md'
    const frag = path.join(tmpDir, fragRel)
    fs.mkdirSync(path.dirname(frag), { recursive: true })
    // '# ' followed by bytes that are NOT valid UTF-8, then a newline.
    const original = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])
    fs.writeFileSync(frag, original)

    const m = new PluginManager([makeSerena({ verifyOk: false, verifyReason: 'x' })])
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/verify failed/)

    // Pre-fix the rollback round-tripped through toString('utf8') and corrupted
    // the bytes to U+FFFD; the Buffer write must restore them exactly.
    expect(fs.readFileSync(frag).equals(original)).toBe(true)
  })
})

describe('PluginManager.verify health caching', () => {
  it('does not re-broadcast health_changed when verify result is unchanged', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    captured.length = 0
    await m.verify(tmpDir, 'pid', 'serena', broadcast) // still ok → unchanged
    expect(captured.some((msg) => msg.type === 'plugin.health_changed')).toBe(false)
  })

  it('broadcasts health_changed when verify result flips to degraded', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    captured.length = 0
    // Swap in a plugin whose verify now fails for the same name.
    const m2 = new PluginManager([makeSerena({ verifyOk: false, verifyReason: 'uv-gone' })])
    await m2.verify(tmpDir, 'pid', 'serena', broadcast)
    expect(captured.some((msg) => msg.type === 'plugin.health_changed')).toBe(true)
  })
})

describe('PluginManager.uninstall', () => {
  it('removes only owned mcpServers entry', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await m.uninstall(tmpDir, 'pid', 'serena', broadcast)
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.myown).toBeDefined()
    expect(mcp.mcpServers.serena).toBeUndefined()
  })

  it('drops state.json entry', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await m.uninstall(tmpDir, 'pid', 'serena', broadcast)
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.serena).toBeUndefined()
  })

  it('emits plugin.uninstalled', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    captured = []
    await m.uninstall(tmpDir, 'pid', 'serena', broadcast)
    expect(captured.some((m) => m.type === 'plugin.uninstalled')).toBe(true)
  })

  it('throws when plugin not installed', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await expect(m.uninstall(tmpDir, 'pid', 'serena', broadcast)).rejects.toBeInstanceOf(PluginNotInstalledError)
  })

  it('removes orphan when registry no longer has the plugin', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    // Simulate orphaning by re-creating manager without serena.
    const orphanMgr = new PluginManager([])
    await orphanMgr.uninstall(tmpDir, 'pid', 'serena', broadcast)
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.serena).toBeUndefined()
  })
})

describe('PluginManager.verify', () => {
  it('returns ok=true for a healthy plugin', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const v = await m.verify(tmpDir, 'pid', 'serena', broadcast)
    expect(v.ok).toBe(true)
  })

  it('emits plugin.health_changed when health flips', async () => {
    const plugin = makeSerena()
    let toggle = true
    plugin.verify = async () => ({ ok: toggle, checkedAt: new Date().toISOString() })
    const m = new PluginManager([plugin])
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    captured = []
    toggle = false
    await m.verify(tmpDir, 'pid', 'serena', broadcast)
    expect(captured.some((m) => m.type === 'plugin.health_changed')).toBe(true)
  })

  it('classifies long verify as verify-timeout', async () => {
    const plugin = makeSerena()
    plugin.verify = () => new Promise(() => { /* never resolves */ })
    plugin.manifest.verifyTimeoutMs = 50
    const m = new PluginManager([plugin], { defaultVerifyTimeoutMs: 50 })
    // Cannot install because verify times out → install rolls back.
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/verify failed/)
  })

  it('classifies thrown error as verify-exception', async () => {
    const plugin = makeSerena()
    plugin.verify = async () => { throw new Error('nope') }
    const m = new PluginManager([plugin])
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/verify failed/)
  })

  it('throws PluginNotFoundError for unknown plugin', async () => {
    const m = new PluginManager([])
    await expect(m.verify(tmpDir, 'pid', 'nope', broadcast)).rejects.toBeInstanceOf(PluginNotFoundError)
  })
})

describe('PluginManager concurrent installs serialize', () => {
  it('two parallel installs of distinct plugins succeed without lost update', async () => {
    const a: Plugin = {
      manifest: { name: 'a', version: '1', description: '', whatItDoes: [], owns: { mcpServers: ['a'] } },
      install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { a: { command: 'a' } }) },
      uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, ['a']) },
      verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    }
    const b: Plugin = {
      manifest: { name: 'b', version: '1', description: '', whatItDoes: [], owns: { mcpServers: ['b'] } },
      install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { b: { command: 'b' } }) },
      uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, ['b']) },
      verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    }
    const m = new PluginManager([a, b])
    await Promise.all([
      m.install(tmpDir, 'pid', 'a', broadcast),
      m.install(tmpDir, 'pid', 'b', broadcast),
    ])
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.a).toBeDefined()
    expect(mcp.mcpServers.b).toBeDefined()
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.a).toBeDefined()
    expect(s.plugins.b).toBeDefined()
  })
})

describe('PluginManager.updateMcpEntry', () => {
  it('rewrites the owned mcpServers entry to match expectedMcpEntry', async () => {
    const plugin = makeSerena()
    plugin.expectedMcpEntry = () => ({ command: 'uvx', args: ['serena', 'start-mcp-server'] })
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    // Simulate drift: stomp the on-disk entry with old args.
    const fp = require('path').join(tmpDir, '.mcp.json')
    require('fs').writeFileSync(fp, JSON.stringify({ mcpServers: { serena: { command: 'uvx', args: ['serena-mcp-server'] }, myown: { command: 'me' } } }))
    await m.updateMcpEntry(tmpDir, 'pid', 'serena', broadcast)
    const after = JSON.parse(require('fs').readFileSync(fp, 'utf8'))
    expect(after.mcpServers.serena.args).toEqual(['serena', 'start-mcp-server'])
    expect(after.mcpServers.myown.command).toBe('me')
  })

  it('throws when plugin is not installed', async () => {
    const plugin = makeSerena()
    plugin.expectedMcpEntry = () => ({ command: 'uvx' })
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await expect(m.updateMcpEntry(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/not installed/)
  })

  it('throws when plugin lacks expectedMcpEntry', async () => {
    const plugin = makeSerena()
    delete plugin.expectedMcpEntry
    const m = new PluginManager([plugin], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await expect(m.updateMcpEntry(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/expectedMcpEntry/)
  })
})

describe('PluginManager.removeOrphan', () => {
  it('rejects when plugin is still bundled', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    await expect(m.removeOrphan(tmpDir, 'pid', 'serena', broadcast)).rejects.toThrow(/not orphan/)
  })
})

describe('BUG-PLUGIN-04: orphan removal strips owned mcpServers from .mcp.json', () => {
  it('persists ownedMcpServers in state at install time', async () => {
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.serena.ownedMcpServers).toEqual(['serena'])
  })

  it('orphan removal strips the .mcp.json entry using the persisted keys', async () => {
    // Install via the real plugin (records ownedMcpServers), plus a user entry.
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await m.install(tmpDir, 'pid', 'serena', broadcast)
    let mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena).toBeDefined()

    // Ship a build that dropped serena from the registry → it is now orphan.
    const orphanMgr = new PluginManager([])
    await orphanMgr.uninstall(tmpDir, 'pid', 'serena', broadcast)

    mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena).toBeUndefined() // stripped despite missing plugin code
    expect(mcp.mcpServers.myown.command).toBe('me') // user entry preserved
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.serena).toBeUndefined()
  })

  it('orphan removal leaves .mcp.json alone when state has no ownedMcpServers (legacy state file)', async () => {
    // A pre-fix state.json (no ownedMcpServers) + a stale .mcp.json entry.
    const stateDir = path.join(tmpDir, '.specrails', 'plugins')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: { legacy: { version: '0.1.0', installedAt: 'now', installedFiles: [] } },
    }))
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: { legacy: { command: 'x' } } }))
    const m = new PluginManager([])
    await m.uninstall(tmpDir, 'pid', 'legacy', broadcast)
    // No keys to strip — entry remains (acceptable for legacy; no regression).
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.legacy).toBeDefined()
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    expect(s.plugins.legacy).toBeUndefined()
  })
})

describe('BUG-PLUGIN-05: mergeMcpServers rejects a non-object mcpServers', () => {
  it('throws PluginInstallError when .mcp.json mcpServers is a JSON array', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: [] }))
    await expect(
      PluginManager.mergeMcpServers(tmpDir, { serena: { command: 'uvx' } }),
    ).rejects.toBeInstanceOf(PluginInstallError)
  })

  it('install fails (rolled back) when .mcp.json mcpServers is an array — never silently records installed', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers: [] }))
    const m = new PluginManager([makeSerena()], { claudeApprovalChecker: () => 'enabled' })
    await expect(m.install(tmpDir, 'pid', 'serena', broadcast)).rejects.toBeInstanceOf(PluginInstallError)
    // state.json must NOT report serena installed.
    const sf = path.join(tmpDir, '.specrails', 'plugins', 'state.json')
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'))
      expect(s.plugins.serena).toBeUndefined()
    }
  })

  it('still merges normally when mcpServers is a plain object or absent', async () => {
    await PluginManager.mergeMcpServers(tmpDir, { serena: { command: 'uvx' } })
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena.command).toBe('uvx')
  })
})

describe('BUG-PLUGIN-02/03: state.json mutations are atomic under one lock', () => {
  function makeNamed(name: string, key: string): Plugin {
    return {
      manifest: { name, version: '1', description: '', whatItDoes: [], owns: { mcpServers: [key] } },
      install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { [key]: { command: key } }) },
      uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, [key]) },
      verify: async () => ({ ok: false, reason: `${name}-down`, checkedAt: new Date().toISOString() }),
    }
  }

  it('two concurrent verifies both flip health to degraded without losing one update', async () => {
    const a = makeNamed('a', 'a')
    const b = makeNamed('b', 'b')
    const m = new PluginManager([a, b])
    // Install both healthy first (verify returns ok via override).
    const installA: Plugin = { ...a, verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }) }
    const installB: Plugin = { ...b, verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }) }
    const installer = new PluginManager([installA, installB])
    await installer.install(tmpDir, 'pid', 'a', broadcast)
    await installer.install(tmpDir, 'pid', 'b', broadcast)

    // Now race two verifies (both report degraded). Pre-fix one update is lost.
    await Promise.all([
      m.verify(tmpDir, 'pid', 'a', broadcast),
      m.verify(tmpDir, 'pid', 'b', broadcast),
    ])
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.a.health).toBe('degraded')
    expect(s.plugins.b.health).toBe('degraded')
    expect(s.plugins.a.healthReason).toBe('a-down')
    expect(s.plugins.b.healthReason).toBe('b-down')
  })

  it('install commit races a verify on a different plugin without dropping either record', async () => {
    const a: Plugin = {
      manifest: { name: 'a', version: '1', description: '', whatItDoes: [], owns: { mcpServers: ['a'] } },
      install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { a: { command: 'a' } }) },
      uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, ['a']) },
      verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    }
    const m = new PluginManager([a])
    await m.install(tmpDir, 'pid', 'a', broadcast)

    // Race a fresh install of b against a verify-driven health write on a.
    const b: Plugin = {
      manifest: { name: 'b', version: '1', description: '', whatItDoes: [], owns: { mcpServers: ['b'] } },
      install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { b: { command: 'b' } }) },
      uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, ['b']) },
      verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    }
    const aDegraded: Plugin = { ...a, verify: async () => ({ ok: false, reason: 'a-gone', checkedAt: new Date().toISOString() }) }
    const m2 = new PluginManager([aDegraded, b])
    await Promise.all([
      m2.install(tmpDir, 'pid', 'b', broadcast),
      m2.verify(tmpDir, 'pid', 'a', broadcast),
    ])
    const s = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.a).toBeDefined()
    expect(s.plugins.a.health).toBe('degraded')
    expect(s.plugins.b).toBeDefined()
  })
})
