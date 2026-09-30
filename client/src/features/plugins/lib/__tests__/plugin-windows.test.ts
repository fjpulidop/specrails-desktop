import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPluginWindowRoute, openPluginWindow } from '../plugin-windows'
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }))
vi.mock('../../../../lib/tauri-shell', () => ({ isTauri: () => native.enabled }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
beforeEach(() => { vi.restoreAllMocks(); native.enabled = false; native.invoke.mockReset(); window.history.replaceState({}, '', '/') })
describe('Plugins windows', () => {
  it('reports a blocked popup and lets the user retry', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openPluginWindow()).rejects.toThrow('Allow pop-up')
  })
  it('opens the Plugins surface and focuses the existing window without replacing forms', async () => {
    const popup = { closed: false, focus: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    await openPluginWindow()
    expect(new URL(open.mock.calls[0][0] as string).searchParams.get('pluginsWindow')).toBe('1')
    await openPluginWindow()
    expect(open).toHaveBeenCalledOnce()
    expect(popup.focus).toHaveBeenCalledOnce()
    Object.assign(popup, { closed: true })
    await openPluginWindow()
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('uses the native command and surfaces creation errors', async () => {
    native.enabled = true
    await openPluginWindow()
    expect(native.invoke).toHaveBeenCalledWith('plugin_window_open')
    native.invoke.mockRejectedValueOnce(new Error('unavailable'))
    await expect(openPluginWindow()).rejects.toThrow('unavailable')
  })
  it('recognizes the independent Plugins surface in native and browser development', () => {
    expect(isPluginWindowRoute()).toBe(false)
    window.history.replaceState({}, '', '/?pluginsWindow=1')
    expect(isPluginWindowRoute()).toBe(true)
  })
})
