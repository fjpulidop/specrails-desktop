/**
 * Puts a built app on a Tapflow device: upload the build to the relay (REST, the PAT Specrails created),
 * then one MCP session (`tapflow-mcp`, stdio) to pick a device, boot it if needed, install and launch.
 * The session is ALWAYS disconnected: Tapflow never releases a session left connected (spike, 2026-11-28).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pickDevice, type MobilePlatform, type TapflowDevice } from '../mobile-project'
import { createTapflowSecrets } from './relay'
import type { TapflowPaths } from './process'

export type DeliveryOutcome =
  | { outcome: 'launched'; device: { id: string; name: string; platform: MobilePlatform }; buildId: number; sessionId: string; watchUrl: string | null }
  | { outcome: 'unavailable'; detail: string }
  | { outcome: 'failed'; detail: string }

export interface DeliveryRequest {
  artifactPath: string
  platform: MobilePlatform
  /** The Tapflow device the person chose; otherwise (or when it is gone) the usual pick. */
  deviceId?: string
  log: (line: string) => void
  signal?: AbortSignal
}

/** The MCP calls delivery needs, so the flow is testable without Tapflow. */
export interface TapflowTools {
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean }>
  close(): Promise<void>
}

export interface DeliveryDeps {
  paths: TapflowPaths
  /** The relay port and the Node that runs Tapflow, from the plugin state; null when Tapflow is not ready. */
  target: () => { port: number; nodePath: string } | null
  answering: (port: number) => Promise<boolean>
  upload?: (port: number, token: string, file: string) => Promise<number>
  openTools?: (opts: { nodePath: string; mcpServer: string; port: number; token: string }) => Promise<TapflowTools>
  zipApp?: (appDir: string, zipFile: string) => Promise<void>
  /** Waiting out a busy Mac (tests shorten it). */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  admissionTimeoutMs?: number
}

/**
 * Tapflow's relay refuses a session while the Mac is busy rather than broken: CPU or memory over its limit
 * (80 %; right after a build the CPU almost always is), another boot in progress, every automation device in
 * use, or critical memory pressure. Its own runner waits those out (flow-runner `retryAdmission`: 5 s doubling
 * to 30 s), letting go of the session before each wait; so does Specrails.
 */
const ADMISSION_REFUSAL = /agent-resources-exhausted|agent resources exhausted|host-booting|host-at-capacity|host-memory-critical/i
const ADMISSION_TIMEOUT_MS = 4 * 60_000
const busyReason = (text: string) => /exhausted/i.test(text) ? 'your Mac is over Tapflow\'s CPU or memory limit (80 %), usual right after a build'
  : /booting/i.test(text) ? 'another device is booting'
  : /capacity/i.test(text) ? 'every automation device is in use'
  : 'memory pressure is critical'

const zipWithDitto = (appDir: string, zipFile: string) => new Promise<void>((resolve, reject) => {
  // `ditto -c -k --keepParent`: the zip layout Tapflow (and Xcode) expect for a simulator .app.
  execFile('ditto', ['-c', '-k', '--keepParent', appDir, zipFile], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()))
})

async function uploadBuild(port: number, token: string, file: string): Promise<number> {
  const form = new FormData()
  form.append('file', await fs.openAsBlob(file), path.basename(file))
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/builds`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(300_000) })
  const body = await res.json().catch(() => ({})) as { id?: unknown; error?: unknown }
  if (res.status !== 201 || typeof body.id !== 'number') throw new Error(`Tapflow refused the build (HTTP ${res.status}${typeof body.error === 'string' ? `: ${body.error}` : ''}).`)
  return body.id
}

async function openTapflowTools(opts: { nodePath: string; mcpServer: string; port: number; token: string }): Promise<TapflowTools> {
  // Loaded on first use, never at server start: a static import of the SDK client at module load changed
  // the bundle's init order and zod's `custom()` ran before its classes existed (the sidecar crashed).
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ])
  const client = new Client({ name: 'specrails', version: '1' })
  await client.connect(new StdioClientTransport({
    command: opts.nodePath, args: [opts.mcpServer], stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TAPFLOW_RELAY_URL: `ws://127.0.0.1:${opts.port}`, TAPFLOW_TOKEN: opts.token },
  }))
  return {
    call: async (name, args, timeoutMs = 300_000) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n')
      return { text, isError: result.isError === true }
    },
    close: () => client.close(),
  }
}

/** A device the person can choose for a run (Loops ▸ Test in Mobile Device). */
export interface ChoosableDevice { id: string; name: string; platform: MobilePlatform; booted: boolean }

/**
 * The devices Tapflow offers, while it is on: one `list_devices` call (it connects to nothing, so no
 * device is held). Null when Tapflow is off or does not answer: the run then lets Tapflow pick.
 */
export function createTapflowDeviceList(deps: Pick<DeliveryDeps, 'paths' | 'target' | 'answering' | 'openTools'>) {
  const openTools = deps.openTools ?? openTapflowTools
  return async function listDevices(): Promise<ChoosableDevice[] | null> {
    const target = deps.target()
    if (!target || !(await deps.answering(target.port))) return null
    const token = createTapflowSecrets(deps.paths.secretsDir).token()
    if (!token) return null
    const tools = await openTools({ nodePath: target.nodePath, mcpServer: path.join(deps.paths.toolsDir, 'node_modules', '@tapflowio', 'mcp-server', 'dist', 'index.js'), port: target.port, token })
    try {
      const listed = await tools.call('list_devices', {}, 30_000)
      if (listed.isError) return null
      const agents = JSON.parse(listed.text) as Array<{ devices?: TapflowDevice[] }>
      return agents.flatMap((agent) => agent.devices ?? [])
        .filter((device): device is TapflowDevice & { platform: MobilePlatform } => device.platform === 'ios' || device.platform === 'android')
        .map((device) => ({ id: device.id, name: device.name, platform: device.platform, booted: /booted/i.test(device.status) }))
    } catch {
      return null
    } finally {
      await tools.close().catch(() => undefined)
    }
  }
}

