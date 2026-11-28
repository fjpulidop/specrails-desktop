import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTapflowDelivery, type TapflowTools } from '../adapters/delivery'
import { tapflowPaths } from '../adapters/process'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function setup(over: { devices?: unknown[]; failOn?: Record<string, string>; token?: boolean; answering?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-delivery-')); dirs.push(root)
  const paths = tapflowPaths(root)
  if (over.token !== false) { fs.mkdirSync(paths.secretsDir, { recursive: true }); fs.writeFileSync(path.join(paths.secretsDir, 'token.json'), JSON.stringify({ token: 'tflw_pat_x' })) }
  const calls: Array<[string, Record<string, unknown>]> = []
  const devices = over.devices ?? [{ id: 'U1', name: 'iPhone 17', platform: 'ios', status: 'shutdown', formFactor: 'phone', sessionId: 'S1' }]
  const tools: TapflowTools = {
    call: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args])
      if (over.failOn?.[name]) return { text: over.failOn[name]!, isError: true }
      if (name === 'list_devices') return { text: JSON.stringify([{ devices }]), isError: false }
      if (name === 'connect_device') return { text: JSON.stringify({ connected: true, watchUrl: 'http://127.0.0.1:4310/automation/sessions/S1' }), isError: false }
      return { text: '{}', isError: false }
    }),
    close: vi.fn(async () => {}),
  }
  const zipApp = vi.fn(async (_app: string, zip: string) => { fs.writeFileSync(zip, 'zip') })
  const upload = vi.fn(async () => 7)
  const deliver = createTapflowDelivery({ paths, target: () => ({ port: 4310, nodePath: '/n/node' }), answering: async () => over.answering !== false, upload, openTools: async () => tools, zipApp })
  const app = path.join(root, 'Shop.app'); fs.mkdirSync(app)
  return { deliver, calls, tools, upload, zipApp, app }
}

const log = () => {}

describe('tapflow delivery', () => {
  it('zips the .app, uploads it, boots a stock phone, installs, launches and disconnects', async () => {
    const h = setup()
    const result = await h.deliver({ artifactPath: h.app, platform: 'ios', log })
    expect(result).toEqual({ outcome: 'launched', device: { id: 'U1', name: 'iPhone 17', platform: 'ios' }, buildId: 7, sessionId: 'S1', watchUrl: 'http://127.0.0.1:4310/automation/sessions/S1' })
    expect(h.zipApp).toHaveBeenCalledWith(h.app, `${h.app}.zip`)
    expect(h.upload).toHaveBeenCalledWith(4310, 'tflw_pat_x', `${h.app}.zip`)
    expect(h.calls.map(([name]) => name)).toEqual(['list_devices', 'connect_device', 'boot_device', 'install_app', 'launch_app', 'disconnect_device'])
    expect(h.tools.close).toHaveBeenCalled()
  })

  it('skips the boot on a booted device and retries a first launch that timed out once', async () => {
    const h = setup({ devices: [{ id: 'U1', name: 'iPhone 17', platform: 'ios', status: 'booted', formFactor: 'phone', sessionId: 'S1' }] })
    let launches = 0
    ;(h.tools.call as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      h.calls.push([name, {}])
      if (name === 'list_devices') return { text: JSON.stringify([{ devices: [{ id: 'U1', name: 'iPhone 17', platform: 'ios', status: 'booted', formFactor: 'phone', sessionId: 'S1' }] }]), isError: false }
      if (name === 'launch_app' && launches++ === 0) return { text: 'launch_app failed: Request timed out', isError: true }
      return { text: '{}', isError: false }
    })
    expect((await h.deliver({ artifactPath: h.app, platform: 'ios', log })).outcome).toBe('launched')
    expect(h.calls.map(([name]) => name)).toEqual(['list_devices', 'connect_device', 'install_app', 'launch_app', 'launch_app', 'disconnect_device'])
  })

  it('always disconnects, also when the install fails', async () => {
    const h = setup({ failOn: { install_app: 'install_app failed: bad bundle' } })
    expect(await h.deliver({ artifactPath: h.app, platform: 'ios', log })).toEqual({ outcome: 'failed', detail: 'Tapflow could not install the build: install_app failed: bad bundle' })
    expect(h.calls.at(-1)?.[0]).toBe('disconnect_device')
  })

  it('says what to do when Tapflow is off, has no token or no device of the platform', async () => {
    expect(await setup({ answering: false }).deliver({ artifactPath: '/x.apk', platform: 'android', log })).toMatchObject({ outcome: 'unavailable', detail: expect.stringContaining('Turn it on') })
    expect(await setup({ token: false }).deliver({ artifactPath: '/x.apk', platform: 'android', log })).toMatchObject({ outcome: 'unavailable', detail: expect.stringContaining('token') })
    const noAndroid = setup()
    const apk = path.join(path.dirname(noAndroid.app), 'app-debug.apk'); fs.writeFileSync(apk, 'apk')
    expect(await noAndroid.deliver({ artifactPath: apk, platform: 'android', log })).toMatchObject({ outcome: 'unavailable', detail: expect.stringContaining('setup for Android') })
    expect(noAndroid.zipApp).not.toHaveBeenCalled()
  })
})

