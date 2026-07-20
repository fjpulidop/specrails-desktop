import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveBridgeScript, buildSpecrailsMcpEntry, buildAgentMcpArgs, prepareAgentMcp, removeAgentCapabilityFile } from './agent-mcp-config'

// resolveBridgeScript must survive the Tauri `\\?\` verbatim prefix on the
// SPECRAILS_BUNDLED_MCP_BRIDGE_PATH env var: a `\\?\C:\…` script argument
// crashes node's module loader (EISDIR lstat 'C:'), which on packaged Windows
// left the agent-chat MCP server perpetually "connecting". The strip is pure
// string manipulation, so these tests are platform-independent.
describe('resolveBridgeScript', () => {
  let tmpDir: string
  let bridgeFile: string
  const prevEnv = process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-mcp-bridge-'))
    bridgeFile = path.join(tmpDir, 'specrails-mcp.js')
    fs.writeFileSync(bridgeFile, '// stub bridge\n')
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
    else process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = prevEnv
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the env-provided path when it exists', () => {
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = bridgeFile
    expect(resolveBridgeScript()).toBe(bridgeFile)
  })

  it('strips the \\\\?\\ verbatim prefix from the env-provided path', () => {
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = '\\\\?\\' + bridgeFile
    expect(resolveBridgeScript()).toBe(bridgeFile)
  })

  it('falls back past an env path that does not exist', () => {
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = path.join(tmpDir, 'missing.js')
    const resolved = resolveBridgeScript()
    // Fallback candidates (src-tauri/binaries / mcp-bridge/dist) may or may not
    // be built locally; the contract is only that the bogus env path never wins.
    expect(resolved).not.toBe(path.join(tmpDir, 'missing.js'))
  })
})

describe('buildSpecrailsMcpEntry', () => {
  const prevEnv = process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-mcp-entry-'))
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
    else process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = prevEnv
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('never embeds a verbatim-prefixed script path in the entry args', () => {
    const bridgeFile = path.join(tmpDir, 'specrails-mcp.js')
    fs.writeFileSync(bridgeFile, '// stub bridge\n')
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = '\\\\?\\' + bridgeFile
    const entry = buildSpecrailsMcpEntry({ port: 4200 })
    expect(entry).not.toBeNull()
    expect(entry!.args).toEqual([bridgeFile])
    expect(entry!.env.SPECRAILS_MCP_PORT).toBe('4200')
  })
})

