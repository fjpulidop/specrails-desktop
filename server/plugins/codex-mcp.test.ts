import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, spawnSync: vi.fn() }
})

import { spawnSync } from 'child_process'
import { codexMcpAdd, codexMcpRemove, codexMcpList, codexHomeFor, ensureCodexHome } from './codex-mcp'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveSpecrailsHome } from '../util/specrails-home'

const mockSpawnSync = vi.mocked(spawnSync)

describe('codex-mcp helpers', () => {
  beforeEach(() => { mockSpawnSync.mockReset() })

  it('codexHomeFor composes the expected path under .specrails/projects/<slug>', () => {
    const p = codexHomeFor('test-slug')
    expect(p).toBe(path.join(resolveSpecrailsHome(), '.specrails', 'projects', 'test-slug', 'codex-home'))
  })

  it('ensureCodexHome creates the directory lazily', () => {
    // Use a unique slug under a tmpdir override is impossible without changing
    // the API — instead assert the function does not throw and the dir exists.
    const slug = `codex-mcp-test-${Date.now()}`
    const dir = ensureCodexHome(slug)
    expect(fs.existsSync(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('codexMcpAdd shells out to `codex mcp add <name> -- <command> <args...>`', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'added', stderr: '', pid: 1, output: [], signal: null } as never)
    const result = codexMcpAdd('test-slug', 'serena', {
      command: 'uvx',
      args: ['--from', 'git+x', 'serena'],
    })
    expect(result.ok).toBe(true)
    const call = mockSpawnSync.mock.calls[0]
    expect(call[0]).toBe('codex')
    const args = call[1] as string[]
    expect(args).toEqual(['mcp', 'add', 'serena', '--', 'uvx', '--from', 'git+x', 'serena'])
    const env = (call[2] as { env?: Record<string, string> }).env
    expect(env?.CODEX_HOME).toContain('test-slug')
  })

  it('codexMcpAdd reports ok=false when exit status is non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'auth missing', pid: 1, output: [], signal: null } as never)
    const result = codexMcpAdd('test-slug', 'serena', { command: 'uvx', args: [] })
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('auth missing')
  })

  it('codexMcpAdd survives execSync throws (returns ok=false)', () => {
    mockSpawnSync.mockReturnValue({ error: new Error('codex not on PATH'), status: null, output: [], signal: null } as never)
    const result = codexMcpAdd('test-slug', 'serena', { command: 'uvx', args: [] })
    expect(result.ok).toBe(false)
  })

  it('codexMcpRemove shells out to `codex mcp remove <name>`', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'removed', stderr: '', pid: 1, output: [], signal: null } as never)
    const result = codexMcpRemove('test-slug', 'serena')
    expect(result.ok).toBe(true)
    const args = mockSpawnSync.mock.calls[0][1] as string[]
    expect(args).toEqual(['mcp', 'remove', 'serena'])
  })

  it('codexMcpList parses server names from the plain-text listing', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '# Registered MCP servers\nserena uvx --from git+x ...\nfoo /path/to/foo\n',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as never)
    const result = codexMcpList('test-slug')
    expect(result.ok).toBe(true)
    expect(result.servers).toEqual(['serena', 'foo'])
  })

  it('codexMcpList returns empty list when codex exits non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'auth missing', pid: 1, output: [], signal: null } as never)
    const result = codexMcpList('test-slug')
    expect(result.ok).toBe(false)
    expect(result.servers).toEqual([])
  })
})
