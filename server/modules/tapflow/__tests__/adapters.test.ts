import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstallation, createInstallerTerminal, createTapflowService, LOOPBACK_PRELOAD, npmCliFor, tapflowPaths, tapflowToolsDir } from '../adapters/process'
import { createTapflowRelay, createTapflowSecrets } from '../adapters/relay'
import { TAPFLOW_VERSION } from '../domain'
import { createFootprintReader } from '../adapters/footprint'

const dirs: string[] = []
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-test-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('loopback preload', () => {
  it('keeps a wildcard listen (Tapflow binds "::") and a bare port on 127.0.0.1, and leaves an explicit host alone', () => {
    const dir = tempDir()
    const preload = path.join(dir, 'loopback.cjs')
    fs.writeFileSync(preload, LOOPBACK_PRELOAD)
    const probe = `
      const net = require('node:net')
      const addr = (opts) => new Promise((resolve) => { const s = net.createServer(); s.listen(opts, () => { const a = s.address(); s.close(); resolve(a.address) }) })
      ;(async () => {
        const wide = await addr({ port: 0, host: '::', ipv6Only: false })
        // A bare-port listen in the probe process, on purpose (the preload must pin it to loopback).
        const anyPort = 0
        const bare = await new Promise((resolve) => { const s = net.createServer(); s.listen(anyPort, () => { const a = s.address(); s.close(); resolve(a.address) }) })
        const v4any = await addr({ port: 0, host: '0.0.0.0' })
        const v6loop = await addr({ port: 0, host: '::1' }).catch(() => 'no-ipv6')
        console.log(JSON.stringify({ wide, bare, v4any, v6loop }))
      })()`
    const out = JSON.parse(execFileSync(process.execPath, ['--require', preload, '-e', probe], { encoding: 'utf8' }).trim())
    expect(out).toMatchObject({ wide: '127.0.0.1', bare: '127.0.0.1', v4any: '127.0.0.1' })
    expect(['::1', 'no-ipv6']).toContain(out.v6loop)
  })
})

describe('installation', () => {
  it('lives under the Specrails home and sees the pinned packages only at the pinned version', () => {
    expect(tapflowToolsDir({ SPECRAILS_REGISTRY_HOME: '/reg' })).toBe(path.join('/reg', '.specrails', 'tools', 'tapflow'))
    const paths = tapflowPaths(tempDir())
    const installation = createInstallation({ paths, bundledNode: () => null, home: tempDir() })
    expect(installation.present(TAPFLOW_VERSION)).toBe(false)
    for (const pkg of ['tapflow', '@tapflowio/mcp-server']) {
      fs.mkdirSync(path.join(paths.toolsDir, 'node_modules', pkg), { recursive: true })
      fs.writeFileSync(path.join(paths.toolsDir, 'node_modules', pkg, 'package.json'), JSON.stringify({ version: TAPFLOW_VERSION }))
    }
    expect(installation.present(TAPFLOW_VERSION)).toBe(true)
    expect(installation.present('0.34.0')).toBe(false)
  })

  it('detects a Tapflow the person configured in ~/.tapflow', () => {
    const home = tempDir()
    const installation = createInstallation({ paths: tapflowPaths(tempDir()), bundledNode: () => null, home })
    const before = installation.externalPresent()
    fs.mkdirSync(path.join(home, '.tapflow'))
    fs.writeFileSync(path.join(home, '.tapflow', 'tapflow.config.json'), '{}')
    expect(installation.externalPresent()).toBe(true)
    // (false before unless a `tapflow` happens to be on this machine's PATH)
    expect(typeof before).toBe('boolean')
  })

  it('prefers the bundled Node, accepts it only with npm beside it, and removes everything on uninstall', async () => {
    const paths = tapflowPaths(tempDir())
    const installation = createInstallation({ paths, bundledNode: () => process.execPath })
    const node = installation.resolveNode()
    if (npmCliFor(process.execPath)) expect(node).toEqual({ nodePath: process.execPath })
    else expect('issue' in node || 'nodePath' in node).toBe(true)
    fs.mkdirSync(path.join(paths.toolsDir, 'secrets'), { recursive: true })
    await installation.remove()
    expect(fs.existsSync(paths.toolsDir)).toBe(false)
  })
})

