import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  EXTERNAL_MCP_SETTING_KEY,
  ExternalMcpValidationError,
  applyExternalMcpPatch,
  customId,
  discoverExternalMcp,
  discoveredId,
  isCodexInjectable,
  isExternalMcpEnabled,
  readCodexNativeServerNames,
  readExternalMcpSettings,
  readNativeMcpServers,
  resolveExternalEntries,
} from './external-mcp'
import { initDesktopDb, setDesktopSetting } from './desktop-db'
import type { DbInstance } from './db'

let db: DbInstance
let home: string
const prevHome = process.env.SPECRAILS_REGISTRY_HOME
const prevKill = process.env.SPECRAILS_EXTERNAL_MCP

beforeEach(() => {
  db = initDesktopDb(':memory:')
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-external-mcp-'))
  process.env.SPECRAILS_REGISTRY_HOME = home
  delete process.env.SPECRAILS_EXTERNAL_MCP
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = prevHome
  if (prevKill === undefined) delete process.env.SPECRAILS_EXTERNAL_MCP
  else process.env.SPECRAILS_EXTERNAL_MCP = prevKill
  fs.rmSync(home, { recursive: true, force: true })
})

function writeClaudeConfig(mcpServers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers }))
}

function writeGeminiConfig(mcpServers: Record<string, unknown>): void {
  const dir = path.join(home, '.gemini')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers }))
}

function writeKimiConfig(mcpServers: Record<string, unknown>): void {
  const dir = path.join(home, '.kimi-code')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers }))
}

function writeCodexConfig(toml: string): void {
  const dir = path.join(home, '.codex')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.toml'), toml)
}

const STDIO = { command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: 'x' } }

describe('isExternalMcpEnabled', () => {
  it('defaults to enabled', () => {
    expect(isExternalMcpEnabled()).toBe(true)
  })

  it.each(['false', '0', 'off', 'FALSE', 'Off'])('disabled by %s', (v) => {
    process.env.SPECRAILS_EXTERNAL_MCP = v
    expect(isExternalMcpEnabled()).toBe(false)
  })

  it('any other value keeps it enabled', () => {
    process.env.SPECRAILS_EXTERNAL_MCP = '1'
    expect(isExternalMcpEnabled()).toBe(true)
  })
})

describe('native-config discovery', () => {
  it('reads claude/gemini/kimi mcpServers maps', () => {
    writeClaudeConfig({ jira: STDIO })
    writeGeminiConfig({ tool: STDIO })
    writeKimiConfig({ other: STDIO })
    expect(Object.keys(readNativeMcpServers('claude'))).toEqual(['jira'])
    expect(Object.keys(readNativeMcpServers('gemini'))).toEqual(['tool'])
    expect(Object.keys(readNativeMcpServers('kimi'))).toEqual(['other'])
  })

  it('missing config yields empty map', () => {
    expect(readNativeMcpServers('claude')).toEqual({})
  })

  it('corrupt config yields empty map and does not affect others', () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), '{nope')
    writeClaudeConfig({ jira: STDIO })
    expect(readNativeMcpServers('gemini')).toEqual({})
    expect(Object.keys(readNativeMcpServers('claude'))).toEqual(['jira'])
  })

  it('drops non-object server entries', () => {
    writeClaudeConfig({ good: STDIO, bad: 'nope' })
    expect(Object.keys(readNativeMcpServers('claude'))).toEqual(['good'])
  })

  it('codex names-only parse from table headers', () => {
    writeCodexConfig('[mcp_servers.foo]\ncommand = "x"\n\n[mcp_servers.bar] # trailing\ncommand = "y"\n[other.table]\n')
    expect(readCodexNativeServerNames()).toEqual(['bar', 'foo'])
  })

  it('codex missing config yields empty list', () => {
    expect(readCodexNativeServerNames()).toEqual([])
  })

  it('discoverExternalMcp flags orphaned selections', () => {
    writeClaudeConfig({ jira: STDIO })
    const settings = {
      version: 1 as const,
      servers: {
        [discoveredId('claude', 'jira')]: {
          source: 'discovered' as const, sourceProvider: 'claude' as const, name: 'jira', providers: { claude: true },
        },
        [discoveredId('claude', 'gone')]: {
          source: 'discovered' as const, sourceProvider: 'claude' as const, name: 'gone', providers: { kimi: true },
        },
      },
    }
    const discovery = discoverExternalMcp(settings)
    expect(discovery.claude).toEqual([{ id: 'd:claude:jira', name: 'jira' }])
    expect(discovery.orphanIds).toEqual(['d:claude:gone'])
  })
})

