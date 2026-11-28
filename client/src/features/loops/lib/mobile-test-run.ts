import { getApiBase } from '../../../lib/api'
import { isTauri } from '../../../lib/tauri-shell'
import { openDeviceWindow, type DeviceTarget } from '../../missions/lib/device-windows'
import { isLoopWindowRoute } from './loop-windows'

export type MobilePlatform = 'ios' | 'android'

/** `GET /mobile-test/options`: what Loops ▸ Test in Mobile Device ▸ Run on a device offers for a project. */
export interface MobileTestOptions {
  /** Tapflow is installed on a supported Mac. */
  ready: boolean
  /** Core runs host tasks (the loop needs them). */
  hostTasks: boolean
  checkout: { branch: string | null; platforms: MobilePlatform[]; recommended: MobilePlatform | 'both' }
  remembered: MobilePlatform | 'both' | null
  deliveries: Array<{ id: string; label: string; platforms: MobilePlatform[] }>
  branches: string[]
  /** Tapflow's devices while it is on; null when it is off (or does not answer). */
  devices: Array<{ id: string; name: string; platform: MobilePlatform; booted: boolean }> | null
}

export type MobileTestTarget = { kind: 'checkout' } | { kind: 'delivery'; deliveryId: string } | { kind: 'branch'; branch: string }

/** `GET /mobile-test/runs/:runId`. */
export interface MobileTestRunView {
  runId: string
  state: 'running' | 'launched' | 'failed'
  summary?: string
  detail?: string
  devices: Array<{ platform: MobilePlatform; name: string; id: string; sessionId: string; buildId: number }>
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: unknown; code?: unknown }
  if (!res.ok) {
    const error = new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`) as Error & { code?: string }
    if (typeof body.code === 'string') error.code = body.code
    throw error
  }
  return body
}

export async function fetchMobileTestOptions(projectId: string): Promise<MobileTestOptions> {
  return json<MobileTestOptions>(await fetch(`${getApiBase(projectId)}/mobile-test/options`))
}

export async function startMobileTestRun(projectId: string, request: { target: MobileTestTarget; platforms: MobilePlatform[]; devices: Partial<Record<MobilePlatform, string>> }): Promise<string> {
  const res = await fetch(`${getApiBase(projectId)}/mobile-test/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  return (await json<{ runId: string }>(res)).runId
}

export async function fetchMobileTestRun(projectId: string, runId: string): Promise<MobileTestRunView> {
  return json<MobileTestRunView>(await fetch(`${getApiBase(projectId)}/mobile-test/runs/${encodeURIComponent(runId)}`))
}

/**
 * Opens a device's window. From a loop editor window the main window opens it: the main window releases a
 * device when its window closes (`device-windows`), so it must be the one that knows it.
 */
export async function openRunDevice(target: DeviceTarget): Promise<void> {
  if (isTauri() && isLoopWindowRoute()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('loop_window_open_device', { target })
    return
  }
  await openDeviceWindow(target)
}
