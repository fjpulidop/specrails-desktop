import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, realpathSync } from 'fs'
import os from 'os'
import path from 'path'

import { CoreUpdateManager } from './core-update-manager'
import { frameworkRoot, readCurrentFrameworkVersion } from './framework-manager'

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
