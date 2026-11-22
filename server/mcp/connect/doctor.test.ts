import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { codexTable, claudeEntry, readClaudeEntry, readCodexEntry, type BridgeEntry } from './client-config'
import { runDoctor, type DoctorInput } from './doctor'
import type { ConnectEnv } from './connect'

// Every path lives in a temp home: the doctor never reads the person's real configs.
let home: string
let cenv: ConnectEnv
let node: string
let bridge: string
let entry: BridgeEntry
const TOKEN = 'a'.repeat(64)

function writeExec(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-doctor-home-')))
  cenv = { home, env: { PATH: path.join(home, 'bin') }, platform: 'darwin' }
  node = path.join(home, 'runtimes', 'node', 'bin', 'node')
  bridge = path.join(home, 'binaries', 'specrails-mcp.js')
  writeExec(node)
  fs.mkdirSync(path.dirname(bridge), { recursive: true })
  fs.writeFileSync(bridge, '// bridge\n')
  fs.mkdirSync(path.join(home, '.specrails'))
  fs.writeFileSync(path.join(home, '.specrails', 'mcp.token'), TOKEN, { mode: 0o600 })
  entry = { command: node, args: [bridge], env: { SPECRAILS_MCP_PORT: '4200' } }
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    cenv, port: 4200, mcpEnabled: true, expected: entry,
    tokenFile: path.join(home, '.specrails', 'mcp.token'),
    tokenMatches: (value) => value === TOKEN,
    versions: { app: '3.5.0', catalog: 'v2', advertisedTools: 15 },
    nodeVersion: async () => 'v22.11.0',
    verify: async () => ({ ok: true, toolCount: 15, instructions: true, serverVersion: '3.5.0', protocolVersion: '2025-06-18', overview: 'Nothing needs you.', ms: 12 }),
    ...overrides,
  }
}

const byId = (report: Awaited<ReturnType<typeof runDoctor>>, id: string) => report.checks.find((check) => check.id === id)

describe('reading registered entries', () => {
  it('reads Claude user, local and project entries, and invalid files', () => {
    const text = JSON.stringify({ mcpServers: { specrails: claudeEntry(entry) }, projects: { '/p': { mcpServers: { specrails: { command: 'npx', args: ['other'] } } } } })
    expect(readClaudeEntry(text)).toEqual({ state: 'present', entry: { command: node, args: [bridge], env: entry.env, ours: true } })
    expect(readClaudeEntry(text, { projectDir: '/p' })).toMatchObject({ state: 'present', entry: { command: 'npx', ours: false } })
    expect(readClaudeEntry(text, { projectDir: '/q' })).toEqual({ state: 'missing' })
    expect(readClaudeEntry('{ nope')).toEqual({ state: 'invalid' })
    expect(readClaudeEntry(null)).toEqual({ state: 'missing' })
  })

  it('reads the Codex table connect writes, and an env sub-table', () => {
    const text = `model = "o3"\n\n${codexTable(entry)}\n[profiles.x]\nmodel = "y"\n`
    expect(readCodexEntry(text)).toEqual({ state: 'present', entry: { command: node, args: [bridge], env: entry.env, ours: true, toolTimeoutSec: 90 } })
    const sub = `[mcp_servers.specrails]\ncommand = 'node'\nargs = ["/x/specrails-mcp.js"]\n\n[mcp_servers.specrails.env]\nSPECRAILS_MCP_PORT = "4300"\n`
    expect(readCodexEntry(sub)).toMatchObject({ state: 'present', entry: { command: 'node', env: { SPECRAILS_MCP_PORT: '4300' } } })
    expect(readCodexEntry('mcp_servers.specrails.command = "x"\n')).toEqual({ state: 'invalid' })
    expect(readCodexEntry('[other]\n')).toEqual({ state: 'missing' })
  })
})

