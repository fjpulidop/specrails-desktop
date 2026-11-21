import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { showNativeNotification } from '../native-notify'
import { readWindowFocus } from '../window-focus'

const host = window as unknown as { __TAURI_INTERNALS__?: unknown }

describe('showNativeNotification', () => {
  beforeEach(() => { invoke.mockReset().mockResolvedValue(undefined) })
  afterEach(() => { delete host.__TAURI_INTERNALS__; vi.unstubAllGlobals() })

  it('desktop app: the guarded host command, with the sound flag and clipped text (never the Web API)', async () => {
    host.__TAURI_INTERNALS__ = {}
    const web = vi.fn()
    vi.stubGlobal('Notification', Object.assign(web, { permission: 'granted' }))
    expect(await showNativeNotification({ title: 'T'.repeat(400), body: '界'.repeat(2_000), sound: true })).toBe(true)
    const [command, args] = invoke.mock.calls[0] as [string, { title: string; body: string; sound: boolean }]
    expect(command).toBe('desktop_notify')
    expect(args.sound).toBe(true)
    expect(Array.from(args.title)).toHaveLength(150)
    expect(new TextEncoder().encode(args.title).length).toBeLessThanOrEqual(512)
    expect(new TextEncoder().encode(args.body).length).toBeLessThanOrEqual(4096)
    expect(web).not.toHaveBeenCalled()
  })

  it('desktop app: a refused host command resolves false', async () => {
    host.__TAURI_INTERNALS__ = {}
    invoke.mockRejectedValueOnce(new Error('unavailable'))
    expect(await showNativeNotification({ title: 't', body: 'b' })).toBe(false)
  })

  it('browser: silent unless the sound is on; a click focuses, runs onClick and closes', async () => {
    const created: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> = []
    class FakeNotification {
      static permission = 'granted'
      onclick: (() => void) | null = null
      close = vi.fn()
      constructor(public title: string, public options: NotificationOptions) { created.push(this) }
    }
    vi.stubGlobal('Notification', FakeNotification)
    const onClick = vi.fn()
    await showNativeNotification({ title: 'a', body: 'b', tag: 'k', sound: false, onClick })
    await showNativeNotification({ title: 'c', body: 'd', sound: true })
    expect(created[0].options).toMatchObject({ body: 'b', tag: 'k', silent: true })
    expect(created[1].options.silent).toBe(false)
    created[0].onclick?.()
    expect(onClick).toHaveBeenCalledOnce()
    expect(created[0].close).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('browser: asks for permission once when undecided; denied or missing API resolves false', async () => {
    const requestPermission = vi.fn(async () => 'denied')
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission }))
    expect(await showNativeNotification({ title: 'a', body: 'b' })).toBe(false)
    expect(requestPermission).toHaveBeenCalledOnce()
    vi.stubGlobal('Notification', undefined)
    expect(await showNativeNotification({ title: 'a', body: 'b' })).toBe(false)
  })
})

describe('readWindowFocus', () => {
  afterEach(() => { delete host.__TAURI_INTERNALS__ })

  it('desktop app: asks the host which window has the focus', async () => {
    host.__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValueOnce('mission-abc').mockResolvedValueOnce(null)
    expect(await readWindowFocus()).toEqual({ appFocused: true, label: 'mission-abc' })
    expect(await readWindowFocus()).toEqual({ appFocused: false, label: null })
    expect(invoke).toHaveBeenCalledWith('desktop_focus_state')
  })

  it('browser: the document focus is the main window', async () => {
    const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(await readWindowFocus()).toEqual({ appFocused: true, label: 'main' })
    spy.mockReturnValue(false)
    expect(await readWindowFocus()).toEqual({ appFocused: false, label: null })
    spy.mockRestore()
  })
})
