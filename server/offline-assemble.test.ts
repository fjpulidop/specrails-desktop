import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import type { ChildProcess } from 'child_process'
import { assembleProjectOffline, canAssembleProject, hasOfflineCore } from './offline-assemble'
import { resolveArtifacts } from './artifact-registry'
import { workspacePathFor } from './workspace-manager'

let priorHome: string | undefined
let homeDir: string
let repoDir: string

beforeEach(() => {
  priorHome = process.env.SPECRAILS_REGISTRY_HOME
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-home-'))
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-repo-'))
  process.env.SPECRAILS_REGISTRY_HOME = homeDir
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = priorHome
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(repoDir, { recursive: true, force: true })
})

function fakeInit(exitCode = 0): { spawn: (args: string[], cwd: string) => ChildProcess; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const spawn = (args: string[], cwd: string): ChildProcess => {
    calls.push({ args, cwd })
    const child = new EventEmitter() as unknown as ChildProcess & { stdout: Readable; stderr: Readable }
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    setImmediate(() => {
      if (exitCode !== 0) child.stderr.push('core blew up\n')
      child.stdout.push(null)
      child.stderr.push(null)
      // materialize the workspace like core's assemble would
      if (exitCode === 0) {
        fs.mkdirSync(path.join(workspacePathFor('my-app'), '.specrails'), { recursive: true })
      }
      setImmediate(() => child.emit('close', exitCode))
    })
    return child
  }
  return { spawn, calls }
}

describe('assembleProjectOffline', () => {
  it('mirrors the registry, writes per-provider configs and runs one init per provider', async () => {
    const init = fakeInit(0)
    await assembleProjectOffline({
      projectPath: repoDir,
      slug: 'my-app',
      desktopProjectId: 'proj-1',
      providers: ['claude', 'codex'],
      io: { spawnInit: init.spawn as never, materialize: vi.fn() },
    })
    expect(init.calls).toHaveLength(2)
    for (const call of init.calls) {
      expect(call.args[0]).toBe('--yes')
      expect(call.args[1]).toBe('--from-config')
      expect(call.cwd).toBe(repoDir)
      const yaml = fs.readFileSync(call.args[2], 'utf-8')
      expect(yaml).toContain('tier: quick')
    }
    // registry entry allocated under the slug
    const resolved = resolveArtifacts(repoDir)
    expect(resolved.entry?.slug).toBe('my-app')
  })

  it('throws when init exits non-zero, including the stderr tail', async () => {
    const init = fakeInit(50)
    await expect(
      assembleProjectOffline({
        projectPath: repoDir,
        slug: 'my-app',
        desktopProjectId: 'proj-1',
        providers: ['claude'],
        io: { spawnInit: init.spawn as never, materialize: vi.fn() },
      }),
    ).rejects.toThrow(/exit 50.*core blew up/)
  })

  it('throws when the workspace was not created', async () => {
    const init = {
      spawn: (_args: string[], _cwd: string): ChildProcess => {
        const child = new EventEmitter() as unknown as ChildProcess & { stdout: Readable; stderr: Readable }
        child.stdout = new Readable({ read() {} })
        child.stderr = new Readable({ read() {} })
        setImmediate(() => {
          child.stdout.push(null)
          child.stderr.push(null)
          setImmediate(() => child.emit('close', 0)) // "succeeds" but creates nothing
        })
        return child
      },
    }
    await expect(
      assembleProjectOffline({
        projectPath: repoDir,
        slug: 'ghost-app',
        desktopProjectId: 'proj-1',
        providers: ['claude'],
        io: { spawnInit: init.spawn as never, materialize: vi.fn() },
      }),
    ).rejects.toThrow(/workspace was not created/)
  })

  it('requires at least one provider', async () => {
    await expect(
      assembleProjectOffline({
        projectPath: repoDir,
        slug: 'my-app',
        desktopProjectId: 'proj-1',
        providers: [],
        io: { spawnInit: fakeInit(0).spawn as never, materialize: vi.fn() },
      }),
    ).rejects.toThrow(/at least one provider/)
  })

  it('hasOfflineCore reflects the bundled core presence', () => {
    expect(typeof hasOfflineCore()).toBe('boolean')
  })
})

describe('canAssembleProject', () => {
  const priorDesktop = process.env.SPECRAILS_IS_DESKTOP
  const priorBundle = process.env.SPECRAILS_BUNDLED_CORE_PATH
  afterEach(() => {
    if (priorDesktop === undefined) delete process.env.SPECRAILS_IS_DESKTOP
    else process.env.SPECRAILS_IS_DESKTOP = priorDesktop
    if (priorBundle === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = priorBundle
  })

  it('allows assemble in non-desktop mode without a bundle (npx fallback)', () => {
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    expect(canAssembleProject()).toBe(true)
  })

  it('blocks assemble in a desktop build with no bundle (corrupted → reinstall)', () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    expect(canAssembleProject()).toBe(false)
  })
})
