import { invoke } from '@tauri-apps/api/core'
import { Update } from '@tauri-apps/plugin-updater'
import { API_ORIGIN } from './origin'

/**
 * Release channel for Desktop and Core updates (App settings ▸ Updates).
 * `latest` = newest release; `stable` = a release promoted after soaking on
 * latest (see docs/ci-cd.md#update-channels). Persisted server-side in
 * `/api/settings` so the Core update check honours the same choice.
 */
export type UpdateChannel = 'latest' | 'stable'

/** Error returned by the native check when no stable release is promoted yet. */
export const STABLE_CHANNEL_UNAVAILABLE = 'stable-channel-unavailable'

/** Fired after the channel changes so update sections re-read their status. */
export const UPDATE_CHANNEL_CHANGED_EVENT = 'specrails:update-channel-changed'

interface NativeUpdateMetadata {
  rid: number
  currentVersion: string
  version: string
  date?: string
  body?: string
  rawJson: Record<string, unknown>
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'latest' || value === 'stable'
}

/** Selected channel; any read failure keeps the historical `latest` behaviour. */
export async function readUpdateChannel(): Promise<UpdateChannel> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/settings`)
    if (!res.ok) return 'latest'
    const body = (await res.json()) as { updateChannel?: unknown }
    return isUpdateChannel(body.updateChannel) ? body.updateChannel : 'latest'
  } catch {
    return 'latest'
  }
}

export async function saveUpdateChannel(channel: UpdateChannel): Promise<void> {
  const res = await fetch(`${API_ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updateChannel: channel }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UPDATE_CHANNEL_CHANGED_EVENT, { detail: channel }))
}

/**
 * Channel-aware replacement for the plugin's `check()`: the native
 * `check_app_update` command reads the selected channel's manifest and returns
 * the plugin's metadata, so the stock `Update` download/install path (and its
 * signature verification) is reused unchanged.
 */
export async function checkAppUpdate(channel?: UpdateChannel): Promise<Update | null> {
  const selected = channel ?? await readUpdateChannel()
  const metadata = await invoke<NativeUpdateMetadata | null>('check_app_update', { channel: selected })
  return metadata ? new Update(metadata) : null
}

export function isStableChannelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(STABLE_CHANNEL_UNAVAILABLE)
}
