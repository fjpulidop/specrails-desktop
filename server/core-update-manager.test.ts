import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, realpathSync, readdirSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

import { CoreUpdateManager } from './core-update-manager'
import { frameworkRoot, readCurrentFrameworkVersion } from './framework-manager'
import { managedCoreRoot, resolveCoreRuntime } from './core-runtime'

/** Minimal fake of core's compiled CLI — enough for install-framework + swap-current. */
const FAKE_CLI = `
const fs = require('fs'); const path = require('path')
function arg(n){const i=process.argv.indexOf('--'+n);return i>=0?process.argv[i+1]:undefined}
const pd=(p)=>p==='codex'?'.codex':p==='gemini'?'.gemini':'.claude'
function swap(fw,v){const c=path.join(fw,'current');try{fs.unlinkSync(c)}catch{}fs.symlinkSync(v,c)}
const sub=process.argv[2]
if(sub==='install-framework'){const fw=arg('framework-dir');const v=arg('version');const d=path.join(fw,v,pd(arg('provider')),'agents');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'sr-architect.md'),'x');if(!process.argv.includes('--no-swap'))swap(fw,v);process.exit(0)}
if(sub==='swap-current'){const fw=arg('framework-dir');const v=arg('version');if(!fs.existsSync(path.join(fw,v)))process.exit(41);swap(fw,v);process.exit(0)}
process.exit(7)
`
/** Fake CLI whose install-framework always fails. */
const FAKE_CLI_FAIL = `process.exit(2)`

function writeCore(dir: string, version: string, cliBody = FAKE_CLI): void {
  mkdirSync(path.join(dir, 'dist', 'installer'), { recursive: true })
  writeFileSync(path.join(dir, 'dist', 'installer', 'cli.js'), cliBody)
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
}