describe('npm beside node', () => {
  const layout = (root: string, npmUnder: string) => {
    fs.mkdirSync(path.join(root, npmUnder, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, npmUnder, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
  }

  it('finds npm in the prefix of a symlinked node (Homebrew) and beside a real one (tarball, bundle)', () => {
    const brew = tempDir()
    fs.mkdirSync(path.join(brew, 'Cellar', 'node', '25', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(brew, 'Cellar', 'node', '25', 'bin', 'node'), '')
    fs.mkdirSync(path.join(brew, 'bin'))
    fs.symlinkSync(path.join(brew, 'Cellar', 'node', '25', 'bin', 'node'), path.join(brew, 'bin', 'node'))
    layout(brew, '.')
    expect(npmCliFor(path.join(brew, 'bin', 'node'))).toBe(path.join(brew, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    const tarball = tempDir()
    fs.mkdirSync(path.join(tarball, 'bin'))
    fs.writeFileSync(path.join(tarball, 'bin', 'node'), '')
    expect(npmCliFor(path.join(tarball, 'bin', 'node'))).toBeNull()
    layout(tarball, '.')
    expect(npmCliFor(path.join(tarball, 'bin', 'node'))).toBe(path.join(tarball, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  })
})

describe('installer terminal', () => {
  it('runs the install script through zsh in the app-scope terminal and reports its exit code', () => {
    const paths = tapflowPaths(tempDir())
    const created: Array<{ scope: string; opts: Record<string, unknown> }> = []
    let exit: ((e: { code: number | null; signal: number | null }) => void) | null = null
    const installer = createInstallerTerminal({ paths, terminals: () => ({ create: (scope, opts) => { created.push({ scope, opts: opts as unknown as Record<string, unknown> }); exit = opts.onExit; return { id: 'pty-1' } } }) })
    const node = npmCliFor(process.execPath) ? process.execPath : null
    if (!node) return // this machine's node has no npm beside it; the domain test covers the script
    const codes: Array<number | null> = []
    expect(installer.open(node, (code) => codes.push(code))).toEqual({ sessionId: 'pty-1' })
    expect(created[0]!.scope).toBe('__app__')
    const command = created[0]!.opts.command as { file: string; args: string[] }
    expect(command.file).toBe('/bin/zsh')
    expect(command.args[0]).toBe('-lc')
    expect(command.args[1]).toContain(' setup')
    exit!({ code: 0, signal: null })
    expect(codes).toEqual([0])
  })
})

describe('supervised service', () => {
  it('starts with its config and preload, reports an unexpected exit, and stops with SIGTERM', async () => {
    const paths = tapflowPaths(tempDir())
    // A stand-in for `tapflow start`: prints the env it got, then waits for SIGTERM.
    fs.mkdirSync(path.dirname(paths.tapflowCli), { recursive: true })
    fs.writeFileSync(paths.tapflowCli, `console.log(JSON.stringify({ home: process.env.TAPFLOW_HOME, port: process.env.TAPFLOW_PORT, opts: process.env.NODE_OPTIONS, args: process.argv.slice(2) })); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`)
    const service = createTapflowService({ paths, spawnImpl: spawn })
    const exits: string[] = []
    service.start({ nodePath: process.execPath, port: 4999 }, (detail) => exits.push(detail))
    expect(service.state()).toBe('alive')
    expect(service.pid()).toBeGreaterThan(0)
    expect(JSON.parse(fs.readFileSync(path.join(paths.home, 'tapflow.config.json'), 'utf8'))).toEqual({ local: { port: 4999 }, agent: { lean: true } })
    expect(fs.readFileSync(paths.preload, 'utf8')).toBe(LOOPBACK_PRELOAD)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const printed = JSON.parse(fs.readFileSync(paths.serviceLog, 'utf8').trim().split('\n')[0]!)
    expect(printed).toMatchObject({ home: paths.home, port: '4999', args: ['start'] })
    expect(printed.opts).toContain(paths.preload)
    await service.stop()
    expect(service.state()).toBe('none')
    expect(exits).toHaveLength(1)
  })

  it('kills a service that ignores SIGTERM after the grace period', async () => {
    const paths = tapflowPaths(tempDir())
    fs.mkdirSync(path.dirname(paths.tapflowCli), { recursive: true })
    fs.writeFileSync(paths.tapflowCli, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
    const service = createTapflowService({ paths, stopGraceMs: 300 })
    service.start({ nodePath: process.execPath, port: 4998 }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    await service.stop()
    expect(service.state()).toBe('none')
  })
})

describe('relay', () => {
  const okJson = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  it('probes liveness and creates the account and token once, keeping secrets 0600', async () => {
    const secretsDir = path.join(tempDir(), 'secrets')
    const calls: Array<{ url: string; body?: string; cookie?: string | null }> = []
    let initialized = false
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), body: init?.body as string | undefined, cookie: headers.get('cookie') })
      if (String(url).endsWith('/auth/status')) return okJson({ initialized, canInitialize: !initialized })
      if (String(url).endsWith('/auth/init')) { initialized = true; return okJson({ ok: true }, 201) }
      if (String(url).endsWith('/auth/login')) return okJson({ ok: true }, 200, { 'set-cookie': 'tapflow_token=abc; Path=/; HttpOnly; SameSite=Lax' })
      if (String(url).endsWith('/tokens')) return okJson({ token: 'tflw_pat_secret' }, 201)
      return okJson({}, 404)
    }) as typeof fetch
    const relay = createTapflowRelay({ secretsDir, fetchImpl })
    expect(await relay.answering(4310)).toBe(true)
    await relay.ensureCredentials(4310)
    const secrets = createTapflowSecrets(secretsDir)
    expect(secrets.token()).toBe('tflw_pat_secret')
    expect(secrets.admin()?.email).toBe('specrails@localhost')
    expect(secrets.admin()!.password.length).toBeGreaterThanOrEqual(24)
    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700)
    for (const file of fs.readdirSync(secretsDir)) expect(fs.statSync(path.join(secretsDir, file)).mode & 0o777).toBe(0o600)
    expect(calls.find((call) => call.url.endsWith('/tokens'))?.cookie).toBe('tapflow_token=abc')
    expect(JSON.parse(calls.find((call) => call.url.endsWith('/tokens'))!.body!)).toEqual({ name: 'specrails', scope: 'view,builds:write' })
    const before = calls.length
    await relay.ensureCredentials(4310)
    expect(calls.length).toBe(before)
  })

  it('refuses an install that already has an account it did not create, and treats silence as not answering', async () => {
    const relay = createTapflowRelay({ secretsDir: path.join(tempDir(), 'secrets'), fetchImpl: (async () => okJson({ initialized: true })) as typeof fetch })
    await expect(relay.ensureCredentials(4310)).rejects.toThrow('did not create')
    const silent = createTapflowRelay({ secretsDir: tempDir(), fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch, sleep: async () => {} })
    expect(await silent.answering(4310)).toBe(false)
    expect(await silent.waitAnswering(4310, 0)).toBe(false)
  })
})

describe('footprint reader', () => {
  it('samples top in the background at most once per TTL and answers from the last sample', async () => {
    let clock = 0
    let calls = 0
    const reader = createFootprintReader({ platform: 'darwin', ttlMs: 15_000, now: () => clock, runTop: async () => { calls++; return 'PID MEM\n200 2048M\n201 1M\n' } })
    expect(reader.current([200, 201]).size).toBe(0) // first call starts a sample; the view never waits for it
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reader.current([200, 201, 999])).toEqual(new Map([[200, 2048 * 1024 ** 2], [201, 1024 ** 2]]))
    clock = 10_000
    reader.current([200])
    expect(calls).toBe(1)
    clock = 16_000
    reader.current([200])
    expect(calls).toBe(2)
  })

  it('does nothing off macOS or without devices, and survives a failing top', async () => {
    let calls = 0
    const linux = createFootprintReader({ platform: 'linux', runTop: async () => { calls++; return '' } })
    expect(linux.current([1]).size).toBe(0)
    const idle = createFootprintReader({ platform: 'darwin', runTop: async () => { calls++; return '' } })
    expect(idle.current([]).size).toBe(0)
    expect(calls).toBe(0)
    const failing = createFootprintReader({ platform: 'darwin', runTop: async () => { throw new Error('top missing') } })
    expect(failing.current([1]).size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failing.current([1]).size).toBe(0)
  })
})
