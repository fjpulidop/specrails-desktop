// Device windows (tapflow): a Tapflow device, live, in its own native window. The server issues a
// single-use link that signs the window in to Tapflow; closing the window releases the device (the
// server shuts it down after a grace period, so its screen capture stops costing CPU).
import { API_ORIGIN } from '../../../lib/origin'
import { isTauri } from '../../../lib/tauri-shell'

export interface DeviceTarget {
  deviceId: string
  sessionId: string
  buildId: number
  platform: 'ios' | 'android'
  name: string
}

/** Open targets by device id, to release the right one when its window closes. */
const openTargets = new Map<string, DeviceTarget>()
let listening: Promise<void> | null = null

async function post(path: string, target: DeviceTarget): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_ORIGIN}/api/global-plugins/tapflow/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }) })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`)
  return body
}

export function releaseDevice(target: DeviceTarget): Promise<unknown> {
  return post('device-window/release', target).catch(() => undefined)
}

/** Listens once for the host's "a device window closed" event (desktop only). */
function listenForClosedWindows(): Promise<void> {
  listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<string>('device-window-closed', (event) => {
    const target = openTargets.get(event.payload)
    if (!target) return
    openTargets.delete(event.payload)
    void releaseDevice(target)
  })).then(() => undefined)
  return listening
}

export async function openDeviceWindow(target: DeviceTarget): Promise<void> {
  const { url, title } = await post('device-window', target) as { url: string; title: string }
  if (isTauri()) {
    await listenForClosedWindows()
    const { invoke } = await import('@tauri-apps/api/core')
    openTargets.set(target.deviceId, target)
    await invoke('device_window_open', { url, title, key: target.deviceId })
    return
  }
  const opened = window.open(url, `specrails-device-${target.deviceId}`, 'popup,width=1180,height=900,resizable=yes')
  if (!opened) throw new Error('The device window could not be opened. Allow pop-up windows and retry.')
}
