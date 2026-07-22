import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isFrameworkAutoswapEnabled,
  readWorkspaceFrameworkVersion,
  reseedStaleWorkspaces,
  type ReseedProject,
} from './framework-reseed'
import { workspacePathFor } from './workspace-manager'

let priorHome: string | undefined
let homeDir: string

const project = (slug = 'my-app'): ReseedProject => ({ id: `proj-${slug}`, slug, path: `/tmp/repo-${slug}` })

function seedWorkspace(slug: string, version: string, opts?: { mcp?: string; providers?: string[] }): string {
  const ws = workspacePathFor(slug)
  fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), version)
  for (const dir of opts?.providers ?? ['.claude']) {
    fs.mkdirSync(path.join(ws, dir), { recursive: true })
  }
  if (opts?.mcp !== undefined) fs.writeFileSync(path.join(ws, '.mcp.json'), opts.mcp)
  return ws
}

beforeEach(() => {
  priorHome = process.env.SPECRAILS_REGISTRY_HOME
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-home-'))
  process.env.SPECRAILS_REGISTRY_HOME = homeDir
  delete process.env.SPECRAILS_FRAMEWORK_AUTOSWAP
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = priorHome
  fs.rmSync(homeDir, { recursive: true, force: true })
})

describe('isFrameworkAutoswapEnabled', () => {
  it('defaults on; disabled by false/0/off', () => {
    expect(isFrameworkAutoswapEnabled()).toBe(true)
    for (const v of ['false', '0', 'off', 'OFF']) {
      process.env.SPECRAILS_FRAMEWORK_AUTOSWAP = v
      expect(isFrameworkAutoswapEnabled()).toBe(false)
    }
    process.env.SPECRAILS_FRAMEWORK_AUTOSWAP = '1'
    expect(isFrameworkAutoswapEnabled()).toBe(true)
  })
})

describe('reseedStaleWorkspaces', () => {
  it('re-seeds only workspaces whose recorded version differs from current', async () => {
    seedWorkspace('stale', '4.12.0')
    seedWorkspace('fresh', '5.0.0')
    const assemble = vi.fn(async (p: ReseedProject) => {
      fs.writeFileSync(
        path.join(workspacePathFor(p.slug), '.specrails', 'specrails-version'),
        '5.0.0',
      )
    })
    const results = await reseedStaleWorkspaces(
      [project('stale'), project('fresh'), project('never-relocated')],
      '5.0.0',
      { assemble },
    )
    expect(assemble).toHaveBeenCalledTimes(1)
    expect(assemble.mock.calls[0][0].slug).toBe('stale')
    expect(results).toEqual([
      { projectId: 'proj-stale', reseeded: true },
      { projectId: 'proj-fresh', reseeded: false, skippedReason: 'up-to-date' },
      { projectId: 'proj-never-relocated', reseeded: false, skippedReason: 'not-relocated' },
    ])
    expect(readWorkspaceFrameworkVersion('stale')).toBe('5.0.0')
  })

  it('is idempotent — a second pass after success skips everything', async () => {
    seedWorkspace('stale', '4.12.0')
    const assemble = vi.fn(async (p: ReseedProject) => {
      fs.writeFileSync(path.join(workspacePathFor(p.slug), '.specrails', 'specrails-version'), '5.0.0')
    })
    await reseedStaleWorkspaces([project('stale')], '5.0.0', { assemble })
    const second = await reseedStaleWorkspaces([project('stale')], '5.0.0', { assemble })
    expect(assemble).toHaveBeenCalledTimes(1)
    expect(second[0].skippedReason).toBe('up-to-date')
  })

  it('preserves plugin/user .mcp.json keys byte-identically when the assemble touches the file', async () => {
    const mcp = JSON.stringify({ mcpServers: { serena: { command: 'uvx' }, mine: { command: 'x' } } })
    seedWorkspace('stale', '4.12.0', { mcp })
    const assemble = vi.fn(async (p: ReseedProject) => {
      const ws = workspacePathFor(p.slug)
      fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '5.0.0')
      fs.writeFileSync(path.join(ws, '.mcp.json'), '{"mcpServers":{}}') // clobber attempt
    })
    await reseedStaleWorkspaces([project('stale')], '5.0.0', { assemble })
    expect(fs.readFileSync(path.join(workspacePathFor('stale'), '.mcp.json'), 'utf-8')).toBe(mcp)
  })

  it('rollback: re-pointing current to a prior version re-seeds again', async () => {
    seedWorkspace('app', '4.12.0')
    const assemble = vi.fn(async (p: ReseedProject, providers: string[]) => {
      void providers
      // core writes the CURRENT version marker
      const target = (assemble.mock.calls.length <= 1) ? '5.0.0' : '4.12.0'
      fs.writeFileSync(path.join(workspacePathFor(p.slug), '.specrails', 'specrails-version'), target)
    })
    await reseedStaleWorkspaces([project('app')], '5.0.0', { assemble })
    expect(readWorkspaceFrameworkVersion('app')).toBe('5.0.0')
    // Rollback: current points back at 4.12.0 → workspace is stale again.
    const results = await reseedStaleWorkspaces([project('app')], '4.12.0', { assemble })
    expect(results[0].reseeded).toBe(true)
    expect(readWorkspaceFrameworkVersion('app')).toBe('4.12.0')
  })

  it('a failing assemble is reported per-project and never throws', async () => {
    seedWorkspace('stale', '4.12.0')
    const results = await reseedStaleWorkspaces([project('stale')], '5.0.0', {
      assemble: async () => { throw new Error('assemble exploded') },
    })
    expect(results[0].reseeded).toBe(false)
    expect(results[0].error).toMatch(/assemble exploded/)
  })

  it('null current version is a global no-op', async () => {
    seedWorkspace('stale', '4.12.0')
    const assemble = vi.fn()
    const results = await reseedStaleWorkspaces([project('stale')], null, { assemble })
    expect(results).toEqual([])
    expect(assemble).not.toHaveBeenCalled()
  })
})
