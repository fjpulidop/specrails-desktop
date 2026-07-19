import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

// Mock child_process BEFORE the codex-mcp module imports it. The Serena
// codex install path shells out to `codex mcp add/remove/list`.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, spawnSync: vi.fn() }
})

import { spawnSync } from 'child_process'
import { installSerena, uninstallSerena } from './install'
import type { PluginLifecycleContext } from '../../types'
import './../../providers' // register claude+codex adapters

const mockSpawnSync = vi.mocked(spawnSync)

let projectPath: string

function makeCtx(providerId?: string): PluginLifecycleContext & { recorded: string[]; logs: string[] } {
  const recorded: string[] = []
  const logs: string[] = []
  return {
    projectPath,
    projectId: 'pid',
    providerId,
    recordInstalledFile: (rel) => recorded.push(rel),
    log: (line) => logs.push(line),
    recorded,
    logs,
  }
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-install-'))
})
afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('installSerena', () => {
  it('creates .mcp.json with the serena entry on a fresh project', async () => {
    const ctx = makeCtx()
    await installSerena(ctx)
    const mcp = JSON.parse(fs.readFileSync(path.join(projectPath, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.serena.command).toBe('uvx')
    expect(mcp.mcpServers.serena.args).toContain('serena')
    expect(mcp.mcpServers.serena.args).toContain('start-mcp-server')
  })

  it('preserves user-authored mcpServers entries', async () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const ctx = makeCtx()
    await installSerena(ctx)
    const mcp = JSON.parse(fs.readFileSync(path.join(projectPath, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.myown.command).toBe('me')
    expect(mcp.mcpServers.serena).toBeDefined()
  })

  it('writes the optional fragment file and records it', async () => {
    const ctx = makeCtx()
    await installSerena(ctx)
    const fragPath = path.join(projectPath, '.claude', 'agents', 'custom-serena.md')
    expect(fs.existsSync(fragPath)).toBe(true)
    expect(ctx.recorded).toContain('.claude/agents/custom-serena.md')
  })
})

describe('uninstallSerena', () => {
  it('removes only the serena mcpServers entry', async () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { myown: { command: 'me' } } }))
    const ctx = makeCtx()
    await installSerena(ctx)
    await uninstallSerena(ctx)
    const mcp = JSON.parse(fs.readFileSync(path.join(projectPath, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.myown).toBeDefined()
    expect(mcp.mcpServers.serena).toBeUndefined()
  })

  it('removes the fragment file', async () => {
    const ctx = makeCtx()
    await installSerena(ctx)
    await uninstallSerena(ctx)
    expect(fs.existsSync(path.join(projectPath, '.claude', 'agents', 'custom-serena.md'))).toBe(false)
  })
})

describe('installSerena / uninstallSerena — codex provider', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset()
  })

  it('codex install spawns `codex mcp add serena -- uvx ...` and does NOT touch .mcp.json', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'added', stderr: '', pid: 1, output: [], signal: null } as never)
    const ctx = makeCtx('codex')
    await installSerena(ctx)

    const call = mockSpawnSync.mock.calls.find((c) => c[0] === 'codex')
    expect(call).toBeDefined()
    const args = call![1] as string[]
    expect(args[0]).toBe('mcp')
    expect(args[1]).toBe('add')
    expect(args[2]).toBe('serena')
    expect(args).toContain('--')
    expect(args).toContain('uvx')
    expect(args).toContain('start-mcp-server')
    // CODEX_HOME exported into the per-project scratch dir
    const env = (call![2] as { env?: Record<string, string> }).env
    expect(env?.CODEX_HOME).toContain('.specrails/projects/')
    expect(env?.CODEX_HOME).toContain('codex-home')

    // .mcp.json untouched on codex projects
    expect(fs.existsSync(path.join(projectPath, '.mcp.json'))).toBe(false)
    // Claude-specific custom-serena.md fragment NOT created on codex
    expect(fs.existsSync(path.join(projectPath, '.claude', 'agents', 'custom-serena.md'))).toBe(false)
  })

  it('codex install throws PluginInstallError when `codex mcp add` exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'auth missing', pid: 1, output: [], signal: null } as never)
    const ctx = makeCtx('codex')
    await expect(installSerena(ctx)).rejects.toThrow(/codex mcp add serena failed.*auth missing/)
  })

  it('codex uninstall probes `codex mcp list` and skips remove when serena is already absent', async () => {
    // First call: codex mcp list returns no serena
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: 'other-server uvx ...', stderr: '', pid: 1, output: [], signal: null } as never)
    const ctx = makeCtx('codex')
    await uninstallSerena(ctx)

    // Only the list call should have happened — no remove subprocess
    const removeCalls = mockSpawnSync.mock.calls.filter((c) => {
      const args = c[1] as string[]
      return args[0] === 'mcp' && args[1] === 'remove'
    })
    expect(removeCalls).toHaveLength(0)
    expect(ctx.logs.some((l) => l.includes('nothing to remove'))).toBe(true)
  })

  it('codex uninstall runs `codex mcp remove serena` when listed', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'serena uvx ...', stderr: '', pid: 1, output: [], signal: null } as never) // list
      .mockReturnValueOnce({ status: 0, stdout: 'removed', stderr: '', pid: 2, output: [], signal: null } as never) // remove
    const ctx = makeCtx('codex')
    await uninstallSerena(ctx)
    const removeCall = mockSpawnSync.mock.calls.find((c) => {
      const args = c[1] as string[]
      return args[0] === 'mcp' && args[1] === 'remove'
    })
    expect(removeCall).toBeDefined()
    expect((removeCall![1] as string[])[2]).toBe('serena')
  })

  it('codex uninstall logs a warning but does not throw when remove fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'serena uvx ...', stderr: '', pid: 1, output: [], signal: null } as never)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'permission denied', pid: 2, output: [], signal: null } as never)
    const ctx = makeCtx('codex')
    await expect(uninstallSerena(ctx)).resolves.toBeUndefined()
    expect(ctx.logs.some((l) => l.includes('codex mcp remove warning'))).toBe(true)
  })
})

describe('installSerena / uninstallSerena — kimi provider', () => {
  it('uses .kimi-code/mcp.json and never writes Claude-only files', async () => {
    const ctx = makeCtx('kimi')
    await installSerena(ctx)

    const kimiConfig = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.kimi-code', 'mcp.json'), 'utf8'),
    )
    expect(kimiConfig.mcpServers.serena.args).toContain('start-mcp-server')
    expect(fs.existsSync(path.join(projectPath, '.mcp.json'))).toBe(false)
    expect(
      fs.existsSync(path.join(projectPath, '.claude', 'agents', 'custom-serena.md')),
    ).toBe(false)
  })

  it('removes only Serena from Kimi MCP config', async () => {
    const configPath = path.join(projectPath, '.kimi-code', 'mcp.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { userServer: { command: 'mine' } },
    }))
    const ctx = makeCtx('kimi')
    await installSerena(ctx)
    await uninstallSerena(ctx)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(after.mcpServers.userServer).toEqual({ command: 'mine' })
    expect(after.mcpServers.serena).toBeUndefined()
  })
})