describe('CoreUpdateManager', () => {
  let home: string
  let bundledCore: string
  let prevEnv: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'cu-home-'))
    bundledCore = mkdtempSync(path.join(os.tmpdir(), 'cu-bundled-'))
    prevEnv = process.env.SPECRAILS_BUNDLED_CORE_PATH
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = prevEnv
    rmSync(home, { recursive: true, force: true })
    rmSync(bundledCore, { recursive: true, force: true })
  })

  /** Make the bundled core present (so isAvailable() is true) at `version`. */
  function bundle(version = '4.8.0'): void {
    writeCore(bundledCore, version)
    process.env.SPECRAILS_BUNDLED_CORE_PATH = bundledCore
  }

  /** npmInstall mock that stages a fake newer core into <cwd>/node_modules/specrails-core. */
  function stagingInstaller(version: string, cliBody = FAKE_CLI) {
    return (_spec: string, cwd: string): void => {
      writeCore(path.join(cwd, 'node_modules', 'specrails-core'), version, cliBody)
    }
  }

  describe('availability + status', () => {
    it('reports unavailable when no bundled core', () => {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const m = new CoreUpdateManager({ home })
      expect(m.isAvailable()).toBe(false)
      const s = m.getStatus()
      expect(s.available).toBe(false)
      expect(s.bundledVersion).toBeNull()
    })

    it('falls back currentVersion to bundled when no framework/current yet', () => {
      bundle('4.8.0')
      const m = new CoreUpdateManager({ home })
      const s = m.getStatus()
      expect(s.available).toBe(true)
      expect(s.bundledVersion).toBe('4.8.0')
      expect(s.currentVersion).toBe('4.8.0')
      expect(s.updateAvailable).toBe(false)
      expect(s.latestVersion).toBeNull()
    })
  })

  describe('checkForUpdate', () => {
    it('retains the last registry result offline after a fresh manager is constructed', async () => {
      bundle('4.12.0')
      await new CoreUpdateManager({ home, fetchLatest: async () => '5.0.0' }).checkForUpdate()
      const restarted = new CoreUpdateManager({ home, fetchLatest: async () => { throw new Error('offline') } })
      await expect(restarted.checkForUpdate()).rejects.toThrow('offline')
      expect(restarted.getStatus()).toMatchObject({ currentVersion: '4.12.0', latestVersion: '5.0.0', updateAvailable: true })
    })
    it('caches the latest version and computes updateAvailable', async () => {
      bundle('4.8.0')
      const m = new CoreUpdateManager({ home, fetchLatest: async () => '4.9.0' })
      const s = await m.checkForUpdate()
      expect(s.latestVersion).toBe('4.9.0')
      expect(s.updateAvailable).toBe(true)
      expect(s.lastCheckedAt).toBeTypeOf('number')
    })

    it('does not flag an update when latest equals current', async () => {
      bundle('4.9.0')
      const m = new CoreUpdateManager({ home, fetchLatest: async () => '4.9.0' })
      const s = await m.checkForUpdate()
      expect(s.updateAvailable).toBe(false)
    })

    it('throws on an unparseable npm version', async () => {
      bundle('4.8.0')
      const m = new CoreUpdateManager({ home, fetchLatest: async () => 'not-a-version' })
      await expect(m.checkForUpdate()).rejects.toThrow(/unparseable/)
    })

    describe('default registry fetch (no injected fetchLatest)', () => {
      const realFetch = global.fetch
      afterEach(() => {
        global.fetch = realFetch
      })

      it('reads the version from the npm registry response', async () => {
        bundle('4.8.0')
        global.fetch = (async () => ({ ok: true, json: async () => ({ version: '4.9.1' }) })) as never
        const m = new CoreUpdateManager({ home })
        const s = await m.checkForUpdate()
        expect(s.latestVersion).toBe('4.9.1')
        expect(s.updateAvailable).toBe(true)
      })

      it('throws when the registry responds non-2xx', async () => {
        bundle('4.8.0')
        global.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never
        const m = new CoreUpdateManager({ home })
        await expect(m.checkForUpdate()).rejects.toThrow(/503/)
      })

      it('throws when the registry response has no version', async () => {
        bundle('4.8.0')
        global.fetch = (async () => ({ ok: true, json: async () => ({}) })) as never
        const m = new CoreUpdateManager({ home })
        await expect(m.checkForUpdate()).rejects.toThrow(/no version/)
      })
    })
  })

  describe('update', () => {
    it('materializes + swaps current to the newer staged core and broadcasts', async () => {
      bundle('4.8.0')
      const events: Array<Record<string, unknown>> = []
      const m = new CoreUpdateManager({
        home,
        broadcast: (msg) => events.push(msg as Record<string, unknown>),
        providers: () => ['claude', 'gemini'],
        fetchLatest: async () => '4.9.0',
        npmInstall: stagingInstaller('4.9.0'),
      })
      await m.checkForUpdate()
      const res = await m.update()
      expect(res).toEqual({ ok: true, version: '4.9.0' })
      expect(readCurrentFrameworkVersion(home)).toBe('4.9.0')
      const fw = frameworkRoot(home)
      expect(existsSync(path.join(fw, '4.9.0', '.claude', 'agents', 'sr-architect.md'))).toBe(true)
      expect(existsSync(path.join(fw, '4.9.0', '.gemini', 'agents'))).toBe(true)
      const phases = events.filter((e) => e.type === 'core_update.progress').map((e) => e.phase)
      expect(phases).toContain('downloading')
      expect(phases).toContain('materializing')
      expect(phases).toContain('done')
      expect(events.some((e) => e.type === 'framework.updated' && e.version === '4.9.0')).toBe(true)
    })

    it('keeps the full runtime across a real Node restart and uses it for offline materialization', async () => {
      bundle('4.12.0')
      const statuses: boolean[] = []
      const manager = new CoreUpdateManager({
        home,
        npmInstall: (spec, cwd) => {
          stagingInstaller('5.0.0', `require('retained-dependency');\n${FAKE_CLI}`)(spec, cwd)
          const dependency = path.join(cwd, 'node_modules', 'retained-dependency')
          mkdirSync(dependency, { recursive: true })
          writeFileSync(path.join(dependency, 'index.js'), 'module.exports = true')
        },
        broadcast: event => { if (event.type === 'core_update.progress' && event.phase === 'done') statuses.push(manager.getStatus().updating) },
      })
      expect(await manager.update('5.0.0')).toEqual({ ok: true, version: '5.0.0' })
      expect(statuses).toEqual([false])
      const entry = path.resolve('server/core-runtime.ts')
      const framework = path.resolve('server/framework-manager.ts')
      const script = `const { resolveCoreRuntime } = require(${JSON.stringify(entry)}); const { FrameworkManager } = require(${JSON.stringify(framework)}); const home=${JSON.stringify(home)}; const runtime=resolveCoreRuntime(home); const fm=new FrameworkManager({home}); const boot=fm.versionCheck(['claude']); const materialized=fm.materialize(undefined,['codex']); process.stdout.write(JSON.stringify({runtime,boot,materialized}));`
      const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, SPECRAILS_BUNDLED_CORE_PATH: bundledCore, SPECRAILS_CORE_BIN: '', SPECRAILS_REGISTRY_HOME: home },
      })
      expect(child.status, child.stderr).toBe(0)
      const result = JSON.parse(child.stdout)
      expect(result.runtime).toMatchObject({ version: '5.0.0', source: 'managed' })
      expect(result.boot).toEqual({ swapped: false, version: '5.0.0' })
      expect(result.materialized.errors).toEqual([])
      expect(result.materialized.providers).toEqual(['codex'])
      expect(new CoreUpdateManager({ home }).getStatus()).toMatchObject({ currentVersion: '5.0.0', runtimeVersion: '5.0.0', runtimeSource: 'managed', bundledVersion: '4.12.0' })
    })

    it('does not publish a downloaded package with the wrong version', async () => {
      bundle('4.12.0')
      const manager = new CoreUpdateManager({ home, npmInstall: stagingInstaller('5.1.0') })
      expect(await manager.update('5.0.0')).toMatchObject({ ok: false, error: expect.stringMatching(/does not match/) })
      expect(resolveCoreRuntime(home)?.version).toBe('4.12.0')
      expect(readCurrentFrameworkVersion(home)).toBeNull()
    })
    it('repairs an incomplete retained package automatically while retaining its old contents', async () => {
      bundle('4.12.0')
      const destination = path.join(managedCoreRoot(home), '5.0.0')
      mkdirSync(destination, { recursive: true })
      writeFileSync(path.join(destination, 'previous-evidence.txt'), 'retain this failed stage')
      const manager = new CoreUpdateManager({ home, npmInstall: stagingInstaller('5.0.0') })
      expect(await manager.update('5.0.0')).toEqual({ ok: true, version: '5.0.0' })
      const backup = readdirSync(managedCoreRoot(home)).find(name => name.startsWith('.previous-5.0.0-'))!
      expect(readFileSync(path.join(managedCoreRoot(home), backup, 'installation', 'previous-evidence.txt'), 'utf8')).toBe('retain this failed stage')
    })
    it('does not move current if recovery metadata cannot be persisted', async () => {
      bundle('4.12.0')
      const fw = frameworkRoot(home)
      mkdirSync(path.join(fw, '4.12.0'), { recursive: true })
      symlinkSync('4.12.0', path.join(fw, 'current'))
      mkdirSync(path.join(managedCoreRoot(home), 'update-status.json'), { recursive: true })
      let reseeded = false
      const manager = new CoreUpdateManager({ home, npmInstall: stagingInstaller('5.0.0'), reseed: async () => { reseeded = true; return [] } })
      expect(await manager.update('5.0.0')).toMatchObject({ ok: false, error: expect.stringMatching(/persist Core update recovery state/) })
      expect(readCurrentFrameworkVersion(home)).toBe('4.12.0')
      expect(reseeded).toBe(false)
    })
    it('does not replace a newer registry-latest result with the explicitly installed version', async () => {
      bundle('4.12.0')
      const manager = new CoreUpdateManager({ home, npmInstall: stagingInstaller('5.0.0'), fetchLatest: async () => '5.1.0' })
      await manager.checkForUpdate()
      const checkedAt = manager.getStatus().lastCheckedAt
      expect((await manager.update('5.0.0')).ok).toBe(true)
      expect(manager.getStatus()).toMatchObject({ latestVersion: '5.1.0', currentVersion: '5.0.0', updateAvailable: true, lastCheckedAt: checkedAt })
    })

    it('persists partial project refresh and retries it offline after restart without reporting premature success', async () => {
      bundle('4.12.0')
      const events: string[] = []
      const manager = new CoreUpdateManager({
        home, npmInstall: stagingInstaller('5.0.0'),
        reseed: async () => [{ projectId: 'fixture-project', error: 'copy failed' }],
        broadcast: event => { if (event.phase) events.push(String(event.phase)) },
      })
      expect(await manager.update('5.0.0')).toMatchObject({ ok: false, error: expect.stringMatching(/fixture-project/) })
      expect(events).not.toContain('done')
      const restarted = new CoreUpdateManager({
        home,
        npmInstall: () => { throw new Error('network must not be used for repair') },
        reseed: async () => [{ projectId: 'fixture-project' }],
      })
      expect(restarted.getStatus()).toMatchObject({ pendingVersion: '5.0.0', updateAvailable: true, currentVersion: '5.0.0' })
      expect(await restarted.update()).toEqual({ ok: true, version: '5.0.0' })
      expect(restarted.getStatus()).toMatchObject({ pendingVersion: null, migrationError: null, updating: false })
    })

    it('stages the download under a fully realpathed tmp dir (symlinked macOS /var/folders)', async () => {
      // Core's cli.js auto-run guard compares import.meta.url (realpathed by
      // Node) against the literal argv[1]; a symlinked staging path makes the
      // child a silent exit-0 no-op. The staging dir must therefore already be
      // symlink-free.
      bundle('4.8.0')
      let stagedCwd = ''
      let stagedReal = ''
      const m = new CoreUpdateManager({
        home,
        providers: () => ['claude'],
        fetchLatest: async () => '4.9.0',
        npmInstall: (spec, cwd) => {
          stagedCwd = cwd
          stagedReal = realpathSync(cwd) // while the dir still exists
          stagingInstaller('4.9.0')(spec, cwd)
        },
      })
      await m.checkForUpdate()
      const res = await m.update()
      expect(res.ok).toBe(true)
      expect(stagedCwd).not.toBe('')
      expect(stagedCwd).toBe(stagedReal)
    })

    it('rejects when unavailable (no bundled core)', async () => {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const m = new CoreUpdateManager({ home, npmInstall: stagingInstaller('4.9.0') })
      const res = await m.update('4.9.0')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/unavailable/i)
    })

    it('rejects when there is no valid target version', async () => {
      bundle('4.8.0')
      const m = new CoreUpdateManager({ home })
      const res = await m.update()
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/valid target/i)
    })

    it('rejects a target that is not newer than current', async () => {
      bundle('5.0.0')
      // Seed framework/current at 5.0.0.
      const fw = frameworkRoot(home)
      mkdirSync(path.join(fw, '5.0.0'), { recursive: true })
      symlinkSync('5.0.0', path.join(fw, 'current'))
      const m = new CoreUpdateManager({ home, npmInstall: stagingInstaller('4.0.0') })
      const res = await m.update('4.0.0')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/not newer/i)
    })

    it('surfaces a materialize failure as a failed result + error event', async () => {
      bundle('4.8.0')
      const events: Array<Record<string, unknown>> = []
      const m = new CoreUpdateManager({
        home,
        broadcast: (msg) => events.push(msg as Record<string, unknown>),
        npmInstall: stagingInstaller('4.9.0', FAKE_CLI_FAIL),
      })
      const res = await m.update('4.9.0')
      expect(res.ok).toBe(false)
      expect(readCurrentFrameworkVersion(home)).toBeNull()
      expect(events.some((e) => e.type === 'core_update.progress' && e.phase === 'error')).toBe(true)
    })

    it('surfaces the swap-current subprocess stderr in the error', async () => {
      bundle('4.8.0')
      // install-framework succeeds; swap-current fails loudly.
      const cliSwapFail = FAKE_CLI.replace(
        `if(sub==='swap-current'){const fw=arg('framework-dir');const v=arg('version');if(!fs.existsSync(path.join(fw,v)))process.exit(41);swap(fw,v);process.exit(0)}`,
        `if(sub==='swap-current'){process.stderr.write('symlink EPERM: operation not permitted');process.exit(41)}`,
      )
      const m = new CoreUpdateManager({
        home,
        npmInstall: stagingInstaller('4.9.0', cliSwapFail),
      })
      const res = await m.update('4.9.0')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/swap-current failed: .*EPERM/)
      expect(readCurrentFrameworkVersion(home)).toBeNull()
    })

    it('fails BEFORE the swap when materialize reports no errors but zero providers', async () => {
      bundle('4.8.0')
      let swapAttempted = false
      const m = new CoreUpdateManager({
        home,
        npmInstall: stagingInstaller('4.9.0'),
        makeFramework: () =>
          ({
            bundledVersion: () => '4.9.0',
            materialize: () => ({ ran: true, version: '4.9.0', providers: [], errors: [] }),
            swapCurrentDetailed: () => {
              swapAttempted = true
              return { ok: false, detail: null }
            },
          }) as unknown as import('./framework-manager').FrameworkManager,
      })
      const res = await m.update('4.9.0')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/without materializing any provider/)
      expect(swapAttempted).toBe(false)
    })

    it('fails when the staged core has no cli.js', async () => {
      bundle('4.8.0')
      const m = new CoreUpdateManager({
        home,
        // installer that produces an empty node_modules/specrails-core (no dist).
        npmInstall: (_s, cwd) => mkdirSync(path.join(cwd, 'node_modules', 'specrails-core'), { recursive: true }),
      })
      const res = await m.update('4.9.0')
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/cli\.js/)
    })
  })
})