describe('server bundle safety', () => {
  it('never imports the MCP SDK client statically (it broke the sidecar bundle\'s init order at start)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'delivery.ts'), 'utf8')
    expect(source).not.toMatch(/^import [^\n]*@modelcontextprotocol\/sdk\/client/m)
    expect(source).toContain("import('@modelcontextprotocol/sdk/client/index.js')")
  })
})

describe('a busy Mac (Tapflow admission refusals)', () => {
  function busy(script: Record<string, string[]>, timeoutMs = 240_000) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-busy-')); dirs.push(root)
    const paths = tapflowPaths(root)
    fs.mkdirSync(paths.secretsDir, { recursive: true }); fs.writeFileSync(path.join(paths.secretsDir, 'token.json'), JSON.stringify({ token: 'tflw_pat_x' }))
    const calls: string[] = []
    const devices = [{ id: 'avd:tapflow-compact', name: 'tapflow-compact', platform: 'android', status: 'shutdown', formFactor: 'phone', sessionId: 'S1' }]
    const tools: TapflowTools = {
      call: vi.fn(async (name: string) => {
        calls.push(name)
        const refusal = script[name]?.shift()
        if (refusal) return { text: refusal, isError: true }
        if (name === 'list_devices') return { text: JSON.stringify([{ devices }]), isError: false }
        return { text: '{}', isError: false }
      }),
      close: vi.fn(async () => {}),
    }
    let clock = 0
    const waits: number[] = []
    const deliver = createTapflowDelivery({
      paths, target: () => ({ port: 4310, nodePath: '/n/node' }), answering: async () => true, upload: async () => 11, openTools: async () => tools,
      zipApp: async () => {}, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms }, admissionTimeoutMs: timeoutMs,
    })
    const apk = path.join(root, 'app-debug.apk'); fs.writeFileSync(apk, 'apk')
    return { deliver, calls, waits, apk }
  }

  it('[spec:mobile-device-testing/run-on-device] waits out a Mac over the limit after a build, letting the session go before each wait', async () => {
    const h = busy({
      connect_device: ['connect_device failed: Agent resources exhausted (agent-resources-exhausted)', 'connect_device failed: Agent resources exhausted (agent-resources-exhausted)'],
      boot_device: ['boot refused (host-booting)'],
    })
    const lines: string[] = []
    const result = await h.deliver({ artifactPath: h.apk, platform: 'android', log: (line) => lines.push(line) })
    expect(result).toMatchObject({ outcome: 'launched', device: { name: 'tapflow-compact' } })
    expect(h.waits).toEqual([5_000, 10_000, 20_000])
    expect(lines.filter((line) => line.startsWith('Tapflow is waiting'))[0]).toContain('CPU or memory limit')
    // The boot refusal let the session go before waiting, then joined again.
    expect(h.calls.join(' ')).toContain('boot_device disconnect_device connect_device boot_device install_app')
  })

  it('gives up with the reason and what to do once the wait runs out', async () => {
    const h = busy({ connect_device: Array(20).fill('connect_device failed: Agent resources exhausted (agent-resources-exhausted)') }, 60_000)
    const result = await h.deliver({ artifactPath: h.apk, platform: 'android', log: () => {} })
    expect(result).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/kept refusing tapflow-compact for 60 s: .*CPU or memory.*Close something heavy/) })
  })

  it('fails at once for a refusal that is not about load', async () => {
    const h = busy({ connect_device: ['Session busy (session-busy)'] })
    expect(await h.deliver({ artifactPath: h.apk, platform: 'android', log: () => {} })).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('is busy in Tapflow: Session busy') })
    expect(h.waits).toEqual([])
  })
})
