import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentModeAnalyticsPane } from '../AgentModeAnalyticsPane'

vi.mock('../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({ closeAnalyticsPane: vi.fn() }),
}))
vi.mock('../../../analytics/pages/AnalyticsPage', () => ({ default: () => <div>Analytics content</div> }))

describe('AgentModeAnalyticsPane', () => {
  it('blocks native text selection during resize and restores it on completion or unmount', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    const view = render(<AgentModeAnalyticsPane />)
    await screen.findByText('Analytics content')
    try {
      const handle = screen.getByRole('separator')
      const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 500 })
      fireEvent(handle, down)
      expect(down.defaultPrevented).toBe(true)
      expect(document.body.style.userSelect).toBe('none')
      expect(document.body.style.cursor).toBe('col-resize')
      const select = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(select)
      expect(select.defaultPrevented).toBe(true)
      const pane = handle.parentElement as HTMLElement
      const width = Number.parseFloat(pane.style.width)
      fireEvent.pointerMove(window, { clientX: 480 })
      expect(Number.parseFloat(pane.style.width)).toBe(width + 20)
      fireEvent.pointerUp(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
      const normalSelect = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(normalSelect)
      expect(normalSelect.defaultPrevented).toBe(false)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      fireEvent.blur(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      view.unmount()
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
    } finally {
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('anchors the resize handle inside the pane across its full height', async () => {
    render(<AgentModeAnalyticsPane />)
    await screen.findByText('Analytics content')
    const handle = screen.getByRole('separator')
    expect(handle.parentElement).toHaveClass('relative')
    expect(handle).toHaveClass('absolute', 'inset-y-0', 'left-0', 'z-20')
    expect(handle).not.toHaveClass('-translate-x-full')
    fireEvent.click(screen.getByLabelText('Maximize'))
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Restore'))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })
})
