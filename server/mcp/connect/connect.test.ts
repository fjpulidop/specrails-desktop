import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CODEX_TOOL_TIMEOUT_SEC, codexTable, editClaudeJson, editCodexToml, looksLikeSpecrails, registrationCommand, shellQuote, type BridgeEntry } from './client-config'
import { configPathFor, connect, detectClients, entryWarnings, findOnPath, type ConnectEnv } from './connect'
import { catalogTokens, verifyBridge } from './verify'
import { Tiktoken } from 'js-tiktoken/lite'
import o200k from 'js-tiktoken/ranks/o200k_base'
import { createHarness } from '../v2/__fixtures__/harness'
import { registerV2Surface } from '../v2'
import { buildToolSpecs } from '../tools/catalog'

const ENTRY: BridgeEntry = {
  command: '/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node',
  args: ['/Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js'],
  env: { SPECRAILS_MCP_PORT: '4200' },
}
const MOVED: BridgeEntry = { ...ENTRY, args: ['/Users/me/Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js'] }

let home: string
let cenv: ConnectEnv

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-connect-home-')))
  cenv = { home, env: { PATH: path.join(home, 'bin') }, platform: 'darwin', now: () => new Date('2026-11-22T10:20:30Z') }
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const read = (file: string) => fs.readFileSync(file, 'utf8')
const backups = (dir: string) => fs.readdirSync(dir).filter((name) => name.includes('.bak-specrails-'))

describe('Claude Code JSON edits', () => {
  it('adds the entry and keeps every other key and server', () => {
    const text = JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } }, projects: { '/a': {} } })
    const out = editClaudeJson(text, ENTRY)
    expect(out.outcome).toBe('create')
    const doc = JSON.parse(out.text)
    expect(doc.numStartups).toBe(3)
    expect(doc.projects).toEqual({ '/a': {} })
    expect(doc.mcpServers.other).toEqual({ command: 'x' })
    expect(doc.mcpServers.specrails).toEqual({ type: 'stdio', command: ENTRY.command, args: ENTRY.args, env: ENTRY.env })
  })

  it('is idempotent, updates its own entry and refuses a foreign one', () => {
    const once = editClaudeJson(null, ENTRY).text
    expect(editClaudeJson(once, ENTRY)).toEqual({ outcome: 'unchanged', text: once })
    expect(editClaudeJson(once, MOVED).outcome).toBe('update')
    const foreign = JSON.stringify({ mcpServers: { specrails: { command: 'npx', args: ['some-other-server'] } } })
    expect(editClaudeJson(foreign, ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'foreign_entry' })
    expect(editClaudeJson(foreign, ENTRY, { force: true }).outcome).toBe('update')
  })

  it('never resets invalid JSON and removes only its entry', () => {
    expect(editClaudeJson('{ not json', ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'invalid_config', text: '{ not json' })
    expect(editClaudeJson('[]', ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'invalid_config' })
    const both = JSON.stringify({ mcpServers: { other: { command: 'x' }, specrails: { command: 'node', args: ['/x/specrails-mcp.js'] } } })
    const removed = editClaudeJson(both, null)
    expect(removed.outcome).toBe('remove')
    expect(JSON.parse(removed.text).mcpServers).toEqual({ other: { command: 'x' } })
    expect(editClaudeJson('{}', null).outcome).toBe('absent')
  })
})

