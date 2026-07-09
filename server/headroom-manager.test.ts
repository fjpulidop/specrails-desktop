import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDesktopDb, setDesktopSetting } from './desktop-db'
import {
  HEADROOM_MANAGED_PYTHON_VERSION,
  HeadroomManager,
  getHeadroomManagedInstallPlan,
} from './headroom-manager'
import type { DbInstance } from './db'

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

  it('reports the proxy as running when an active route has a healthy external proxy on the configured port', async () => {
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

    expect(state.proxyRunning).toBe(true)
    expect(state.proxyPid).toBeNull()
    expect(state.metrics.proxyStatsAvailable).toBe(true)
    expect(state.metrics.providers.codex).toMatchObject({
      requests: 9001,
      inputTokens: 333333333,
      inputTokensSaved: 2222222,
      outputTokens: 4444444,
    })
  })

  it('adopts a healthy proxy on boot instead of starting a duplicate process on the same port', async () => {
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
      proxyRunning: true,
      proxyPid: null,
      lastIssue: null,
    })
    expect(diagnostics.proxyTail).toBe('')
  })
})
