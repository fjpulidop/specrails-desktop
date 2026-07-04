import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveBridgeScript, buildSpecrailsMcpEntry, buildAgentMcpArgs, prepareAgentMcp } from './agent-mcp-config'

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

// ── Origin-link env (safe-pr-review-flow): SPECRAILS_AGENT_CONVERSATION rides
//    entry.env, so ALL THREE provider registration paths carry it automatically
//    (claude --mcp-config file, codex -c overrides, gemini cwd .mcp.json). ──────
describe('agent MCP origin-conversation env (SPECRAILS_AGENT_CONVERSATION)', () => {
  const prevEnv = process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-mcp-origin-'))
    const bridgeFile = path.join(tmpDir, 'specrails-mcp.js')
    fs.writeFileSync(bridgeFile, '// stub bridge\n')
    process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = bridgeFile
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
    else process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH = prevEnv
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildSpecrailsMcpEntry sets the env when the conversation id is valid', () => {
    const entry = buildSpecrailsMcpEntry({ port: 4200, conversationId: 'conv-Abc-123' })
    expect(entry!.env.SPECRAILS_AGENT_CONVERSATION).toBe('conv-Abc-123')
  })

  it('buildSpecrailsMcpEntry omits the env when the id is absent or null', () => {
    expect(buildSpecrailsMcpEntry({ port: 4200 })!.env).not.toHaveProperty('SPECRAILS_AGENT_CONVERSATION')
    expect(buildSpecrailsMcpEntry({ port: 4200, conversationId: null })!.env).not.toHaveProperty('SPECRAILS_AGENT_CONVERSATION')
  })

  it('buildSpecrailsMcpEntry silently drops a malformed id (never throws)', () => {
    for (const bad of ['under_score', 'space here', 'x'.repeat(65), '', '../evil']) {
      const entry = buildSpecrailsMcpEntry({ port: 4200, conversationId: bad })
      expect(entry).not.toBeNull()
      expect(entry!.env).not.toHaveProperty('SPECRAILS_AGENT_CONVERSATION')
    }
  })

  it('claude path: the --mcp-config file entry carries the env', () => {
    const args = buildAgentMcpArgs({ conversationId: 'conv-77', port: 4200, tierLevel: 2 })
    expect(args[0]).toBe('--mcp-config')
    const json = JSON.parse(fs.readFileSync(args[1], 'utf-8'))
    expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_CONVERSATION).toBe('conv-77')
  })

  it('claude path via prepareAgentMcp threads the id into the config file', () => {
    const w = prepareAgentMcp({ adapterId: 'claude', conversationId: 'conv-88', cwd: os.tmpdir(), port: 4200, tierLevel: 1 })
    expect(w.extraArgs[0]).toBe('--mcp-config')
    const json = JSON.parse(fs.readFileSync(w.extraArgs[1], 'utf-8'))
    expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_CONVERSATION).toBe('conv-88')
  })

  it('codex path: the -c env overrides carry the id on the argv', () => {
    const w = prepareAgentMcp({ adapterId: 'codex', conversationId: 'conv-99', cwd: os.tmpdir(), port: 4242, tierLevel: 2 })
    const joined = w.extraArgs.join(' ')
    expect(joined).toContain('mcp_servers.specrails.env.SPECRAILS_AGENT_CONVERSATION="conv-99"')
  })

  it('gemini path: the cwd .mcp.json entry carries the env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-55', cwd, port: 4200, tierLevel: 1 })
      const json = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf-8'))
      expect(json.mcpServers.specrails.env.SPECRAILS_AGENT_CONVERSATION).toBe('conv-55')
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
      const wiring = prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-66', cwd, port: 4321, tierLevel: 2 })
      expect(wiring.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
      const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.gemini', 'settings.json'), 'utf-8'))
      expect(settings.mcpServers.specrails.env.SPECRAILS_MCP_PORT).toBe('4321')
      expect(settings.mcpServers.specrails.env.SPECRAILS_AGENT_CONVERSATION).toBe('conv-66')
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
      prepareAgentMcp({ adapterId: 'gemini', conversationId: 'conv-77', cwd, port: 4200, tierLevel: 1 })
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))
      expect(settings.theme).toBe('dark')
      expect(settings.mcpServers.other).toEqual({ command: 'x' })
      expect(settings.mcpServers.specrails).toBeTruthy()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('claude and codex paths do not inject the gemini trust env', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-origin-gem-'))
    try {
      expect(prepareAgentMcp({ adapterId: 'claude', conversationId: 'conv-1', cwd, port: 4200, tierLevel: 1 }).env).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE')
      expect(prepareAgentMcp({ adapterId: 'codex', conversationId: 'conv-1', cwd, port: 4200, tierLevel: 1 }).env).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
