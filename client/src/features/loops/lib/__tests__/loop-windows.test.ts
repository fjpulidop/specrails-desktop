import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isLoopWindowRoute, openLoopWindow } from '../loop-windows'
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }))
vi.mock('../../../../lib/tauri-shell', () => ({ isTauri: () => native.enabled }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
beforeEach(() => { vi.restoreAllMocks(); native.enabled = false; native.invoke.mockReset(); window.history.replaceState({}, '', '/') })
describe('independent loop windows', () => {
  it('opens and reuses a browser editor without navigating away from its draft', async () => {
    const popup = { closed: false, focus: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    await openLoopWindow('project-1', 'factory:implement')
    const url = new URL(open.mock.calls[0][0] as string)
    expect(url.searchParams.get('projectId')).toBe('project-1')
    expect(url.searchParams.get('loopId')).toBe('factory:implement')
    expect(url.searchParams.get('loopsWindow')).toBe('1')
    await openLoopWindow('project-1', 'factory:implement')
    expect(open).toHaveBeenCalledTimes(1)
    expect(popup.focus).toHaveBeenCalledOnce()
  })
  it('surfaces blocked popups and allows retry', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openLoopWindow('blocked')).rejects.toThrow('Allow pop-up')
    open.mockReturnValue({ closed: false } as Window)
    await expect(openLoopWindow('blocked')).resolves.toBeUndefined()
  })
  it('delegates native creation with project and loop context', async () => {
    native.enabled = true
    await openLoopWindow('native-project', 'loop-1')
    expect(native.invoke).toHaveBeenCalledWith('loop_window_open', { projectId: 'native-project', loopId: 'loop-1' })
    native.invoke.mockRejectedValueOnce(new Error('unavailable'))
    await expect(openLoopWindow(null)).rejects.toThrow('unavailable')
  })
  it('recognizes the editor surface in browser development too', () => {
    expect(isLoopWindowRoute()).toBe(false)
    window.history.replaceState({}, '', '/?loopsWindow=1')
    expect(isLoopWindowRoute()).toBe(true)
  })
})