describe('readExternalMcpSettings', () => {
  it('returns empty settings when nothing stored', () => {
    expect(readExternalMcpSettings(db)).toEqual({ version: 1, servers: {} })
  })

  it('survives garbage JSON (fail-open)', () => {
    setDesktopSetting(db, EXTERNAL_MCP_SETTING_KEY, '{nope')
    expect(readExternalMcpSettings(db)).toEqual({ version: 1, servers: {} })
  })

  it('drops malformed entries and keeps valid ones', () => {
    setDesktopSetting(db, EXTERNAL_MCP_SETTING_KEY, JSON.stringify({
      version: 1,
      servers: {
        'c:good': { source: 'custom', name: 'good', providers: { claude: true }, transport: STDIO },
        'c:specrails': { source: 'custom', name: 'specrails', providers: {}, transport: STDIO },
        'weird-id': { source: 'custom', name: 'weird', providers: {}, transport: STDIO },
        'c:no-transport': { source: 'custom', name: 'no-transport', providers: {} },
        'd:unknownprov:x': { source: 'discovered', name: 'x', providers: {} },
      },
    }))
    const settings = readExternalMcpSettings(db)
    expect(Object.keys(settings.servers)).toEqual(['c:good'])
    expect(settings.servers['c:good'].transport).toEqual(STDIO)
  })

  it('drops unknown providers from the matrix', () => {
    setDesktopSetting(db, EXTERNAL_MCP_SETTING_KEY, JSON.stringify({
      version: 1,
      servers: {
        'c:tool': { source: 'custom', name: 'tool', providers: { claude: true, nonsense: true }, transport: STDIO },
      },
    }))
    expect(readExternalMcpSettings(db).servers['c:tool'].providers).toEqual({ claude: true })
  })
})