describe('Codex TOML edits', () => {
  const EXISTING = [
    '# my codex config',
    'model = "gpt-5.5"',
    '',
    '[mcp_servers.blender]',
    'command = "uvx"',
    'args = ["blender-mcp"]',
    '',
    '# profiles below',
    '[profiles.fast]',
    'model = "gpt-5.5-mini"',
    '',
  ].join('\n')

  it('writes command, args, env and a tool timeout that fits specrails_wait', () => {
    expect(CODEX_TOOL_TIMEOUT_SEC).toBeGreaterThanOrEqual(60)
    expect(codexTable(ENTRY)).toBe([
      '[mcp_servers.specrails]',
      `command = "${ENTRY.command}"`,
      `args = ["${ENTRY.args[0]}"]`,
      'env = { SPECRAILS_MCP_PORT = "4200" }',
      'tool_timeout_sec = 90',
      '',
    ].join('\n'))
  })

  it('appends without touching other lines, then is idempotent', () => {
    const created = editCodexToml(EXISTING, ENTRY)
    expect(created.outcome).toBe('create')
    expect(created.text.startsWith(EXISTING.trimEnd())).toBe(true)
    expect(created.text.endsWith(codexTable(ENTRY))).toBe(true)
    expect(editCodexToml(created.text, ENTRY)).toEqual({ outcome: 'unchanged', text: created.text })
  })

  it('replaces its table in place, keeping the comment of the next table', () => {
    const middle = EXISTING.replace('# profiles below', `${codexTable(MOVED)}\n# profiles below`)
    const updated = editCodexToml(middle, ENTRY)
    expect(updated.outcome).toBe('update')
    expect(updated.text).toContain(codexTable(ENTRY))
    expect(updated.text).toContain('# profiles below\n[profiles.fast]')
    expect(updated.text).toContain('[mcp_servers.blender]\ncommand = "uvx"')
    expect(updated.text).not.toContain('/Users/me/')
    expect(editCodexToml(updated.text, ENTRY).outcome).toBe('unchanged')
  })

  it('removes its table and sub-tables only', () => {
    const withOurs = `${EXISTING}\n${codexTable(ENTRY)}\n[mcp_servers.specrails.env]\nX = "1"\n`
    const removed = editCodexToml(withOurs, null)
    expect(removed.outcome).toBe('remove')
    expect(removed.text).not.toContain('specrails')
    expect(removed.text).toContain('[profiles.fast]')
    expect(removed.text).toContain('[mcp_servers.blender]')
    expect(editCodexToml(removed.text, null).outcome).toBe('absent')
  })

  it('refuses a foreign specrails table and inline definitions', () => {
    const foreign = '[mcp_servers.specrails]\ncommand = "npx"\nargs = ["other"]\n'
    expect(editCodexToml(foreign, ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'foreign_entry' })
    expect(editCodexToml(foreign, ENTRY, { force: true }).outcome).toBe('update')
    expect(editCodexToml('mcp_servers.specrails = { command = "x" }\n', ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'unsupported_layout' })
    expect(editCodexToml('[mcp_servers]\nspecrails = { command = "x" }\n', ENTRY)).toMatchObject({ outcome: 'conflict', reason: 'unsupported_layout' })
  })

  it('escapes Windows paths and keeps CRLF files CRLF', () => {
    const win: BridgeEntry = { command: 'C:\\Program Files\\Specrails\\runtimes\\node\\node.exe', args: ['C:\\Program Files\\Specrails\\binaries\\specrails-mcp.js'], env: {} }
    const out = editCodexToml('model = "x"\r\n', win)
    expect(out.text).toContain('command = "C:\\\\Program Files\\\\Specrails\\\\runtimes\\\\node\\\\node.exe"')
    expect(out.text.split('\r\n').length).toBeGreaterThan(3)
    expect(editCodexToml(out.text, win).outcome).toBe('unchanged')
  })
})

describe('commands and helpers', () => {
  it('recognises the bridge on any install path', () => {
    expect(looksLikeSpecrails('node', ['/opt/x/specrails-mcp.js'])).toBe(true)
    expect(looksLikeSpecrails('specrails-mcp', [])).toBe(true)
    expect(looksLikeSpecrails('C:\\x\\node.exe', ['C:\\x\\binaries\\specrails-mcp.js'])).toBe(true)
    expect(looksLikeSpecrails('npx', ['specrails-mcp-fake'])).toBe(false)
  })

  it('prints the client command with quoted paths and no secret', () => {
    const spaced: BridgeEntry = { ...ENTRY, command: '/My Apps/node' }
    expect(registrationCommand('claude', spaced, 'user', 'darwin')).toBe(`claude mcp add --scope user --transport stdio -e SPECRAILS_MCP_PORT=4200 specrails -- '/My Apps/node' ${ENTRY.args[0]}`)
    expect(registrationCommand('codex', ENTRY, 'user', 'darwin')).toBe(`codex mcp add specrails --env SPECRAILS_MCP_PORT=4200 -- ${ENTRY.command} ${ENTRY.args[0]}`)
    expect(shellQuote("it's", 'darwin')).toBe(`'it'\\''s'`)
    expect(shellQuote("C:\\it's", 'win32')).toBe(`'C:\\it''s'`)
  })

  it('warns about a temporary AppImage bridge', () => {
    expect(entryWarnings({ command: '/tmp/.mount_SpecrX/node', args: ['/tmp/.mount_SpecrX/specrails-mcp.js'], env: {} })[0]).toMatch(/temporary/)
    expect(entryWarnings(ENTRY)).toEqual([])
    expect(entryWarnings({ ...ENTRY, command: '/opt/homebrew/Cellar/node/25.2.1/bin/node' })[0]).toMatch(/one installed Node version/)
  })
})