// Every provider carries only a path to the 0600 capability; authority and
// context remain server-side and the raw bearer never appears in Codex argv.
describe('agent MCP capability transport', () => {
  const prevEnv = process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
  const prevHome = process.env.SPECRAILS_REGISTRY_HOME
  const capability = 'c'.repeat(43)
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-mcp-origin-'))
    const bridgeFile = path.join(tmpDir, 'specrails-mcp.js')
    fs.writeFileSync(bridgeFile, '// stub bridge\n')
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = bridgeFile
    process.env.SPECRAILS_REGISTRY_HOME = tmpDir
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
    else process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = prevEnv
    if (prevHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildSpecrailsMcpEntry carries only the capability file path', () => {
    const entry = buildSpecrailsMcpEntry({ port: 4200, capabilityFile: '/secure/capability' })
    expect(entry!.env.SPECRAILS_AGENT_CAPABILITY_FILE).toBe('/secure/capability')
    expect(entry!.env).not.toHaveProperty('SPECRAILS_AGENT_TIER')
    expect(entry!.env).not.toHaveProperty('SPECRAILS_ACTIVE_PROJECT')
    expect(entry!.env).not.toHaveProperty('SPECRAILS_AGENT_CONVERSATION')
  })

  it('external/workspace entries carry no first-party proof', () => {
    expect(buildSpecrailsMcpEntry({ port: 4200 })!.env).not.toHaveProperty('SPECRAILS_AGENT_CAPABILITY_FILE')
  })

  it('claude path writes the bearer to a 0600 file and configures only its path', () => {
    const args = buildAgentMcpArgs({ conversationId: 'conv-77', port: 4200, capability })
    expect(args[0]).toBe('--mcp-config')
    const json = JSON.parse(fs.readFileSync(args[1], 'utf-8'))
    const file = json.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE
    expect(fs.readFileSync(file, 'utf8')).toBe(capability)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(json)).not.toContain(capability)
    removeAgentCapabilityFile('conv-77')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('claude path via prepareAgentMcp threads the capability file into config', () => {
    const w = prepareAgentMcp({ adapterId: 'claude', conversationId: 'conv-88', cwd: os.tmpdir(), port: 4200, capability })
    expect(w.extraArgs[0]).toBe('--mcp-config')
    const json = JSON.parse(fs.readFileSync(w.extraArgs[1], 'utf-8'))
    expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE).toContain('mcp.capability')
  })

  it('codex path puts only the capability file path in argv', () => {
    const w = prepareAgentMcp({ adapterId: 'codex', conversationId: 'conv-99', cwd: os.tmpdir(), port: 4242, capability })
    const joined = w.extraArgs.join(' ')
    expect(joined).toContain('mcp_servers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE=')
    expect(joined).not.toContain(capability)
  })

  it('gemini path: the native project settings entry carries the env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-55', cwd, port: 4200, capability })
      const json = JSON.parse(fs.readFileSync(path.join(cwd, '.gemini', 'settings.json'), 'utf-8'))
      expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE).toContain('mcp.capability')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  // gemini-cli reads MCP servers ONLY from settings.json (never .mcp.json) and
  // suppresses MCP entirely in an untrusted cwd — the agent branch must
  // register in <cwd>/.gemini/settings.json AND trust the spawn via env.
  it('gemini path: registers in .gemini/settings.json and trusts the workspace', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      const wiring = prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-66', cwd, port: 4321, capability })
      expect(wiring.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
      const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.gemini', 'settings.json'), 'utf-8'))
      expect(settings.mcpServers.specrails.env.SPECRAILS_MCP_PORT).toBe('4321')
      expect(settings.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE).toContain('mcp.capability')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('gemini path: merges into an existing .gemini/settings.json without clobbering other keys', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      const dir = path.join(cwd, '.gemini')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }),
      )
      prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-77', cwd, port: 4200, capability })
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
      expect(settings.theme).toBe('dark')
      expect(settings.mcpServers.other).toEqual({ command: 'x' })
      expect(settings.mcpServers.specrails).toBeTruthy()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('gemini path: concurrent conversations retain their own config and bearer path', async () => {
    const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-a-'))
    const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-b-'))
    const firstCapability = 'a'.repeat(43)
    const secondCapability = 'b'.repeat(43)
    try {
      await Promise.all([
        Promise.resolve().then(() => prepareAgentMcp({
          adapterId: 'gemini',
          conversationId: 'conv-a',
          cwd: firstCwd,
          port: 4200,
          capability: firstCapability,
        })),
        Promise.resolve().then(() => prepareAgentMcp({
          adapterId: 'gemini',
          conversationId: 'conv-b',
          cwd: secondCwd,
          port: 4200,
          capability: secondCapability,
        })),
      ])

      const firstSettings = JSON.parse(fs.readFileSync(path.join(firstCwd, '.gemini', 'settings.json'), 'utf-8'))
      const secondSettings = JSON.parse(fs.readFileSync(path.join(secondCwd, '.gemini', 'settings.json'), 'utf-8'))
      const firstFile = firstSettings.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE as string
      const secondFile = secondSettings.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE as string

      expect(firstFile).not.toBe(secondFile)
      expect(fs.readFileSync(firstFile, 'utf-8')).toBe(firstCapability)
      expect(fs.readFileSync(secondFile, 'utf-8')).toBe(secondCapability)
      expect(JSON.stringify(firstSettings)).not.toContain(secondFile)
      expect(JSON.stringify(secondSettings)).not.toContain(firstFile)
    } finally {
      fs.rmSync(firstCwd, { recursive: true, force: true })
      fs.rmSync(secondCwd, { recursive: true, force: true })
    }
  })

  it('kimi path: merges .kimi-code/mcp.json additively with no invalid flags or Gemini env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-kimi-'))
    try {
      const dir = path.join(cwd, '.kimi-code')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'mcp.json'),
        JSON.stringify({
          untouched: { enabled: true },
          mcpServers: { external: { command: 'external-mcp', args: ['serve'] } },
        }),
      )

      const wiring = prepareAgentMcp({
        adapterId: 'kimi',
        conversationId: 'conv-kimi',
        cwd,
        port: 4545,
        capability,
      })
      expect(wiring).toEqual({ extraArgs: [], env: {} })

      const file = path.join(dir, 'mcp.json')
      const config = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(config.untouched).toEqual({ enabled: true })
      expect(config.mcpServers.external).toEqual({ command: 'external-mcp', args: ['serve'] })
      expect(config.mcpServers.specrails.env.SPECRAILS_MCP_PORT).toBe('4545')
      const bearerFile =
        config.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE as string
      expect(fs.readFileSync(bearerFile, 'utf-8')).toBe(capability)
      expect(fs.statSync(bearerFile).mode & 0o777).toBe(0o600)
      expect(JSON.stringify(config)).not.toContain(capability)
      expect(JSON.stringify(config)).not.toContain('GEMINI_CLI_TRUST_WORKSPACE')
      expect(JSON.stringify(config)).not.toContain('--mcp-config')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('kimi path: concurrent conversations keep isolated cwd configs and bearer files', async () => {
    const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-kimi-a-'))
    const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-kimi-b-'))
    const firstCapability = 'k'.repeat(43)
    const secondCapability = 'm'.repeat(43)
    try {
      await Promise.all([
        Promise.resolve().then(() => prepareAgentMcp({
          adapterId: 'kimi',
          conversationId: 'kimi-a',
          cwd: firstCwd,
          port: 4200,
          capability: firstCapability,
        })),
        Promise.resolve().then(() => prepareAgentMcp({
          adapterId: 'kimi',
          conversationId: 'kimi-b',
          cwd: secondCwd,
          port: 4200,
          capability: secondCapability,
        })),
      ])

      const firstConfig = JSON.parse(
        fs.readFileSync(path.join(firstCwd, '.kimi-code', 'mcp.json'), 'utf-8'),
      )
      const secondConfig = JSON.parse(
        fs.readFileSync(path.join(secondCwd, '.kimi-code', 'mcp.json'), 'utf-8'),
      )
      const firstFile =
        firstConfig.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE as string
      const secondFile =
        secondConfig.mcpServers.specrails.env.SPECRAILS_AGENT_CAPABILITY_FILE as string
      expect(firstFile).not.toBe(secondFile)
      expect(fs.readFileSync(firstFile, 'utf-8')).toBe(firstCapability)
      expect(fs.readFileSync(secondFile, 'utf-8')).toBe(secondCapability)
      expect(JSON.stringify(firstConfig)).not.toContain(secondFile)
      expect(JSON.stringify(secondConfig)).not.toContain(firstFile)
    } finally {
      fs.rmSync(firstCwd, { recursive: true, force: true })
      fs.rmSync(secondCwd, { recursive: true, force: true })
    }
  })

  it('claude and codex paths do not inject the gemini trust env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      expect(prepareAgentMcp({ adapterId: 'claude', conversationId: 'conv-1', cwd, port: 4200, capability }).env).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE')
      expect(prepareAgentMcp({ adapterId: 'codex', conversationId: 'conv-1', cwd, port: 4200, capability }).env).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE')
      expect(prepareAgentMcp({ adapterId: 'kimi', conversationId: 'conv-1', cwd, port: 4200, capability }).env).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
