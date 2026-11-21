import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { MissionConnectors, writeClaudeConnectorDenyFile, writeGeminiExcluded } from './mission-connectors-discovery'

let db: DbInstance
let home: string

beforeEach(() => {
  db = initDesktopDb(':memory:')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-connectors-'))
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.blender]\ncommand = "uvx"\nargs = ["blender-mcp"]\n\n[mcp_servers.specrails]\ncommand = "node"\n')
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { tokensave: { command: 'tokensave', args: ['serve'] } }, claudeAiMcpEverConnected: ['claude.ai Gmail'] }))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function service(overrides: Partial<ConstructorParameters<typeof MissionConnectors>[0]> = {}) {
  return new MissionConnectors({ db, env: {}, home: () => home, listClaudeConnectors: async () => 'claude.ai Google Drive: https://d - ✔ Connected\n', ...overrides })
}

describe('MissionConnectors', () => {
  it('lists every provider with defaults on and the duplicate locked', async () => {
    const view = await service().view({ refresh: true, injected: (provider) => provider === 'claude' ? ['tokensave'] : [] })
    const byProvider = Object.fromEntries(view.providers.map((entry) => [entry.provider, entry]))
    expect(byProvider.codex!.connectors.map((row) => [row.name, row.enabled, row.lock ?? null])).toEqual([['blender', true, null], ['specrails', false, 'specrails-duplicate']])
    expect(byProvider.claude!.connectors.map((row) => [row.name, row.kind, row.lock ?? null])).toEqual([['claude.ai Google Drive', 'account-connector', null], ['tokensave', 'mcp-server', 'external-mcp']])
    expect(byProvider.claude!.userServersNeedToolSearch).toBe(true)
    expect(byProvider.kimi!.detected).toBe(false)
    expect(view.claudeAccountListStale).toBe(false)
  })

  it('respects CODEX_HOME and falls back to remembered claude.ai connectors', async () => {
    const codexHome = path.join(home, 'alt-codex')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.other]\ncommand = "x"\n')
    const view = await service({ env: { CODEX_HOME: codexHome }, listClaudeConnectors: async () => null }).view()
    expect(view.providers.find((entry) => entry.provider === 'codex')!.connectors.map((row) => row.name)).toEqual(['other'])
    expect(view.providers.find((entry) => entry.provider === 'claude')!.connectors.map((row) => row.name)).toEqual(['claude.ai Gmail', 'tokensave'])
    expect(view.claudeAccountListStale).toBe(true)
  })

  it('caches the discovery, coalesces concurrent reads and refreshes on demand', async () => {
    const list = vi.fn(async () => '')
    const connectors = service({ listClaudeConnectors: list })
    await Promise.all([connectors.view(), connectors.view()])
    await connectors.view()
    expect(list).toHaveBeenCalledTimes(1)
    await connectors.view({ refresh: true })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('refreshes a stale cache in the background', async () => {
    let now = new Date('2026-11-18T10:00:00Z')
    const list = vi.fn(async () => '')
    const connectors = service({ listClaudeConnectors: list, now: () => now })
    await connectors.view()
    now = new Date('2026-11-18T10:11:00Z')
    await connectors.view()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('stores toggles and plans the next turn from them, never probing Claude Code for a turn', async () => {
    const list = vi.fn(async () => '')
    const connectors = service({ listClaudeConnectors: list })
    connectors.toggle({ provider: 'codex', name: 'blender', enabled: false })
    connectors.toggle({ provider: 'claude', name: 'claude.ai Gmail', enabled: false })
    expect(await connectors.planFor('codex', { reserved: ['specrails'] })).toEqual({ inheritUserScope: false, servers: [], denied: ['blender'] })
    expect((await connectors.planFor('claude', { reserved: ['specrails'] })).denied).toEqual(['claude.ai Gmail'])
    expect(list).not.toHaveBeenCalled()
    expect(() => connectors.toggle({ provider: 'nope', name: 'x', enabled: true })).toThrow()
  })

  it('plans a turn synchronously with the same result as planFor, from configs before any discovery', async () => {
    const list = vi.fn(async () => '')
    const connectors = service({ listClaudeConnectors: list })
    connectors.toggle({ provider: 'codex', name: 'blender', enabled: false })
    connectors.toggle({ provider: 'claude', name: 'claude.ai Gmail', enabled: false })
    for (const provider of ['codex', 'claude', 'gemini', 'kimi']) {
      expect(connectors.planForCached(provider, { reserved: ['specrails'] })).toEqual(await connectors.planFor(provider, { reserved: ['specrails'] }))
    }
    expect(connectors.planForCached('codex', { reserved: ['specrails'] }).denied).toEqual(['blender'])
    expect(list).not.toHaveBeenCalled()
  })

  it('reports whether Claude user servers wait for tool search from the last Claude turn', async () => {
    const connectors = service()
    await connectors.planFor('claude', { reserved: [], deferredMcpTools: true })
    const view = await connectors.view()
    expect(view.providers.find((entry) => entry.provider === 'claude')!.userServersNeedToolSearch).toBe(false)
  })

  it('keeps the provider defaults when the inventory cannot be read', async () => {
    const connectors = service()
    vi.spyOn(connectors as unknown as { turnInventory: () => Promise<never> }, 'turnInventory').mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await connectors.planFor('codex', { reserved: [] })).toEqual({ inheritUserScope: true, servers: [], denied: [] })
  })

  it('measures stdio servers and persists the sizes', async () => {
    const probe = vi.fn(async (command: string) => command === 'uvx' ? { tools: 10, chars: 2700 } : null)
    const connectors = service({ probeTools: probe })
    await connectors.measure()
    expect(probe).toHaveBeenCalledWith('uvx', ['blender-mcp'], {})
    expect(probe).not.toHaveBeenCalledWith('node', expect.anything(), expect.anything())
    const view = await connectors.view()
    expect(view.providers.find((entry) => entry.provider === 'codex')!.connectors[0]!.size).toMatchObject({ tools: 10, tokens: 1000 })
    expect(Object.keys(service().sizes())).toEqual(['codex:blender'])
  })
})

describe('provider switch files', () => {
  it('writes and removes the Claude deny file', async () => {
    await writeClaudeConnectorDenyFile(home, ['claude.ai Gmail'])
    const file = path.join(home, '.claude', 'settings.local.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ deniedMcpServers: [{ serverName: 'claude.ai Gmail' }] })
    await writeClaudeConnectorDenyFile(home, ['claude.ai Gmail'])
    await writeClaudeConnectorDenyFile(home, [])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('merges Gemini mcp.excluded and keeps other keys', async () => {
    const file = path.join(home, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { specrails: { command: 'node' } }, mcp: { allowed: ['x'] } }))
    await writeGeminiExcluded(file, ['b', 'a'])
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ mcpServers: { specrails: { command: 'node' } }, mcp: { allowed: ['x'], excluded: ['a', 'b'] } })
    await writeGeminiExcluded(file, [])
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ mcpServers: { specrails: { command: 'node' } }, mcp: { allowed: ['x'] } })
  })
})
