import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { getDesktopSetting, initDesktopDb, setDesktopSetting } from './desktop-db'
import {
  HEADROOM_ACTIVATION_SCHEMA_VERSION,
  HEADROOM_ACTIVATION_SOURCE,
  HEADROOM_MANAGED_PYTHON_VERSION,
  HEADROOM_RELAY_PATH,
  HeadroomManager,
  PROXY_START_TIMEOUT_MS,
  getHeadroomManagedInstallPlan,
  getProxyStartTimeoutMs,
  parseHeadroomDoctorRoutes,
  parseWindowsOwnershipSnapshot,
  windowsSnapshotHasOwnedListener,
} from './headroom-manager'
import { getHeadroomRoutingState } from './headroom-routing'
import type { DbInstance } from './db'
import { EventEmitter } from 'events'
import { Duplex, PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import { WebSocket, WebSocketServer } from 'ws'

const STATE_KEY = 'plugins.headroom.state'

function explicitActivation(activeProviders: Partial<Record<'codex' | 'claude', boolean>>) {
  const normalized = {
    codex: !!activeProviders.codex,
    claude: !!activeProviders.claude,
  }
  return {
    activeProviders: normalized,
    activation: {
      version: HEADROOM_ACTIVATION_SCHEMA_VERSION,
      source: HEADROOM_ACTIVATION_SOURCE,
      activeProviders: normalized,
    },
  }
}

type HeadroomManagerTestHarness = {
  runCommand: (
    command: string,
    args: string[],
    env: Record<string, string>,
    logs: string[],
  ) => Promise<{ code: number | null }>
  runCommandCapture: (
    command: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ) => Promise<{ code: number | null; output: string }>
  readHeadroomVersion: () => string
  detectProviderRoutes: () => Record<'codex' | 'claude', boolean>
  ensureProxy: () => Promise<{ ok: boolean; issue?: { code: string; detail?: string } }>
  probeProxyHealthy: (port: number) => Promise<boolean>
  fetchProxyHealth: (port: number, timeoutMs: number) => Promise<boolean>
  waitForProxyHealthy: (
    port: number,
    timeoutMs: number,
    isCurrent?: () => boolean,
  ) => Promise<boolean>
  refreshMetrics: () => Promise<void>
  readProxyStats: (port: number) => Promise<Record<string, unknown> | null>
  refreshMetricsInBackground: () => void
  syncRouting: () => void
  proxy: ChildProcess | null
  proxyTrustedPort: number | null
  lifecycleCommands: Map<ChildProcess, unknown>
  stopProxy: () => Promise<void>
  resolveUvPath: () => string | null
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

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('missing server address'))
      resolve(address.port)
    })
  })
}

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function relayAgentResources(agent: http.Agent): number {
  return [
    ...Object.values(agent.sockets),
    ...Object.values(agent.requests),
    ...Object.values(agent.freeSockets),
  ]
    .reduce((total, entries) => total + entries.length, 0)
}

function inertDuplex(writes: Buffer[] = []): Duplex {
  return new Duplex({
    allowHalfOpen: true,
    autoDestroy: false,
    read() { /* test controls the readable side explicitly */ },
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk))
      callback()
    },
  })
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

