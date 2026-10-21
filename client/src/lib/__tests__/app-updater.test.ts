import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/plugin-updater', () => ({
  Update: class {
    constructor(public metadata: Record<string, unknown>) { Object.assign(this, metadata) }
  },
}))

import { checkAppUpdate, isStableChannelUnavailable, readUpdateChannel, saveUpdateChannel, UPDATE_CHANNEL_CHANGED_EVENT } from '../app-updater'

function mockSettings(body: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body }) as never
}

beforeEach(() => { invokeMock.mockReset() })

describe('app-updater', () => {
  it('reads the persisted channel and falls back to latest on anything unexpected', async () => {
    mockSettings({ updateChannel: 'stable' })
    expect(await readUpdateChannel()).toBe('stable')
    mockSettings({ updateChannel: 'nightly' })
    expect(await readUpdateChannel()).toBe('latest')
    mockSettings({}, false)
    expect(await readUpdateChannel()).toBe('latest')
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never
    expect(await readUpdateChannel()).toBe('latest')
  })

  it('checks the selected channel through the native command and wraps the plugin Update', async () => {
    mockSettings({ updateChannel: 'stable' })
    invokeMock.mockResolvedValue({ rid: 7, currentVersion: '2.64.0', version: '2.64.2', rawJson: {} })
    const update = await checkAppUpdate()
    expect(invokeMock).toHaveBeenCalledWith('check_app_update', { channel: 'stable' })
    expect(update).toMatchObject({ version: '2.64.2', currentVersion: '2.64.0' })
  })

  it('honours an explicit channel and returns null when up to date', async () => {
    invokeMock.mockResolvedValue(null)
    expect(await checkAppUpdate('latest')).toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('check_app_update', { channel: 'latest' })
  })

  it('persists the channel and announces the change', async () => {
    mockSettings({ ok: true })
    const heard = vi.fn()
    window.addEventListener(UPDATE_CHANNEL_CHANGED_EVENT, heard)
    await saveUpdateChannel('stable')
    window.removeEventListener(UPDATE_CHANNEL_CHANGED_EVENT, heard)
    expect(global.fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ updateChannel: 'stable' }) }))
    expect(heard).toHaveBeenCalledTimes(1)
    mockSettings({}, false)
    await expect(saveUpdateChannel('latest')).rejects.toThrow('HTTP 500')
  })

  it('recognises the native stable-unavailable error in string or Error form', () => {
    expect(isStableChannelUnavailable('stable-channel-unavailable')).toBe(true)
    expect(isStableChannelUnavailable(new Error('stable-channel-unavailable'))).toBe(true)
    expect(isStableChannelUnavailable(new Error('network down'))).toBe(false)
  })
})
