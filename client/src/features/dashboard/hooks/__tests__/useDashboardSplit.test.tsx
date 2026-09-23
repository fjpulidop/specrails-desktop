import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDashboardSplit, MIN_LEFT_PX, MIN_RIGHT_PX, DISABLE_BELOW_VIEWPORT_PX } from '../useDashboardSplit'

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
  window.dispatchEvent(new Event('resize'))
}

describe('useDashboardSplit', () => {
  beforeEach(() => {
    localStorage.clear()
    setViewport(1400)
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('initialises at the 70/30 default split when no stored value exists', () => {
    // viewport 1400 → round(1400 * 0.70) = 980
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    expect(result.current.leftWidth).toBe(980)
    expect(result.current.enabled).toBe(true)
  })

  it('ignores any persisted width at mount and uses the canonical default', () => {
    // Persistence is in-session only — first paint always matches dblclick.
    localStorage.setItem('specrails-desktop:dashboard-split:proj-1', '950')
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    expect(result.current.leftWidth).toBe(980)
  })

  it('canonical default clamps to viewport - MIN_RIGHT_PX on small viewports', () => {
    setViewport(1000)
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    // round(1000 * 0.70) = 700; clamp(700) within [320, 720] = 700.
    expect(result.current.leftWidth).toBe(700)
  })

  it('is disabled when viewport is below DISABLE_BELOW_VIEWPORT_PX', () => {
    setViewport(DISABLE_BELOW_VIEWPORT_PX - 100)
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    expect(result.current.enabled).toBe(false)
    expect(result.current.leftWidth).toBeNull()
  })

  it('resetToDefault restores the canonical default and persists', () => {
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    expect(result.current.leftWidth).toBe(980)
    act(() => result.current.resetToDefault())
    expect(result.current.leftWidth).toBe(980)
    expect(localStorage.getItem('specrails-desktop:dashboard-split:proj-1')).toBe('980')
  })

  it('falls back to the wide-left + compact-rails preset when no stored value existed at mount', () => {
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    // viewport 1400 → default = 1100
    expect(result.current.leftWidth).toBe(980)
    act(() => result.current.resetToDefault())
    expect(result.current.leftWidth).toBe(980)
    expect(localStorage.getItem('specrails-desktop:dashboard-split:proj-1')).toBe('980')
  })

  it('switching projects resets to the canonical default', () => {
    // Pre-existing stored values are ignored — the splitter always opens at
    // the canonical default for whichever project becomes active.
    localStorage.setItem('specrails-desktop:dashboard-split:proj-A', '800')
    localStorage.setItem('specrails-desktop:dashboard-split:proj-B', '500')
    const { result, rerender } = renderHook(({ id }) => useDashboardSplit(id), {
      initialProps: { id: 'proj-A' as string | null },
    })
    expect(result.current.leftWidth).toBe(980)
    rerender({ id: 'proj-B' })
    expect(result.current.leftWidth).toBe(980)
  })

  it('responds to viewport resize by toggling the disabled state', () => {
    setViewport(1400)
    const { result } = renderHook(() => useDashboardSplit('proj-1'))
    expect(result.current.leftWidth).toBe(980)
    act(() => setViewport(800))
    // 800 < DISABLE_BELOW_VIEWPORT_PX (900) → disabled, leftWidth=null
    expect(result.current.enabled).toBe(false)
    expect(result.current.leftWidth).toBeNull()
  })

  it('exposes MIN constants as documented bounds', () => {
    expect(MIN_LEFT_PX).toBe(320)
    expect(MIN_RIGHT_PX).toBe(280)
    expect(DISABLE_BELOW_VIEWPORT_PX).toBe(900)
  })
})
