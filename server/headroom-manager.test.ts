import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDesktopDb, setDesktopSetting } from './desktop-db'
import {
  HEADROOM_MANAGED_PYTHON_VERSION,
  HeadroomManager,
  getHeadroomManagedInstallPlan,
  parseWindowsOwnershipSnapshot,
  windowsSnapshotHasOwnedListener,
} from './headroom-manager'
import { getHeadroomRoutingState } from './headroom-routing'
import type { DbInstance } from './db'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'

const STATE_KEY = 'plugins.headroom.state'

type HeadroomManagerTestHarness = {
  runCommand: (
    command: string,
    args: string[],
    env: Record<string, string>,
    logs: string[],
  ) => Promise<{ code: number | null }>
  runCommandCapture: () => Promise<{ code: number; output: string }>
  readHeadroomVersion: () => string
  detectProviderRoutes: () => Record<'codex' | 'claude', boolean>
  ensureProxy: () => Promise<{ ok: boolean; issue?: { code: string } }>
  probeProxyHealthy: (port: number) => Promise<boolean>
  waitForProxyHealthy: (
    port: number,
    timeoutMs: number,
    isCurrent?: () => boolean,
  ) => Promise<boolean>
  refreshMetrics: () => Promise<void>
  refreshMetricsInBackground: () => void
  syncRouting: () => void
  proxy: ChildProcess | null
  proxyTrustedPort: number | null
}

function makeProxyChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  return child
}