describe('connect against a temp home', () => {
  it('resolves documented locations, honouring CODEX_HOME and CLAUDE_CONFIG_DIR', () => {
    expect(configPathFor('claude', 'user', cenv)).toBe(path.join(home, '.claude.json'))
    expect(configPathFor('codex', 'user', cenv)).toBe(path.join(home, '.codex', 'config.toml'))
    expect(configPathFor('claude', 'project', cenv, '/p')).toBe(path.join('/p', '.mcp.json'))
    expect(configPathFor('codex', 'project', cenv, '/p')).toBe(path.join('/p', '.codex', 'config.toml'))
    const custom = { ...cenv, env: { CODEX_HOME: path.join(home, 'ch'), CLAUDE_CONFIG_DIR: path.join(home, 'cc') } }
    expect(configPathFor('codex', 'user', custom)).toBe(path.join(home, 'ch', 'config.toml'))
    expect(configPathFor('claude', 'user', custom)).toBe(path.join(home, 'cc', '.claude.json'))
  })

  it('creates, backs up on change, skips unchanged and removes', () => {
    const file = path.join(home, '.claude.json')
    fs.writeFileSync(file, JSON.stringify({ keep: true }), { mode: 0o600 })
    const dry = connect({ client: 'claude', dryRun: true }, ENTRY, cenv)
    expect(dry).toMatchObject({ outcome: 'create', written: false, backup: null })
    expect(JSON.parse(read(file))).toEqual({ keep: true })

    const first = connect({ client: 'claude' }, ENTRY, cenv)
    expect(first).toMatchObject({ outcome: 'create', written: true, file })
    expect(first.backup).toBe(`${file}.bak-specrails-20261122-102030`)
    expect(JSON.parse(read(first.backup!))).toEqual({ keep: true })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(read(file)).keep).toBe(true)

    const again = connect({ client: 'claude' }, ENTRY, cenv)
    expect(again).toMatchObject({ outcome: 'unchanged', written: false, backup: null })
    expect(backups(home)).toHaveLength(1)

    const removed = connect({ client: 'claude', remove: true }, ENTRY, { ...cenv, now: () => new Date('2026-11-22T11:00:00Z') })
    expect(removed).toMatchObject({ outcome: 'remove', written: true, entry: null })
    expect(JSON.parse(read(file))).toEqual({ keep: true, mcpServers: {} })
  })

  it('creates a missing Codex config with 0600 and no backup', () => {
    const result = connect({ client: 'codex' }, ENTRY, cenv)
    expect(result).toMatchObject({ outcome: 'create', written: true, backup: null })
    expect(read(result.file)).toBe(codexTable(ENTRY))
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlinked dotfile and keeps the link', () => {
    const real = path.join(home, 'dotfiles', 'claude.json')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, '{}')
    fs.symlinkSync(real, path.join(home, '.claude.json'))
    connect({ client: 'claude' }, ENTRY, cenv)
    expect(fs.lstatSync(path.join(home, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(read(real)).mcpServers.specrails.command).toBe(ENTRY.command)
  })

  it('writes project scope only inside the given project', () => {
    const project = path.join(home, 'proj')
    fs.mkdirSync(project)
    const claude = connect({ client: 'claude', scope: 'project', projectDir: project }, ENTRY, cenv)
    const codex = connect({ client: 'codex', scope: 'project', projectDir: project }, ENTRY, cenv)
    expect(claude.file).toBe(path.join(project, '.mcp.json'))
    expect(codex.file).toBe(path.join(project, '.codex', 'config.toml'))
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    expect(() => connect({ client: 'claude', scope: 'project', projectDir: 'relative' }, ENTRY, cenv)).toThrow(/absolute/)
    expect(() => connect({ client: 'claude', scope: 'project', projectDir: path.join(home, 'nope') }, ENTRY, cenv)).toThrow(/not a directory/)
  })

  it('returns a conflict without writing, and needs a bridge to connect', () => {
    const file = path.join(home, '.claude.json')
    fs.writeFileSync(file, '{ broken')
    expect(connect({ client: 'claude' }, ENTRY, cenv)).toMatchObject({ outcome: 'conflict', reason: 'invalid_config', written: false })
    expect(read(file)).toBe('{ broken')
    expect(backups(home)).toEqual([])
    expect(() => connect({ client: 'codex' }, null, cenv)).toThrow(/bridge/)
    expect(() => connect({ client: 'cursor' as never }, ENTRY, cenv)).toThrow(/Unknown client/)
  })

  it('detects installed clients and their state', () => {
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findOnPath('codex', cenv)).toBe(path.join(bin, 'codex'))
    let [claude, codex] = detectClients(ENTRY, cenv)
    expect(claude).toMatchObject({ client: 'claude', installed: false, state: 'not_connected' })
    expect(codex).toMatchObject({ client: 'codex', installed: true, binary: path.join(bin, 'codex'), state: 'not_connected' })
    connect({ client: 'codex' }, MOVED, cenv)
    ;[, codex] = detectClients(ENTRY, cenv)
    expect(codex!.state).toBe('outdated')
    connect({ client: 'codex' }, ENTRY, cenv)
    ;[, codex] = detectClients(ENTRY, cenv)
    expect(codex!.state).toBe('connected')
  })
})

