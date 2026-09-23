/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { TerminalDragHandle } from '../TerminalDragHandle'

describe('TerminalDragHandle', () => {
  it('commits a height within [120, maxHeight] on pointer up', async () => {
    const onCommit = vi.fn()
    const onPreview = vi.fn()
    const { getByRole } = render(
      <TerminalDragHandle
        height={300}
        maxHeight={800}
        minHeight={120}
        onHeightCommit={onCommit}
        onHeightPreview={onPreview}
      />,
    )
    const handle = getByRole('separator')
    // pointerdown at y=600 (the handle's start)
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 })
    // Move up by 50 → new height should be ~350
    fireEvent.pointerMove(window, { clientY: 550 })
    // Wait for rAF
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.pointerUp(window)
    expect(onCommit).toHaveBeenCalledTimes(1)
    const v = onCommit.mock.calls[0][0] as number
    expect(v).toBeGreaterThanOrEqual(120)
    expect(v).toBeLessThanOrEqual(800)
    expect(v).toBe(350)
  })

  it('clamps below min', async () => {
    const onCommit = vi.fn()
    const { getByRole } = render(
      <TerminalDragHandle height={200} maxHeight={800} minHeight={120} onHeightCommit={onCommit} />,
    )
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 })
    // Drag down by 500 → would be -300 → clamps to 120
    fireEvent.pointerMove(window, { clientY: 1100 })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.pointerUp(window)
    expect(onCommit).toHaveBeenCalledWith(120)
  })

  it('clamps above max', async () => {
    const onCommit = vi.fn()
    const { getByRole } = render(
      <TerminalDragHandle height={700} maxHeight={800} minHeight={120} onHeightCommit={onCommit} />,
    )
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 })
    // Drag up by 500 → would be 1200 → clamps to 800
    fireEvent.pointerMove(window, { clientY: 100 })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.pointerUp(window)
    expect(onCommit).toHaveBeenCalledWith(800)
  })
})