function makeHeadroomExe(): { dir: string; exe: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-manager-'))
  const exe = path.join(dir, 'headroom')
  fs.writeFileSync(exe, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "headroom 0.30.0"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  echo '{"checks":[{"name":"codex","status":"pass"},{"name":"claude","status":"pass"}]}'
  exit 0
fi
if [ "$1" = "savings" ]; then
  echo '{"by_client":[]}'
  exit 0
fi
exit 0
`)
  fs.chmodSync(exe, 0o755)
  return { dir, exe }
}

describe('Windows Headroom ownership snapshots', () => {
  it('accepts a listener owned by a transitive child of the spawned trampoline', () => {
    const snapshot = parseWindowsOwnershipSnapshot(JSON.stringify({
      listeningPids: [5100],
      processes: [
        { ProcessId: 4242, ParentProcessId: 100 },
        { ProcessId: 5000, ParentProcessId: 4242 },
        { ProcessId: 5100, ParentProcessId: 5000 },
      ],
    }))

    expect(snapshot).not.toBeNull()
    expect(windowsSnapshotHasOwnedListener(snapshot!, 4242)).toBe(true)
  })

  it('rejects an unrelated listener and malformed or cyclic process data', () => {
    const unrelated = parseWindowsOwnershipSnapshot(JSON.stringify({
      listeningPids: 9000,
      processes: [
        { ProcessId: 4242, ParentProcessId: 100 },
        { ProcessId: 9000, ParentProcessId: 7777 },
      ],
    }))
    const cyclic = parseWindowsOwnershipSnapshot(JSON.stringify({
      listeningPids: [5000],
      processes: [
        { ProcessId: 5000, ParentProcessId: 5001 },
        { ProcessId: 5001, ParentProcessId: 5000 },
      ],
    }))

    expect(unrelated).not.toBeNull()
    expect(windowsSnapshotHasOwnedListener(unrelated!, 4242)).toBe(false)
    expect(cyclic).not.toBeNull()
    expect(windowsSnapshotHasOwnedListener(cyclic!, 4242)).toBe(false)
    expect(parseWindowsOwnershipSnapshot('not-json')).toBeNull()
  })
})

describe('HeadroomManager', () => {
  let db: DbInstance | null = null
  let tempDir: string | null = null
  let previousRegistryHome: string | undefined

  beforeEach(() => {
    previousRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db?.close()
    db = null
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
    if (previousRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = previousRegistryHome
  })

  it('installs Headroom with an isolated uv-managed Python runtime', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-tools-'))
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir)

    const plan = getHeadroomManagedInstallPlan()

    expect(plan.pythonVersion).toBe(HEADROOM_MANAGED_PYTHON_VERSION)
    expect(plan.pythonInstallArgs).toEqual([
      'python',
      'install',
      '3.12',
      '--managed-python',
    ])
    expect(plan.toolInstallArgs).toEqual([
      'tool',
      'install',
      '--python',
      '3.12',
      '--managed-python',
      '--force',
      'headroom-ai[all]',
    ])
    expect(plan.env).toMatchObject({
      UV_TOOL_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'tools'),
      UV_TOOL_BIN_DIR: path.join(tempDir, '.specrails', 'tools', 'bin'),
      UV_CACHE_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'cache'),
      UV_PYTHON: '3.12',
      UV_MANAGED_PYTHON: 'true',
      UV_PYTHON_DOWNLOADS: 'automatic',
      UV_PYTHON_INSTALL_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'python'),
      UV_PYTHON_CACHE_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'python-cache'),
      UV_PYTHON_BIN_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'python-bin'),
      UV_PYTHON_NO_REGISTRY: 'true',
      UV_PYTHON_INSTALL_REGISTRY: 'false',
      UV_NO_PROGRESS: '1',
    })
    expect(plan.env).not.toHaveProperty('UV_PYTHON_PREFERENCE')
  })

  it('prepares managed Python before installing the Headroom tool', async () => {
    db = initDesktopDb(':memory:')
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-install-'))
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir)

    const previousRuntimePath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    const runtimes = path.join(tempDir, 'runtimes')
    const uvExe = path.join(
      runtimes,
      'uv',
      process.platform === 'win32' ? 'uv.exe' : path.join('bin', 'uv'),
    )
    const managedBin = path.join(tempDir, '.specrails', 'tools', 'bin')
    const headroomExe = path.join(managedBin, process.platform === 'win32' ? 'headroom.exe' : 'headroom')
    fs.mkdirSync(path.dirname(uvExe), { recursive: true })
    fs.mkdirSync(managedBin, { recursive: true })
    fs.writeFileSync(uvExe, '')
    fs.writeFileSync(headroomExe, '')
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = runtimes

    try {
      const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = []
      const manager = new HeadroomManager(db, () => undefined, () => ['codex', 'claude'])
      const internals = manager as unknown as HeadroomManagerTestHarness
      internals.runCommand = async (command, args, env) => {
        calls.push({ command, args, env })
        return { code: 0 }
      }
      internals.runCommandCapture = async () => ({ code: 0, output: '{"by_client":[]}' })
      internals.readHeadroomVersion = () => '0.30.0'
      internals.detectProviderRoutes = () => ({ codex: false, claude: false })

      const result = await manager.install()

      expect(result.ok).toBe(true)
      expect(calls[0]).toMatchObject({
        command: uvExe,
        args: ['python', 'install', '3.12', '--managed-python'],
      })
      expect(calls[1]).toMatchObject({
        command: uvExe,
        args: ['tool', 'install', '--python', '3.12', '--managed-python', '--force', 'headroom-ai[all]'],
      })
      expect(calls[0].env).not.toHaveProperty('UV_PYTHON_PREFERENCE')
      expect(calls[1].env).toMatchObject({
        UV_PYTHON: '3.12',
        UV_PYTHON_INSTALL_DIR: path.join(tempDir, '.specrails', 'tools', 'uv', 'python'),
      })
      expect(calls[1].env).not.toHaveProperty('UV_PYTHON_PREFERENCE')
    } finally {
      if (previousRuntimePath === undefined) delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
      else process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = previousRuntimePath
    }
  })

  it('does not report an unauthenticated external endpoint as the managed proxy', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: true },
      detectedRoutes: { codex: true, claude: true },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      agent_usage: {
        agents: [{
          agent: 'codex',
          requests: 9001,
          tokens_saved: 2222222,
          input_tokens: 333333333,
          output_tokens: 4444444,
        }],
      },
    }), { status: 200 }))

    const manager = new HeadroomManager(db, () => undefined, () => ['codex', 'claude'])
    const state = await manager.getFreshState()

    expect(state.proxyRunning).toBe(false)
    expect(state.proxyPid).toBeNull()
    expect(state.metrics.proxyStatsAvailable).toBe(true)
    expect(state.metrics.providers.codex).toMatchObject({
      requests: 9001,
      inputTokens: 333333333,
      inputTokensSaved: 2222222,
      outputTokens: 4444444,
    })
  })

  it('fails closed instead of adopting a healthy process already on the port', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: true },
      detectedRoutes: { codex: true, claude: true },
      lastIssue: {
        code: 'proxy_port_busy',
        title: 'Headroom proxy port is already in use',
        guidance: 'Choose another port or stop the process using the current port, then retry activation.',
      },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      agent_usage: { agents: [] },
    }), { status: 200 }))

    const manager = new HeadroomManager(db, () => undefined, () => ['codex', 'claude'])
    await manager.startActiveProxyOnBoot()
    const diagnostics = manager.diagnostics()

    expect(diagnostics.state).toMatchObject({
      proxyRunning: false,
      proxyPid: null,
      activeProviders: { codex: false, claude: false },
      lastIssue: { code: 'proxy_port_busy' },
    })
    expect(diagnostics.proxyTail).toBe('')
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
  })

  it('opens persisted routing only after verification and closes it when the owned proxy exits', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))

    const child = makeProxyChild()
    const spawnProxy = vi.fn(() => child)
    let releaseHealth!: (healthy: boolean) => void
    const healthGate = new Promise<boolean>((resolve) => { releaseHealth = resolve })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort: () => true,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => healthGate

    // Persisted provider activation is a preference, not proof that a trusted
    // runtime exists. Constructor and candidate startup must remain fail-closed.
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
    const boot = manager.startActiveProxyOnBoot()
    await vi.waitFor(() => expect(spawnProxy).toHaveBeenCalledTimes(1))
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })

    releaseHealth(true)
    await boot
    expect(internals.proxyTrustedPort).toBe(8787)
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: true, claude: false })

    Object.assign(child, { exitCode: 1 })
    child.emit('close', 1, null)
    expect(internals.proxyTrustedPort).toBeNull()
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
    // The crash changes runtime trust only; the user's persisted preference is
    // retained for a future explicit retry or clean boot.
    expect(manager.getState().activeProviders).toEqual({ codex: true, claude: false })
  })

  it('closes routing when persisted port no longer matches the verified listener', () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = 8787
    internals.syncRouting()
    expect(getHeadroomRoutingState().activeProviders.codex).toBe(true)

    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 9999,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))
    internals.syncRouting()

    expect(getHeadroomRoutingState()).toEqual({
      port: 9999,
      activeProviders: { codex: false, claude: false },
    })
  })

  it('rejects an external livez responder that wins the bind race', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: false, claude: false },
      detectedRoutes: { codex: false, claude: false },
    }))

    const child = makeProxyChild()
    const spawnProxy = vi.fn(() => child)
    const ownsProxyPort = vi.fn(() => false)
    const killTree = vi.fn((_pid: number, signal: NodeJS.Signals, callback?: () => void) => {
      callback?.()
      Object.assign(child, { signalCode: signal })
      child.emit('close', null, signal)
    })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort,
      killTree: killTree as unknown as typeof import('./util/win-spawn').treeKillSafe,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.probeProxyHealthy = async () => false
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      service: 'headroom-proxy',
      status: 'healthy',
    }), { status: 200 }))

    const result = await internals.ensureProxy()

    expect(result.ok).toBe(false)
    expect(result.issue?.code).toBe('proxy_port_busy')
    expect(spawnProxy).toHaveBeenCalledTimes(1)
    expect(ownsProxyPort).toHaveBeenCalledWith(4242, 8787)
    expect(killTree).toHaveBeenCalledWith(4242, 'SIGTERM', expect.any(Function))
    expect(internals.proxy).toBeNull()
  })

  it('times out a local health endpoint that accepts but never responds', async () => {
    vi.useFakeTimers()
    try {
      db = initDesktopDb(':memory:')
      const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
      const internals = manager as unknown as HeadroomManagerTestHarness
      let requestSignal: AbortSignal | null = null
      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? null
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))

      const pending = internals.probeProxyHealthy(8787)
      await Promise.resolve()
      expect(requestSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(751)

      expect(await pending).toBe(false)
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish concurrent activation while the spawned proxy is still a candidate', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: false, claude: false },
      detectedRoutes: { codex: false, claude: false },
    }))

    const child = makeProxyChild()
    const spawnProxy = vi.fn(() => child)
    const ownsProxyPort = vi.fn(() => true)
    let releaseHealth!: (healthy: boolean) => void
    const healthGate = new Promise<boolean>((resolve) => { releaseHealth = resolve })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex', 'claude'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.waitForProxyHealthy = async () => healthGate
    internals.probeProxyHealthy = vi.fn(async () => false)

    const codex = manager.activate('codex')
    let codexSettled = false
    void codex.then(() => { codexSettled = true })
    await vi.waitFor(() => expect(spawnProxy).toHaveBeenCalledTimes(1))

    // The second activation arrives after spawn, while health/ownership are
    // still unverified. It must join the candidate start rather than treating
    // the mere existence of a child process as successful activation.
    const claude = manager.activate('claude')
    let claudeSettled = false
    void claude.then(() => { claudeSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(internals.probeProxyHealthy).toHaveBeenCalledTimes(1)
    expect(codexSettled).toBe(false)
    expect(claudeSettled).toBe(false)
    expect(manager.getState().activeProviders).toEqual({ codex: false, claude: false })
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })

    releaseHealth(true)
    const [codexResult, claudeResult] = await Promise.all([codex, claude])

    expect(codexResult.ok).toBe(true)
    expect(claudeResult.ok).toBe(true)
    expect(spawnProxy).toHaveBeenCalledTimes(1)
    expect(internals.proxy).toBe(child)
    expect(manager.getState().activeProviders).toEqual({ codex: true, claude: true })
  })

  it('does not resurrect a proxy when shutdown invalidates an in-flight start', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: false, claude: false },
      detectedRoutes: { codex: false, claude: false },
    }))

    const child = makeProxyChild()
    const spawnProxy = vi.fn(() => child)
    const killTree = vi.fn((_pid: number, signal: NodeJS.Signals, callback?: () => void) => {
      callback?.()
      Object.assign(child, { signalCode: signal })
      child.emit('close', null, signal)
    })
    let releaseHealth!: (healthy: boolean) => void
    const healthGate = new Promise<boolean>((resolve) => { releaseHealth = resolve })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort: () => true,
      killTree: killTree as unknown as typeof import('./util/win-spawn').treeKillSafe,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => healthGate

    const activation = manager.activate('codex')
    await vi.waitFor(() => expect(spawnProxy).toHaveBeenCalledTimes(1))
    const shutdown = manager.shutdown()
    releaseHealth(true)
    await shutdown

    // shutdown owns the DB lifetime boundary: once it resolves, no aborted
    // lifecycle continuation may wake up and touch the now-closed database.
    db.close()
    db = null

    const result = await activation
    expect(result.ok).toBe(false)
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(internals.proxy).toBeNull()
    expect(result.state.activeProviders).toEqual({ codex: false, claude: false })
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
    await expect(manager.deactivate('codex')).resolves.toMatchObject({ ok: false })
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })

  it('absorbs an asynchronous proxy spawn error instead of crashing the process', async () => {
    db = initDesktopDb(':memory:')
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stdout: null, stderr: null })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: (() => child) as typeof import('child_process').spawn,
    })
    const internals = manager as unknown as {
      ensureProxy: () => Promise<{ ok: boolean }>
      probeProxyHealthy: () => Promise<boolean>
      waitForProxyHealthy: () => Promise<boolean>
      getState: () => Record<string, unknown>
    }
    internals.getState = () => ({
      installed: true,
      executablePath: '/vanished/headroom',
      port: 8787,
      learning: { enabled: true },
    })
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => false

    const pending = internals.ensureProxy()
    await Promise.resolve()
    expect(child.listenerCount('error')).toBeGreaterThan(0)
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow()
    expect((await pending).ok).toBe(false)
  })

  it('shutdown tree-kills the owned proxy and escalates when close never arrives', async () => {
    vi.useFakeTimers()
    db = initDesktopDb(':memory:')
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdout: null, stderr: null })
    const kills: string[] = []
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      killTree: ((_pid, signal, callback) => {
        kills.push(String(signal))
        callback?.()
      }) as typeof import('./util/win-spawn').treeKillSafe,
    })
    ;(manager as unknown as { proxy: ChildProcess | null }).proxy = child

    const pending = manager.shutdown()
    expect(kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    await pending
    vi.useRealTimers()
  })

  it('serializes concurrent port changes so trust cannot move without the owned child', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))

    const children = new Map<number, ChildProcess>()
    const spawnedPorts: number[] = []
    const spawnProxy = vi.fn((_exe: string, args: readonly string[]) => {
      const port = Number(args.at(-1))
      const child = makeProxyChild(5000 + spawnedPorts.length)
      spawnedPorts.push(port)
      children.set(child.pid!, child)
      return child
    })
    const killTree = vi.fn((pid: number, signal: NodeJS.Signals, callback?: () => void) => {
      callback?.()
      const child = children.get(pid)
      if (!child) return
      Object.assign(child, { signalCode: signal })
      child.emit('close', null, signal)
    })
    const ownsProxyPort = vi.fn(() => true)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort,
      killTree: killTree as unknown as typeof import('./util/win-spawn').treeKillSafe,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => true

    const [first, second] = await Promise.all([
      manager.setPort(9001),
      manager.setPort(9002),
    ])

    expect(first).toMatchObject({ ok: true, state: { port: 9001 } })
    expect(second).toMatchObject({ ok: true, state: { port: 9002 } })
    expect(spawnedPorts).toEqual([9001, 9002])
    expect(internals.proxyTrustedPort).toBe(9002)
    expect(getHeadroomRoutingState()).toEqual({
      port: 9002,
      activeProviders: { codex: true, claude: false },
    })
  })

  it('applies a queued deactivation after an in-flight port transition', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))

    const original = makeProxyChild(6000)
    const candidate = makeProxyChild(6001)
    const children = new Map<number, ChildProcess>([
      [6000, original],
      [6001, candidate],
    ])
    const spawnProxy = vi.fn(() => candidate)
    const killTree = vi.fn((pid: number, signal: NodeJS.Signals, callback?: () => void) => {
      callback?.()
      const child = children.get(pid)
      if (!child) return
      Object.assign(child, { signalCode: signal })
      child.emit('close', null, signal)
    })
    let releaseHealth!: (healthy: boolean) => void
    const healthGate = new Promise<boolean>((resolve) => { releaseHealth = resolve })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort: () => true,
      killTree: killTree as unknown as typeof import('./util/win-spawn').treeKillSafe,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = original
    internals.proxyTrustedPort = 8787
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => healthGate

    const move = manager.setPort(9999)
    await vi.waitFor(() => expect(spawnProxy).toHaveBeenCalledTimes(1))
    const deactivate = manager.deactivate('codex')
    let deactivateSettled = false
    void deactivate.then(() => { deactivateSettled = true })
    await Promise.resolve()
    expect(deactivateSettled).toBe(false)

    releaseHealth(true)
    const [moveResult, deactivateResult] = await Promise.all([move, deactivate])

    expect(moveResult).toMatchObject({ ok: true, state: { port: 9999, activeProviders: { codex: true } } })
    expect(deactivateResult).toMatchObject({ ok: true, state: { port: 9999, activeProviders: { codex: false } } })
    expect(killTree).toHaveBeenCalledTimes(2)
    expect(internals.proxy).toBeNull()
    expect(internals.proxyTrustedPort).toBeNull()
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
  })

  it('rolls back port and routing when an active proxy cannot move', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'managed',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }))
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
    const busy = {
      code: 'proxy_port_busy' as const,
      title: 'busy',
      guidance: 'choose another port',
    }
    const restoredChild = makeProxyChild()
    const internals = manager as unknown as HeadroomManagerTestHarness
    const ensure = vi
      .spyOn(manager as unknown as { ensureProxy: () => Promise<unknown> }, 'ensureProxy')
      .mockResolvedValueOnce({ ok: false, state: manager.getState(), issue: busy })
      .mockImplementationOnce(async () => {
        internals.proxy = restoredChild
        internals.proxyTrustedPort = 8787
        return { ok: true, state: manager.getState() }
      })

    const result = await manager.setPort(9999)

    expect(result.ok).toBe(false)
    expect(result.issue?.code).toBe('proxy_port_busy')
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(result.state.port).toBe(8787)
    expect(result.state.activeProviders).toEqual({ codex: true, claude: false })
    expect(getHeadroomRoutingState()).toMatchObject({
      port: 8787,
      activeProviders: { codex: true, claude: false },
    })
  })
})