describe('verifyBridge', () => {
  function fakeBridge(body: string): BridgeEntry {
    const script = path.join(home, 'fake-bridge.js')
    fs.writeFileSync(script, `
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => { const msg = JSON.parse(line); ${body} })
`)
    return { command: process.execPath, args: [script], env: { FAKE: '1' } }
  }

  it('completes initialize, tools/list and overview(app) through the entry', async () => {
    const entry = fakeBridge(`
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 's', version: '9.9.9' }, capabilities: {}, instructions: 'Start with specrails_overview' } })
      if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'specrails_overview', inputSchema: { type: 'object' } }, { name: 'specrails_inbox', inputSchema: { type: 'object' }, env: process.env.FAKE }] } })
      if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [], structuredContent: { v: 2, ok: true, summary: '2 things need you.' } } })
    `)
    const result = await verifyBridge(entry, { timeoutMs: 10_000 })
    expect(result).toMatchObject({ ok: true, toolCount: 2, serverVersion: '9.9.9', instructions: true, overview: '2 things need you.' })
    expect(result.approxTokens).toBeGreaterThan(0)
  })

  it('reports the server error (MCP disabled, app not running)', async () => {
    const entry = fakeBridge(`if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32004, message: 'MCP is disabled.' } })`)
    expect(await verifyBridge(entry, { timeoutMs: 10_000 })).toMatchObject({ ok: false, error: 'MCP is disabled.' })
  })

  it('reports a bridge that exits or cannot start', async () => {
    const exits = await verifyBridge({ command: process.execPath, args: ['-e', 'process.stderr.write("boom"); process.exit(3)'], env: {} }, { timeoutMs: 10_000 })
    expect(exits).toMatchObject({ ok: false, error: 'boom' })
    const missing = await verifyBridge({ command: path.join(home, 'no-node'), args: [], env: {} }, { timeoutMs: 10_000 })
    expect(missing.ok).toBe(false)
  })
})

describe('catalogTokens', () => {
  it('stays within 15% of the real o200k count of the v2 catalog', async () => {
    const harness = createHarness()
    registerV2Surface(harness.server, harness.ctx, buildToolSpecs(), { inApp: false })
    const client = await harness.connect()
    const tools = (await client.listTools()).tools
    const enc = new Tiktoken(o200k)
    const real = tools.reduce((sum, tool) => sum + enc.encode(JSON.stringify({ type: 'function', name: `mcp__specrails__${tool.name}`, description: tool.description, parameters: tool.inputSchema })).length, 0)
    const estimate = catalogTokens(tools)
    expect(Math.abs(estimate - real) / real).toBeLessThan(0.15)
    await client.close()
  })
})