describe('Headroom doctor route parsing', () => {
  it('rejects contradictory or failed checks instead of inferring from prose', () => {
    expect(parseHeadroomDoctorRoutes(JSON.stringify({
      checks: [
        { name: 'codex', status: 'pass', summary: 'Codex is not routed through Headroom' },
        { name: 'claude', status: 'fail', summary: 'Claude is routed through Headroom' },
      ],
    }))).toEqual({ codex: false, claude: false })

    expect(parseHeadroomDoctorRoutes(JSON.stringify({
      checks: [{ name: 'codex', status: 'pass' }],
    }))).toEqual({ codex: true, claude: false })
    expect(parseHeadroomDoctorRoutes('not-json')).toEqual({ codex: false, claude: false })
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

  it.each([
    ['legacy state with no provenance', undefined],
    ['unknown activation version', {
      version: HEADROOM_ACTIVATION_SCHEMA_VERSION + 1,
      source: HEADROOM_ACTIVATION_SOURCE,
      activeProviders: { codex: true },
    }],
    ['unknown activation provenance', {
      version: HEADROOM_ACTIVATION_SCHEMA_VERSION,
      source: 'doctor-autodetect',
      activeProviders: { codex: true },
    }],
    ['non-boolean activation flag', {
      version: HEADROOM_ACTIVATION_SCHEMA_VERSION,
      source: HEADROOM_ACTIVATION_SOURCE,
      activeProviders: { codex: 'true' },
    }],
  ])('fails closed for %s even when doctor reports a route', async (_label, activation) => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'system',
      port: 8787,
      activeProviders: { codex: true, claude: false },
      ...(activation ? { activation } : {}),
    }))
    const spawnProxy = vi.fn(() => makeProxyChild())
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort: async () => true,
    })

    expect(manager.getState()).toMatchObject({
      detectedRoutes: { codex: true },
      activeProviders: { codex: false, claude: false },
    })
    await manager.startActiveProxyOnBoot()
    expect(spawnProxy).not.toHaveBeenCalled()
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
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

  it('does not report or consume metrics from an unauthenticated external endpoint', async () => {
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
      ...explicitActivation({ codex: true, claude: true }),
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
    expect(state.metrics.proxyStatsAvailable).toBe(false)
    expect(state.metrics.providers.codex).toMatchObject({
      requests: 0,
      inputTokens: 0,
      inputTokensSaved: 0,
      outputTokens: 0,
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
      ...explicitActivation({ codex: true, claude: true }),
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
      ...explicitActivation({ codex: true, claude: false }),
      detectedRoutes: { codex: true, claude: false },
    }))

    const child = makeProxyChild()
    const spawnProxy = vi.fn(() => child)
    let releaseHealth!: (healthy: boolean) => void
    const healthGate = new Promise<boolean>((resolve) => { releaseHealth = resolve })
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
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
    expect(getHeadroomRoutingState()).toMatchObject({
      port: 4200,
      relayBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4200\/_specrails\/headroom\/[A-Za-z0-9_-]{40,}$/),
      activeProviders: { codex: true, claude: false },
    })

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
      ...explicitActivation({ codex: true, claude: false }),
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
      ...explicitActivation({ codex: true, claude: false }),
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

  it('awaits asynchronous PID ownership without blocking the event loop or opening routing early', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'system',
      port: 8787,
      activeProviders: { codex: false, claude: false },
    }))

    const child = makeProxyChild()
    let releaseOwnership!: (owned: boolean) => void
    const ownership = new Promise<boolean>((resolve) => { releaseOwnership = resolve })
    const ownsProxyPort = vi.fn(() => ownership)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: (() => child) as typeof import('child_process').spawn,
      ownsProxyPort,
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.refreshMetricsInBackground = () => undefined
    internals.refreshMetrics = async () => undefined
    internals.probeProxyHealthy = async () => false
    internals.waitForProxyHealthy = async () => true

    const activation = manager.activate('codex')
    let settled = false
    void activation.then(() => { settled = true })
    await vi.waitFor(() => expect(ownsProxyPort).toHaveBeenCalledWith(4242, 8787))
    let immediateRan = false
    await new Promise<void>((resolve) => setImmediate(() => {
      immediateRan = true
      resolve()
    }))

    expect(immediateRan).toBe(true)
    expect(settled).toBe(false)
    expect(getHeadroomRoutingState().activeProviders.codex).toBe(false)

    releaseOwnership(true)
    await expect(activation).resolves.toMatchObject({
      ok: true,
      state: { activeProviders: { codex: true } },
    })
  })

  it('sends zero credential-bearing bytes when the connected relay backend is not owned', async () => {
    db = initDesktopDb(':memory:')
    let received = Buffer.alloc(0)
    const backend = net.createServer((socket) => {
      socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]) })
    })
    const backendPort = await listen(backend)
    const child = makeProxyChild()
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: async () => false,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = child
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer((req, res) => {
      void manager.handleRelayRequest(req, res)
    })
    const relayPort = await listen(relay)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const diagnosticBase = (manager as unknown as { relayDiagnosticBaseUrl: () => string }).relayDiagnosticBaseUrl()
    expect(diagnosticBase).toContain('<redacted>')
    expect(getHeadroomRoutingState().relayBaseUrl).not.toBe(diagnosticBase)

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: relayPort,
          method: 'POST',
          path: `${relayPath}/v1/responses`,
          headers: {
            authorization: 'Bearer provider-secret',
            'content-type': 'application/json',
          },
        }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        request.once('error', reject)
        request.end('{"secretPrompt":"do not leak"}')
      })

      expect(response.status).toBe(503)
      expect(response.body).toContain('request failed')
      expect(received).toHaveLength(0)
    } finally {
      await closeServer(relay)
      await closeServer(backend)
    }
  })

  it('rejects a relay request without the runtime token before opening the backend', async () => {
    db = initDesktopDb(':memory:')
    let backendConnections = 0
    let received = Buffer.alloc(0)
    const backend = net.createServer((socket) => {
      backendConnections += 1
      socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]) })
    })
    const backendPort = await listen(backend)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer((req, res) => {
      void manager.handleRelayRequest(req, res)
    })
    const relayPort = await listen(relay)

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: relayPort,
          method: 'POST',
          path: `${HEADROOM_RELAY_PATH}/wrong-token/v1/responses`,
          headers: { authorization: 'Bearer provider-secret' },
        }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        request.once('error', reject)
        request.end('{"secretPrompt":"do not leak"}')
      })

      expect(status).toBe(404)
      expect(backendConnections).toBe(0)
      expect(received).toHaveLength(0)
    } finally {
      await closeServer(relay)
      await closeServer(backend)
    }
  })

  it('streams through an owned backend while stripping hop-by-hop headers', async () => {
    db = initDesktopDb(':memory:')
    let observed: { authorization?: string; hop?: string; body?: string } = {}
    const backend = http.createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        observed = {
          authorization: req.headers.authorization,
          hop: req.headers['x-remove-me'] as string | undefined,
          body,
        }
        res.setHeader('connection', 'x-backend-hop')
        res.setHeader('x-backend-hop', 'must-not-escape')
        res.end('proxied')
      })
    })
    const backendPort = await listen(backend)
    const child = makeProxyChild()
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = child
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer((req, res) => {
      void manager.handleRelayRequest(req, res)
    })
    const relayPort = await listen(relay)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname

    try {
      const response = await new Promise<{ status: number; body: string; hop?: string }>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: relayPort,
          method: 'POST',
          path: `${relayPath}/v1/messages?stream=true`,
          headers: {
            authorization: 'Bearer provider-secret',
            connection: 'x-remove-me',
            'x-remove-me': 'must-not-forward',
          },
        }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body,
            hop: res.headers['x-backend-hop'] as string | undefined,
          }))
        })
        request.once('error', reject)
        request.end('streamed prompt')
      })

      expect(response).toEqual({ status: 200, body: 'proxied', hop: undefined })
      expect(observed).toEqual({
        authorization: 'Bearer provider-secret',
        hop: undefined,
        body: 'streamed prompt',
      })
    } finally {
      await closeServer(relay)
      await closeServer(backend)
    }
  })

  it('releases the backend stream and agent slot when the relay client aborts', async () => {
    db = initDesktopDb(':memory:')
    let backendSocket: net.Socket | null = null
    let backendClosed = false
    const backend = http.createServer((_req, res) => {
      backendSocket = res.socket
      res.socket?.once('close', () => { backendClosed = true })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      // Deliberately keep the response open: the relay must tear this side down
      // when its client stops consuming the stream.
    })
    const backendPort = await listen(backend)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer((req, res) => {
      void manager.handleRelayRequest(req, res)
    })
    const relayPort = await listen(relay)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const relayAgent = (manager as unknown as { relayAgent: http.Agent }).relayAgent
    let clientRequest: http.ClientRequest | null = null

    try {
      await new Promise<void>((resolve, reject) => {
        clientRequest = http.get({
          host: '127.0.0.1',
          port: relayPort,
          path: `${relayPath}/v1/messages?stream=true`,
        }, (response) => {
          response.once('data', () => {
            response.destroy()
            resolve()
          })
          response.once('error', () => { /* expected after the local abort */ })
        })
        clientRequest.once('error', reject)
      })

      await vi.waitFor(() => {
        expect(backendClosed).toBe(true)
        expect(relayAgentResources(relayAgent)).toBe(0)
      })
    } finally {
      clientRequest?.destroy()
      relayAgent.destroy()
      backendSocket?.destroy()
      await closeServer(relay)
      await closeServer(backend)
    }
  })

  it('terminates the client response and releases its agent slot when the backend aborts', async () => {
    db = initDesktopDb(':memory:')
    let backendSocket: net.Socket | null = null
    const backend = http.createServer((_req, res) => {
      backendSocket = res.socket
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: partial\n\n')
      setImmediate(() => res.socket?.destroy())
    })
    const backendPort = await listen(backend)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer((req, res) => {
      void manager.handleRelayRequest(req, res)
    })
    const relayPort = await listen(relay)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const relayAgent = (manager as unknown as { relayAgent: http.Agent }).relayAgent
    let clientRequest: http.ClientRequest | null = null

    try {
      const outcome = await new Promise<'premature' | 'clean'>((resolve) => {
        clientRequest = http.get({
          host: '127.0.0.1',
          port: relayPort,
          path: `${relayPath}/v1/messages?stream=true`,
        }, (response) => {
          response.once('aborted', () => resolve('premature'))
          response.once('error', () => resolve('premature'))
          response.once('end', () => resolve('clean'))
          response.resume()
        })
        clientRequest.once('error', () => resolve('premature'))
      })

      expect(outcome).toBe('premature')
      await vi.waitFor(() => expect(relayAgentResources(relayAgent)).toBe(0))
    } finally {
      clientRequest?.destroy()
      relayAgent.destroy()
      backendSocket?.destroy()
      await closeServer(relay)
      await closeServer(backend)
    }
  })

  it('relays an owned WebSocket upgrade without exposing it before verification', async () => {
    db = initDesktopDb(':memory:')
    const backendHttp = http.createServer()
    const backendWs = new WebSocketServer({ server: backendHttp })
    let observedPath = ''
    let observedAuthorization = ''
    backendWs.on('connection', (socket, request) => {
      observedPath = request.url ?? ''
      observedAuthorization = request.headers.authorization ?? ''
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
    })
    const backendPort = await listen(backendHttp)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      ownsProxyPort: () => true,
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = backendPort
    const relay = http.createServer()
    relay.on('upgrade', (request, socket, head) => {
      void manager.handleRelayUpgrade(request, socket, head)
    })
    const relayPort = await listen(relay)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const client = new WebSocket(`ws://127.0.0.1:${relayPort}${relayPath}/v1/responses?stream=1`, {
      headers: { authorization: 'Bearer provider-secret' },
    })

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
      const reply = await new Promise<string>((resolve, reject) => {
        client.once('message', (data) => resolve(data.toString()))
        client.once('error', reject)
        client.send('hello')
      })

      expect(reply).toBe('echo:hello')
      expect(observedPath).toBe('/v1/responses?stream=1')
      expect(observedAuthorization).toBe('Bearer provider-secret')
    } finally {
      client.terminate()
      await new Promise<void>((resolve) => backendWs.close(() => resolve()))
      await closeServer(relay)
      await closeServer(backendHttp)
    }
  })

  it('tears down the backend when an upgraded client closes without a clean end', async () => {
    db = initDesktopDb(':memory:')
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const backend = inertDuplex()
    const client = inertDuplex()
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const request = {
      url: `${relayPath}/v1/responses`,
      method: 'GET',
      httpVersion: '1.1',
      rawHeaders: ['Host', '127.0.0.1', 'Connection', 'Upgrade', 'Upgrade', 'websocket'],
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    } as unknown as http.IncomingMessage
    const internals = manager as unknown as {
      connectVerifiedBackend: () => Promise<{ socket: net.Socket; port: number }>
      relayAgent: http.Agent
    }
    internals.connectVerifiedBackend = async () => ({
      socket: backend as unknown as net.Socket,
      port: 8787,
    })

    try {
      await manager.handleRelayUpgrade(request, client, Buffer.alloc(0))
      client.destroy()

      await vi.waitFor(() => expect(backend.destroyed).toBe(true))
    } finally {
      client.destroy()
      backend.destroy()
      internals.relayAgent.destroy()
    }
  })

  it('preserves the final upgrade bytes after a clean backend half-close', async () => {
    db = initDesktopDb(':memory:')
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const backend = inertDuplex()
    const clientWrites: Buffer[] = []
    const client = inertDuplex(clientWrites)
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const request = {
      url: `${relayPath}/v1/responses`,
      method: 'GET',
      httpVersion: '1.1',
      rawHeaders: ['Host', '127.0.0.1', 'Connection', 'Upgrade', 'Upgrade', 'websocket'],
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    } as unknown as http.IncomingMessage
    const internals = manager as unknown as {
      connectVerifiedBackend: () => Promise<{ socket: net.Socket; port: number }>
      relayAgent: http.Agent
    }
    internals.connectVerifiedBackend = async () => ({
      socket: backend as unknown as net.Socket,
      port: 8787,
    })

    try {
      await manager.handleRelayUpgrade(request, client, Buffer.alloc(0))
      const backendEnded = new Promise<void>((resolve) => backend.once('end', resolve))
      backend.push(Buffer.from('final-frame'))
      backend.push(null)
      await backendEnded
      backend.destroy()

      await vi.waitFor(() => expect(client.writableEnded).toBe(true))
      expect(Buffer.concat(clientWrites).toString()).toContain('final-frame')
      expect(client.destroyed).toBe(false)
    } finally {
      client.destroy()
      backend.destroy()
      internals.relayAgent.destroy()
    }
  })

  it('tears down the upgraded client when the backend closes without a clean end', async () => {
    db = initDesktopDb(':memory:')
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      relayOrigin: 'http://127.0.0.1:4200',
    })
    const backend = inertDuplex()
    const client = inertDuplex()
    const relayPath = new URL(getHeadroomRoutingState().relayBaseUrl!).pathname
    const request = {
      url: `${relayPath}/v1/responses`,
      method: 'GET',
      httpVersion: '1.1',
      rawHeaders: ['Host', '127.0.0.1', 'Connection', 'Upgrade', 'Upgrade', 'websocket'],
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    } as unknown as http.IncomingMessage
    const internals = manager as unknown as {
      connectVerifiedBackend: () => Promise<{ socket: net.Socket; port: number }>
      relayAgent: http.Agent
    }
    internals.connectVerifiedBackend = async () => ({
      socket: backend as unknown as net.Socket,
      port: 8787,
    })

    try {
      await manager.handleRelayUpgrade(request, client, Buffer.alloc(0))
      backend.destroy()

      await vi.waitFor(() => expect(client.destroyed).toBe(true))
    } finally {
      client.destroy()
      backend.destroy()
      internals.relayAgent.destroy()
    }
  })

  it('reads runtime stats only through a post-connect ownership-verified socket', async () => {
    db = initDesktopDb(':memory:')
    let observedPath = ''
    const backend = http.createServer((req, res) => {
      observedPath = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      res.end('{"agent_usage":{"agents":[]}}')
    })
    const backendPort = await listen(backend)
    const ownsProxyPort = vi.fn(() => true)
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], { ownsProxyPort })
    const internals = manager as unknown as HeadroomManagerTestHarness
    internals.proxy = makeProxyChild()
    internals.proxyTrustedPort = backendPort

    try {
      const stats = await internals.readProxyStats(backendPort)
      expect(stats).toEqual({ agent_usage: { agents: [] } })
      expect(observedPath).toBe('/stats?cached=1')
      expect(ownsProxyPort).toHaveBeenCalledWith(4242, backendPort)
    } finally {
      ;(manager as unknown as { relayAgent: http.Agent }).relayAgent.destroy()
      await closeServer(backend)
    }
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
    const persisted = JSON.parse(getDesktopSetting(db, STATE_KEY)!) as Record<string, unknown>
    expect(persisted.activation).toEqual({
      version: HEADROOM_ACTIVATION_SCHEMA_VERSION,
      source: HEADROOM_ACTIVATION_SOURCE,
      activeProviders: { codex: true, claude: true },
    })
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

  it('closes lifecycle admission synchronously before the proxy shutdown phase', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'system',
      port: 8787,
      ...explicitActivation({ codex: false, claude: false }),
    }))
    const spawnProxy = vi.fn(() => makeProxyChild())
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'], {
      spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
    })

    manager.beginShutdown()
    const activation = await manager.activate('codex')

    expect(activation.ok).toBe(false)
    expect(spawnProxy).not.toHaveBeenCalled()
    expect(getHeadroomRoutingState().activeProviders).toEqual({ codex: false, claude: false })
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

  it('does not start a background metrics command while shutdown is taking its state snapshot', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
    process.env.SPECRAILS_REGISTRY_HOME = tempDir
    setDesktopSetting(db, STATE_KEY, JSON.stringify({
      installed: true,
      version: '0.30.0',
      executablePath: fake.exe,
      installSource: 'system',
      port: 8787,
      activeProviders: { codex: false, claude: false },
    }))
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
    const internals = manager as unknown as HeadroomManagerTestHarness
    const capture = vi.fn(async () => ({ code: 0, output: '{"by_client":[]}' }))
    internals.runCommandCapture = capture

    await manager.shutdown()

    expect(capture).not.toHaveBeenCalled()
  })

  it('cancels, tree-terminates, and observes close for runCommandCapture during shutdown', async () => {
    db = initDesktopDb(':memory:')
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
    const internals = manager as unknown as HeadroomManagerTestHarness
    const capture = internals.runCommandCapture(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
      30_000,
    )
    await vi.waitFor(() => expect(internals.lifecycleCommands.size).toBe(1))

    const shutdown = manager.shutdown()
    const result = await capture
    await shutdown

    expect(result.code).toBeNull()
    await vi.waitFor(() => expect(internals.lifecycleCommands.size).toBe(0))
  })

  it('does not spawn uv after shutdown starts while uninstall is awaiting proxy stop', async () => {
    db = initDesktopDb(':memory:')
    const manager = new HeadroomManager(db, () => undefined, () => ['codex'])
    const internals = manager as unknown as HeadroomManagerTestHarness
    vi.spyOn(manager, 'getState').mockReturnValue({
      installed: true,
      installSource: 'managed',
      version: '0.30.0',
      executablePath: '/managed/headroom',
      uvPath: process.execPath,
      port: 8787,
      phase: 'installed',
      activeProviders: { codex: false, claude: false },
      availableProviders: { codex: true, claude: false },
      detectedRoutes: { codex: false, claude: false },
      proxyRunning: false,
      proxyPid: null,
      learning: { enabled: false, baselineReady: false, baselineSamples: 0, updatedAt: null, lastIssue: null },
      metrics: {
        updatedAt: null,
        proxyStatsAvailable: false,
        durableSavingsAvailable: false,
        outputSavingsAvailable: false,
        outputSavingsMethod: null,
        outputConfidence: null,
        providers: {
          codex: { provider: 'codex', label: 'Codex', active: false, available: true, detectedRoute: false, requests: 0, inputTokens: 0, inputTokensSaved: 0, outputTokens: 0, outputTokensSaved: 0, outputSavingsPercent: 0, outputSavingsMethod: 'none', outputSavingsAllocated: false },
          claude: { provider: 'claude', label: 'Claude', active: false, available: false, detectedRoute: false, requests: 0, inputTokens: 0, inputTokensSaved: 0, outputTokens: 0, outputTokensSaved: 0, outputSavingsPercent: 0, outputSavingsMethod: 'none', outputSavingsAllocated: false },
        },
        lastIssue: null,
      },
      lastIssue: null,
      updatedAt: null,
    })
    internals.resolveUvPath = () => process.execPath
    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    internals.stopProxy = vi.fn()
      .mockImplementationOnce(() => stopGate)
      .mockResolvedValue(undefined)
    const run = vi.fn(async () => ({ code: 0 as number | null }))
    internals.runCommand = run

    const uninstall = manager.uninstall()
    await vi.waitFor(() => expect(internals.stopProxy).toHaveBeenCalledTimes(1))
    const shutdown = manager.shutdown()
    releaseStop()
    const result = await uninstall
    await shutdown

    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
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
      ...explicitActivation({ codex: true, claude: false }),
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
      ...explicitActivation({ codex: true, claude: false }),
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
      ...explicitActivation({ codex: true, claude: false }),
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

  // ── Proxy startup budget (cold start) ──────────────────────────────────────
  //
  // Measured on an M-series Mac: a cold start of the uv-managed Python proxy
  // prints its banner ~4 s in and answers /livez after ~7.5 s; warm ~3.7 s.
  // The old 6 s budget killed every first activation after install.
  describe('proxy startup budget', () => {
    const ENV = 'SPECRAILS_HEADROOM_START_TIMEOUT_MS'
    let previousBudget: string | undefined

    beforeEach(() => { previousBudget = process.env[ENV] })
    afterEach(() => {
      if (previousBudget === undefined) delete process.env[ENV]
      else process.env[ENV] = previousBudget
      vi.useRealTimers()
    })

    function seedInstalledState(exe: string) {
      setDesktopSetting(db!, STATE_KEY, JSON.stringify({
        installed: true,
        version: '0.30.0',
        executablePath: exe,
        installSource: 'managed',
        port: 8787,
        ...explicitActivation({ codex: true, claude: false }),
        detectedRoutes: { codex: true, claude: false },
      }))
    }

    /** A manager whose only unstubbed startup step is the /livez polling loop. */
    function harness(child: ChildProcess, fetchProxyHealth: () => Promise<boolean>) {
      const spawnProxy = vi.fn(() => child)
      const killTree = vi.fn((_pid: number, signal: NodeJS.Signals, callback?: () => void) => {
        callback?.()
        if (child.exitCode == null && child.signalCode == null) {
          Object.assign(child, { signalCode: signal })
          child.emit('close', null, signal)
        }
      })
      const manager = new HeadroomManager(db!, () => undefined, () => ['codex'], {
        spawnProxy: spawnProxy as unknown as typeof import('child_process').spawn,
        ownsProxyPort: () => true,
        killTree: killTree as unknown as typeof import('./util/win-spawn').treeKillSafe,
        relayOrigin: 'http://127.0.0.1:4200',
      })
      const internals = manager as unknown as HeadroomManagerTestHarness
      internals.refreshMetricsInBackground = () => undefined
      internals.refreshMetrics = async () => undefined
      internals.probeProxyHealthy = async () => false
      internals.fetchProxyHealth = fetchProxyHealth
      return { manager, internals, spawnProxy }
    }

    it('reads the budget from the env override and falls back to 30 s on junk', () => {
      delete process.env[ENV]
      expect(getProxyStartTimeoutMs()).toBe(PROXY_START_TIMEOUT_MS)
      expect(PROXY_START_TIMEOUT_MS).toBe(30_000)
      expect(getProxyStartTimeoutMs({ [ENV]: '10000' })).toBe(10_000)
      for (const junk of ['0', '-5', 'abc', '1.5', ' ']) {
        expect(getProxyStartTimeoutMs({ [ENV]: junk })).toBe(PROXY_START_TIMEOUT_MS)
      }
    })

    it('keeps waiting past the old 6 s for a cold-start proxy and spawns it unbuffered', async () => {
      vi.useFakeTimers()
      db = initDesktopDb(':memory:')
      const fake = makeHeadroomExe()
      tempDir = fake.dir
      process.env.SPECRAILS_REGISTRY_HOME = tempDir
      seedInstalledState(fake.exe)
      const child = makeProxyChild()
      const startedAt = Date.now()
      // /livez only answers 8 s in — a cold Python start, past the old budget.
      const { manager, internals, spawnProxy } = harness(child, async () => Date.now() - startedAt >= 8_000)

      let settled: { ok: boolean } | null = null
      const pending = internals.ensureProxy().then((r) => { settled = r; return r })
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnProxy).toHaveBeenCalledTimes(1)
      const spawnEnv = (spawnProxy.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env
      expect(spawnEnv.PYTHONUNBUFFERED).toBe('1')

      await vi.advanceTimersByTimeAsync(6_500)
      expect(settled).toBeNull()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(await pending).toMatchObject({ ok: true })
      expect(internals.proxyTrustedPort).toBe(8787)
      expect(manager.getState().lastIssue).toBeNull()
    })

    it('fails at once when the proxy exits during startup and surfaces its own output', async () => {
      vi.useFakeTimers()
      db = initDesktopDb(':memory:')
      const fake = makeHeadroomExe()
      tempDir = fake.dir
      process.env.SPECRAILS_REGISTRY_HOME = tempDir
      seedInstalledState(fake.exe)
      const child = makeProxyChild()
      const { manager, internals, spawnProxy } = harness(child, async () => false)

      let settled: { ok: boolean } | null = null
      const pending = internals.ensureProxy().then((r) => { settled = r; return r })
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnProxy).toHaveBeenCalledTimes(1)

      child.stderr!.emit('data', Buffer.from('Traceback (most recent call last):\nModuleNotFoundError: No module named uvicorn\n'))
      Object.assign(child, { exitCode: 1 })
      child.emit('exit', 1, null)
      child.emit('close', 1, null)

      // Well inside the 30 s budget: a dead child must not keep the user waiting.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).not.toBeNull()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.issue).toMatchObject({ code: 'proxy_unhealthy' })
      expect(result.issue?.detail).toContain('ModuleNotFoundError')
      expect(manager.getState().lastIssue?.detail).toContain('ModuleNotFoundError')
      expect(internals.proxyTrustedPort).toBeNull()
    })

    it('names the exhausted budget when a silent proxy never answers', async () => {
      vi.useFakeTimers()
      process.env[ENV] = '2000'
      db = initDesktopDb(':memory:')
      const fake = makeHeadroomExe()
      tempDir = fake.dir
      process.env.SPECRAILS_REGISTRY_HOME = tempDir
      seedInstalledState(fake.exe)
      const child = makeProxyChild()
      const { internals } = harness(child, async () => false)

      const pending = internals.ensureProxy()
      await vi.advanceTimersByTimeAsync(2_600)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.issue).toMatchObject({ code: 'proxy_unhealthy' })
      expect(result.issue?.detail).toMatch(/did not answer \/livez within 2 s/)
    })

    it('reports the exit code when the proxy dies without printing anything', async () => {
      vi.useFakeTimers()
      db = initDesktopDb(':memory:')
      const fake = makeHeadroomExe()
      tempDir = fake.dir
      process.env.SPECRAILS_REGISTRY_HOME = tempDir
      seedInstalledState(fake.exe)
      const child = makeProxyChild()
      const { internals } = harness(child, async () => false)

      const pending = internals.ensureProxy()
      await vi.advanceTimersByTimeAsync(0)
      Object.assign(child, { exitCode: 137 })
      child.emit('exit', 137, null)
      child.emit('close', 137, null)
      await vi.advanceTimersByTimeAsync(500)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.issue?.detail).toMatch(/exited during startup \(exit code 137\)/)
    })
  })
})
