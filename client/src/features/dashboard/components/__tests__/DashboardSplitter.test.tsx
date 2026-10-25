import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DashboardSplitter } from '../DashboardSplitter'

function renderSplitter() {
  const onNudge = vi.fn()
  render(
    <DashboardSplitter leftWidth={800} viewport={1400} onPointerDown={vi.fn()} onReset={vi.fn()} onNudge={onNudge} />,
  )
  return { onNudge, splitter: screen.getByTestId('dashboard-splitter') }
}

describe('DashboardSplitter keyboard', () => {
  it('nudges 16 px with the arrow keys', () => {
    const { onNudge, splitter } = renderSplitter()
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(splitter, { key: 'ArrowRight' })
    expect(onNudge.mock.calls).toEqual([[-16], [16]])
  })

  it('nudges 64 px with Shift held', () => {
    const { onNudge, splitter } = renderSplitter()
    fireEvent.keyDown(splitter, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(splitter, { key: 'ArrowRight', shiftKey: true })
    expect(onNudge.mock.calls).toEqual([[-64], [64]])
  })

  it('ignores other keys', () => {
    const { onNudge, splitter } = renderSplitter()
    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    expect(onNudge).not.toHaveBeenCalled()
  })
})