describe('runDoctor', () => {
  it('passes a healthy setup and never reports the token', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { specrails: claudeEntry(entry) } }))
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), codexTable(entry))
    const verified: BridgeEntry[] = []
    const report = await runDoctor(input({ verify: async (e) => { verified.push(e); return { ok: true, toolCount: 15, instructions: true, serverVersion: '3.5.0', protocolVersion: '2025-06-18', ms: 5 } } }))
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['app', 'pass'], ['mcp_enabled', 'pass'], ['token', 'pass'], ['bridge', 'pass'], ['node', 'pass'], ['client:claude', 'pass'], ['client:codex', 'pass'], ['verify', 'pass'],
    ])
    expect(verified).toHaveLength(1) // the same entry in both clients runs once
    expect(report.versions).toMatchObject({ app: '3.5.0', catalog: 'v2', advertisedTools: 15, node: 'v22.11.0', server: '3.5.0', negotiatedProtocol: '2025-06-18' })
    expect(JSON.stringify(report)).not.toContain(TOKEN)
  })

  it('flags stale paths, a wrong port, a versioned Node and a foreign entry, each with a fix', async () => {
    const cellar = path.join(home, 'Cellar', 'node', '25.2.1', 'bin', 'node')
    writeExec(cellar)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { specrails: claudeEntry({ command: cellar, args: [bridge], env: { SPECRAILS_MCP_PORT: '4300' } }) } }))
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), codexTable({ command: path.join(home, 'gone', 'node'), args: ['/old/specrails-mcp.js'], env: { SPECRAILS_MCP_PORT: '4200' } }))
    const project = path.join(home, 'proj')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { specrails: { command: 'npx', args: ['someone-else'] } } }))
    const report = await runDoctor(input({ projectDir: project }))
    expect(report.ok).toBe(false)
    const claude = byId(report, 'client:claude')!
    expect(claude.status).toBe('fail')
    expect(claude.detail).toMatch(/port 4300; Specrails listens on 4200/)
    expect(claude.detail).toMatch(/one installed version/)
    expect(claude.fix).toMatch(/specrails-desktop mcp connect --client claude/)
    const codex = byId(report, 'client:codex')!
    expect(codex.status).toBe('fail')
    expect(codex.detail).toMatch(/does not exist any more/)
    expect(codex.detail).toMatch(/bridge script \(\/old\/specrails-mcp.js\) does not exist/)
    expect(byId(report, 'client:claude-project')).toMatchObject({ status: 'warn', fix: expect.stringContaining('--scope project --force') })
    expect(byId(report, 'client:claude-local')).toBeUndefined()
    // Failing entries are not run; the expected entry is tested instead.
    expect(byId(report, 'verify')?.status).toBe('pass')
  })

  it('reports a missing, mismatched or world-readable token, MCP off and a missing bridge', async () => {
    const tokenFile = path.join(home, '.specrails', 'mcp.token')
    let report = await runDoctor(input({ tokenMatches: () => false, mcpEnabled: false }))
    expect(byId(report, 'token')).toMatchObject({ status: 'fail', title: expect.stringMatching(/does not match/) })
    expect(byId(report, 'mcp_enabled')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Settings ▸ MCP/) })
    expect(byId(report, 'verify')?.status).toBe('skip')
    fs.chmodSync(tokenFile, 0o644)
    report = await runDoctor(input())
    expect(byId(report, 'token')).toMatchObject({ status: 'warn', fix: `chmod 600 ${tokenFile}` })
    fs.rmSync(tokenFile)
    fs.rmSync(bridge)
    report = await runDoctor(input())
    expect(byId(report, 'token')?.status).toBe('fail')
    expect(byId(report, 'bridge')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Reinstall/) })
    report = await runDoctor(input({ expected: null }))
    expect(byId(report, 'bridge')?.status).toBe('fail')
    expect(byId(report, 'node')).toBeUndefined()
  })

  it('reports the Node: too old, versioned, or not starting', async () => {
    expect(byId(await runDoctor(input({ nodeVersion: async () => 'v16.20.0' })), 'node')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Node 18 or newer/) })
    expect(byId(await runDoctor(input({ nodeVersion: async () => null })), 'node')?.status).toBe('fail')
    const warned = await runDoctor(input({ nodeSource: { command: node, source: 'versioned', warning: 'Put a stable node on PATH.' } }))
    expect(byId(warned, 'node')).toMatchObject({ status: 'warn', fix: 'Put a stable node on PATH.' })
  })

  it('a not-installed client is skipped; an installed one without the entry says how to connect', async () => {
    let report = await runDoctor(input())
    expect(byId(report, 'client:claude')?.status).toBe('skip')
    fs.mkdirSync(path.join(home, '.codex'))
    report = await runDoctor(input())
    expect(byId(report, 'client:codex')).toMatchObject({ status: 'warn', fix: 'specrails-desktop mcp connect --client codex' })
  })

  it('a failed or misdirected connection test fails or warns with a fix', async () => {
    let report = await runDoctor(input({ verify: async () => ({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:4200', ms: 3 }) }))
    expect(byId(report, 'verify')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Start Specrails/) })
    report = await runDoctor(input({ verify: async () => ({ ok: true, toolCount: 33, serverVersion: '3.4.0', ms: 3 }) }))
    expect(byId(report, 'verify')).toMatchObject({ status: 'warn', title: expect.stringMatching(/another Specrails \(3.4.0\)/) })
    report = await runDoctor(input({ verify: undefined }))
    expect(byId(report, 'verify')?.status).toBe('skip')
  })
})