describe('applyExternalMcpPatch', () => {
  it('stores a valid patch and round-trips', () => {
    const stored = applyExternalMcpPatch(db, {
      servers: {
        [customId('mi-tool')]: { source: 'custom', name: 'mi-tool', providers: { claude: true }, transport: STDIO },
        [discoveredId('claude', 'jira')]: { source: 'discovered', sourceProvider: 'claude', name: 'jira', providers: { kimi: true } },
      },
    })
    expect(readExternalMcpSettings(db)).toEqual(stored)
    expect(stored.servers['c:mi-tool'].transport?.command).toBe('npx')
    expect(stored.servers['d:claude:jira'].providers).toEqual({ kimi: true })
  })

  it('rejects the reserved specrails name', () => {
    expect(() => applyExternalMcpPatch(db, {
      servers: { 'c:specrails': { source: 'custom', name: 'specrails', providers: {}, transport: STDIO } },
    })).toThrowError(expect.objectContaining({ code: 'reserved_name' }))
  })

  it('rejects duplicate injected names for the same provider', () => {
    expect(() => applyExternalMcpPatch(db, {
      servers: {
        'c:jira': { source: 'custom', name: 'jira', providers: { claude: true }, transport: STDIO },
        'd:gemini:jira': { source: 'discovered', sourceProvider: 'gemini', name: 'jira', providers: { claude: true } },
      },
    })).toThrowError(expect.objectContaining({ code: 'duplicate_server_name' }))
  })

  it('allows the same name on DIFFERENT providers', () => {
    const stored = applyExternalMcpPatch(db, {
      servers: {
        'c:jira': { source: 'custom', name: 'jira', providers: { claude: true }, transport: STDIO },
        'd:gemini:jira': { source: 'discovered', sourceProvider: 'gemini', name: 'jira', providers: { kimi: true } },
      },
    })
    expect(Object.keys(stored.servers)).toHaveLength(2)
  })

  it('rejects a custom entry without a command', () => {
    expect(() => applyExternalMcpPatch(db, {
      servers: { 'c:x': { source: 'custom', name: 'x', providers: {}, transport: { command: ' ' } } },
    })).toThrowError(expect.objectContaining({ code: 'invalid_transport' }))
  })

  it('rejects unknown providers in the matrix', () => {
    expect(() => applyExternalMcpPatch(db, {
      servers: { 'c:x': { source: 'custom', name: 'x', providers: { nonsense: true }, transport: STDIO } },
    })).toThrowError(expect.objectContaining({ code: 'unknown_provider' }))
  })

  it('rejects an unknown discovery source provider', () => {
    expect(() => applyExternalMcpPatch(db, {
      servers: { 'd:foo:x': { source: 'discovered', sourceProvider: 'foo', name: 'x', providers: {} } },
    })).toThrowError(expect.objectContaining({ code: 'unknown_provider' }))
  })

  it('rejects malformed ids and bodies', () => {
    expect(() => applyExternalMcpPatch(db, null)).toThrowError(ExternalMcpValidationError)
    expect(() => applyExternalMcpPatch(db, { servers: { 'weird-id': { source: 'custom', name: 'x', providers: {}, transport: STDIO } } }))
      .toThrowError(expect.objectContaining({ code: 'invalid_entry' }))
  })

  it('stores nothing on rejection', () => {
    try {
      applyExternalMcpPatch(db, {
        servers: { 'c:specrails': { source: 'custom', name: 'specrails', providers: {}, transport: STDIO } },
      })
    } catch { /* expected */ }
    expect(readExternalMcpSettings(db)).toEqual({ version: 1, servers: {} })
  })
})

describe('resolveExternalEntries', () => {
  function seedSelection(): void {
    writeClaudeConfig({ jira: STDIO })
    applyExternalMcpPatch(db, {
      servers: {
        'd:claude:jira': { source: 'discovered', sourceProvider: 'claude', name: 'jira', providers: { claude: true, kimi: true } },
        'c:mi-tool': { source: 'custom', name: 'mi-tool', providers: { claude: true }, transport: STDIO },
      },
    })
  }

  it('resolves custom transport from the blob and discovered live from the source', () => {
    seedSelection()
    const entries = resolveExternalEntries('claude', db)
    expect(entries.map((e) => e.name).sort()).toEqual(['jira', 'mi-tool'])
    const jira = entries.find((e) => e.name === 'jira')!
    expect(jira.config).toEqual(STDIO)
  })

  it('cross-provider: a claude-discovered entry resolves for kimi', () => {
    seedSelection()
    const entries = resolveExternalEntries('kimi', db)
    expect(entries.map((e) => e.name)).toEqual(['jira'])
  })

  it('filters by activation matrix', () => {
    seedSelection()
    expect(resolveExternalEntries('gemini', db)).toEqual([])
  })

  it('skips an orphaned discovered entry without failing', () => {
    seedSelection()
    writeClaudeConfig({}) // server vanished from the source config
    const entries = resolveExternalEntries('claude', db)
    expect(entries.map((e) => e.name)).toEqual(['mi-tool'])
  })

  it('kill switch yields no entries', () => {
    seedSelection()
    process.env.SPECRAILS_EXTERNAL_MCP = 'false'
    expect(resolveExternalEntries('claude', db)).toEqual([])
  })
})

describe('isCodexInjectable', () => {
  it('accepts stdio configs with TOML-safe names', () => {
    expect(isCodexInjectable({ id: 'c:x', name: 'my-tool', config: { command: 'npx' } })).toBe(true)
  })

  it('rejects names unsafe for TOML keys and command-less configs', () => {
    expect(isCodexInjectable({ id: 'c:x', name: 'has.dot', config: { command: 'npx' } })).toBe(false)
    expect(isCodexInjectable({ id: 'c:x', name: 'http-one', config: { url: 'https://x' } })).toBe(false)
  })
})
