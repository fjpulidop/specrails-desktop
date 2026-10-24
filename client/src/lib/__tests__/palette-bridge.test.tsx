import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  getPaletteSurface,
  registerPaletteSurface,
  resetPaletteSurfaces,
  useRegisterPaletteSurface,
  usePaletteSurfaces,
  type PaletteSpecsSurface,
} from '../palette-bridge'

function Surface({ onOpen, enabled = true }: { onOpen: (m: 'quick' | 'explore') => void; enabled?: boolean }) {
  useRegisterPaletteSurface('specs', enabled ? { openNewSpec: onOpen } : null)
  return null
}

let seen: Partial<{ specs: PaletteSpecsSurface }> = {}
function Reader() {
  seen = usePaletteSurfaces()
  return null
}

describe('palette bridge', () => {
  beforeEach(() => resetPaletteSurfaces())

  it('registers while mounted and forgets on unmount', () => {
    const { unmount } = render(<Surface onOpen={vi.fn()} />)
    expect(getPaletteSurface('specs')).not.toBeNull()
    unmount()
    expect(getPaletteSurface('specs')).toBeNull()
  })

  it('forwards calls to the latest render (no stale closures)', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Surface onOpen={first} />)
    rerender(<Surface onOpen={second} />)
    getPaletteSurface('specs')!.openNewSpec('explore')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('explore')
  })

  it('a null surface registers nothing, and toggling registers/unregisters', () => {
    const { rerender } = render(<Surface onOpen={vi.fn()} enabled={false} />)
    expect(getPaletteSurface('specs')).toBeNull()
    rerender(<Surface onOpen={vi.fn()} enabled />)
    expect(getPaletteSurface('specs')).not.toBeNull()
    rerender(<Surface onOpen={vi.fn()} enabled={false} />)
    expect(getPaletteSurface('specs')).toBeNull()
  })

  it('a newer registration wins and the older one cannot remove it', () => {
    const offA = registerPaletteSurface('specs', { openNewSpec: vi.fn() })
    const b = { openNewSpec: vi.fn() }
    registerPaletteSurface('specs', b)
    offA()
    expect(getPaletteSurface('specs')).toBe(b)
  })

  it('readers re-render when a surface appears or leaves', () => {
    render(<Reader />)
    expect(seen.specs).toBeUndefined()
    let off = () => {}
    act(() => { off = registerPaletteSurface('specs', { openNewSpec: vi.fn() }) })
    expect(seen.specs).toBeDefined()
    act(() => off())
    expect(seen.specs).toBeUndefined()
  })
})
