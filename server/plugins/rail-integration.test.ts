import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { PluginManager } from '../plugin-manager'
import { setPluginManagerForTesting } from './manager'
import { resolvePluginsForSpawn, snapshotPluginsForJob } from './rail-integration'
import type { Plugin } from '../types'

let projectPath: string
let homeRoot: string

function makePlugin(opts: Partial<{ verifyOk: boolean; reason: string }> = {}): Plugin {
  return {
    manifest: { name: 'serena', version: '1.0.0', description: '', whatItDoes: [], owns: { mcpServers: ['serena'] } },
    install: async (ctx) => {
      await PluginManager.mergeMcpServers(ctx.projectPath, { serena: { command: 'uvx' } })
    },
    uninstall: async (ctx) => {
      await PluginManager.removeMcpServers(ctx.projectPath, ['serena'])
    },
    verify: async () => ({ ok: opts.verifyOk ?? true, reason: opts.reason, checkedAt: new Date().toISOString() }),
  }
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-int-'))
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-home-'))
  process.env.HOME = homeRoot
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  fs.rmSync(homeRoot, { recursive: true, force: true })
  setPluginManagerForTesting(null)
  delete process.env.HOME
})

describe('resolvePluginsForSpawn', () => {
  it('returns empty active/degraded when no plugins installed', async () => {
    setPluginManagerForTesting(new PluginManager([makePlugin()]))
    const r = await resolvePluginsForSpawn(projectPath, 'pid', 'job1')
    expect(r.active).toEqual([])
    expect(r.degraded).toEqual([])
  })

  it('classifies healthy plugin as active', async () => {
    const mgr = new PluginManager([makePlugin({ verifyOk: true })])
    setPluginManagerForTesting(mgr)
    await mgr.install(projectPath, 'pid', 'serena', () => {})
    const r = await resolvePluginsForSpawn(projectPath, 'pid', 'job1')
    expect(r.active).toEqual([{ name: 'serena', version: '1.0.0' }])
    expect(r.degraded).toEqual([])
  })

  it('classifies failing plugin as degraded', async () => {
    const mgr = new PluginManager([makePlugin({ verifyOk: true })])
    setPluginManagerForTesting(mgr)
    await mgr.install(projectPath, 'pid', 'serena', () => {})
    // Now flip verify to fail.
    setPluginManagerForTesting(new PluginManager([makePlugin({ verifyOk: false, reason: 'uv-not-on-path' })]))
    const r = await resolvePluginsForSpawn(projectPath, 'pid', 'job1')
    expect(r.active).toEqual([])
    expect(r.degraded).toEqual([{ name: 'serena', reason: 'uv-not-on-path' }])
  })

  it('BUG-PLUGIN-03: parallel verify of >=2 plugins persists EVERY health update (no lost write)', async () => {
    function named(name: string, key: string, ok: boolean, reason?: string): Plugin {
      return {
        manifest: { name, version: '1.0.0', description: '', whatItDoes: [], owns: { mcpServers: [key] } },
        install: async (ctx) => { await PluginManager.mergeMcpServers(ctx.projectPath, { [key]: { command: key } }) },
        uninstall: async (ctx) => { await PluginManager.removeMcpServers(ctx.projectPath, [key]) },
        verify: async () => ({ ok, reason, checkedAt: new Date().toISOString() }),
      }
    }
    // Install both healthy.
    const installer = new PluginManager([named('a', 'a', true), named('b', 'b', true)])
    setPluginManagerForTesting(installer)
    await installer.install(projectPath, 'pid', 'a', () => {})
    await installer.install(projectPath, 'pid', 'b', () => {})

    // Spawn resolution where BOTH plugins now fail verify (parallel writes).
    setPluginManagerForTesting(new PluginManager([
      named('a', 'a', false, 'a-down'),
      named('b', 'b', false, 'b-down'),
    ]))
    const r = await resolvePluginsForSpawn(projectPath, 'pid', 'job1')
    expect(r.degraded).toHaveLength(2)

    // Both degraded health flags must be persisted — pre-fix only one survived.
    const s = JSON.parse(fs.readFileSync(path.join(projectPath, '.specrails', 'plugins', 'state.json'), 'utf8'))
    expect(s.plugins.a.health).toBe('degraded')
    expect(s.plugins.b.health).toBe('degraded')
  })

  it('flags state-but-no-registry as orphan in degraded', async () => {
    // Pre-populate state.json with a plugin not in the registry.
    const stateDir = path.join(projectPath, '.specrails', 'plugins')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: { ghost: { version: '0.1.0', installedAt: 'now', installedFiles: [] } },
    }))
    setPluginManagerForTesting(new PluginManager([]))
    const r = await resolvePluginsForSpawn(projectPath, 'pid', 'job1')
    expect(r.degraded).toEqual([{ name: 'ghost', reason: 'orphan' }])
  })
})

describe('snapshotPluginsForJob', () => {
  it('writes plugins.json with chmod 400', () => {
    const p = snapshotPluginsForJob('slug-x', 'job-1', 'pid', [{ name: 'serena', version: '1.0.0' }], [])
    expect(fs.existsSync(p)).toBe(true)
    const stat = fs.statSync(p)
    expect(stat.mode & 0o777).toBe(0o400)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    expect(parsed.active).toEqual([{ name: 'serena', version: '1.0.0' }])
    expect(parsed.jobId).toBe('job-1')
  })
})
