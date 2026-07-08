import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDesktopDb, setDesktopSetting } from './desktop-db'
import { HeadroomManager } from './headroom-manager'
import type { DbInstance } from './db'

const STATE_KEY = 'plugins.headroom.state'

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

  afterEach(() => {
    vi.restoreAllMocks()
    db?.close()
    db = null
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  })

  it('reports the proxy as running when an active route has a healthy external proxy on the configured port', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
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
      agent_usage: { agents: [] },
    }), { status: 200 }))

    const manager = new HeadroomManager(db, () => undefined, () => ['codex', 'claude'])
    const state = await manager.getFreshState()

    expect(state.proxyRunning).toBe(true)
    expect(state.proxyPid).toBeNull()
    expect(state.metrics.proxyStatsAvailable).toBe(true)
  })

  it('adopts a healthy proxy on boot instead of starting a duplicate process on the same port', async () => {
    db = initDesktopDb(':memory:')
    const fake = makeHeadroomExe()
    tempDir = fake.dir
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