export function createTapflowDelivery(deps: DeliveryDeps) {
  const upload = deps.upload ?? uploadBuild
  const openTools = deps.openTools ?? openTapflowTools
  const zipApp = deps.zipApp ?? zipWithDitto
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.() }))
  const now = deps.now ?? Date.now

  return async function deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
    const { log, platform } = request
    const target = deps.target()
    if (!target) return { outcome: 'unavailable', detail: 'Tapflow is not installed by Specrails. Install it in Plugins ▸ Tapflow.' }
    if (!(await deps.answering(target.port))) return { outcome: 'unavailable', detail: 'Tapflow is off. Turn it on in Plugins ▸ Tapflow and run the test again (the build is kept).' }
    const token = createTapflowSecrets(deps.paths.secretsDir).token()
    if (!token) return { outcome: 'unavailable', detail: 'Tapflow has no Specrails token yet. Turn it off and on again in Plugins ▸ Tapflow.' }

    let file = request.artifactPath
    if (file.endsWith('.app')) {
      file = `${request.artifactPath}.zip`
      await fs.promises.rm(file, { force: true })
      await zipApp(request.artifactPath, file)
    }
    log(`Uploading ${path.basename(file)} to Tapflow…`)
    const buildId = await upload(target.port, token, file)

    const tools = await openTools({ nodePath: target.nodePath, mcpServer: path.join(deps.paths.toolsDir, 'node_modules', '@tapflowio', 'mcp-server', 'dist', 'index.js'), port: target.port, token })
    try {
      const listed = await tools.call('list_devices', {})
      if (listed.isError) return { outcome: 'failed', detail: `Tapflow could not list its devices: ${listed.text}` }
      const agents = JSON.parse(listed.text) as Array<{ devices?: TapflowDevice[] }>
      const device = pickDevice(agents.flatMap((agent) => agent.devices ?? []), platform, request.deviceId)
      if (!device) {
        return { outcome: 'unavailable', detail: platform === 'android' ? 'Tapflow has no Android emulator. Run its setup for Android in Plugins ▸ Tapflow.' : 'Tapflow has no iOS simulator. Install an iOS Simulator runtime in Xcode.' }
      }
      // Join (and boot) the device, waiting out a busy Mac; the session is let go before each wait.
      const deadline = now() + (deps.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS)
      const started = now()
      let delay = 5_000
      let watchUrl: string | null = null
      const waitOrFail = async (text: string): Promise<DeliveryOutcome | null> => {
        if (!ADMISSION_REFUSAL.test(text) || now() >= deadline) {
          return ADMISSION_REFUSAL.test(text)
            ? { outcome: 'failed', detail: `Tapflow kept refusing ${device.name} for ${Math.round((now() - started) / 1000)} s: ${busyReason(text)}. Close something heavy (another emulator, Xcode, Android Studio) and run it again.` }
            : null
        }
        const wait = Math.min(delay, Math.max(0, deadline - now()))
        log(`Tapflow is waiting: ${busyReason(text)}. Trying ${device.name} again in ${Math.round(wait / 1000)} s…`)
        await sleep(wait)
        delay = Math.min(delay * 2, 30_000)
        return null
      }
      for (;;) {
        const connected = await tools.call('connect_device', { sessionId: device.sessionId })
        if (connected.isError) {
          const verdict = await waitOrFail(connected.text)
          if (verdict) return verdict
          if (ADMISSION_REFUSAL.test(connected.text)) continue
          return { outcome: 'failed', detail: `${device.name} is busy in Tapflow: ${connected.text}` }
        }
        watchUrl = (() => { try { return (JSON.parse(connected.text) as { watchUrl?: string }).watchUrl ?? null } catch { return null } })()
        if (/booted/i.test(device.status)) break
        log(`Booting ${device.name}…`)
        const booted = await tools.call('boot_device', { sessionId: device.sessionId, deviceId: device.id })
        if (!booted.isError) { device.status = 'Booted'; break }
        await tools.call('disconnect_device', { sessionId: device.sessionId }, 30_000).catch(() => undefined)
        const verdict = await waitOrFail(booted.text)
        if (verdict) return verdict
        if (!ADMISSION_REFUSAL.test(booted.text)) return { outcome: 'failed', detail: `${device.name} did not boot: ${booted.text}` }
      }
      try {
        log(`Installing on ${device.name}…`)
        const installed = await tools.call('install_app', { sessionId: device.sessionId, buildId })
        if (installed.isError) return { outcome: 'failed', detail: `Tapflow could not install the build: ${installed.text}` }
        log('Launching the app…')
        let launched = await tools.call('launch_app', { sessionId: device.sessionId, buildId })
        // The first launch on a device can outlast Tapflow's 15 s while it builds its UI-tree runner once.
        if (launched.isError && /timed out/i.test(launched.text)) launched = await tools.call('launch_app', { sessionId: device.sessionId, buildId })
        if (launched.isError) return { outcome: 'failed', detail: `The app did not launch: ${launched.text}` }
        return { outcome: 'launched', device: { id: device.id, name: device.name, platform }, buildId, sessionId: device.sessionId, watchUrl }
      } finally {
        await tools.call('disconnect_device', { sessionId: device.sessionId }, 30_000).catch(() => undefined)
      }
    } finally {
      await tools.close().catch(() => undefined)
    }
  }
}
