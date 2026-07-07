import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentIntegrationsModal } from '../AgentIntegrationsModal'

const guardBackdrop = vi.fn((cb: () => void) => cb)

vi.mock('../../../pages/IntegrationsPage', () => ({
  default: () => <div data-testid="integrations-page">Integrations page content</div>,
}))

vi.mock('../../../hooks/useMovableResizableModal', () => ({
  useMovableResizableModal: vi.fn(() => ({
    panelRef: vi.fn(),
    panelStyle: {},
    headerHandleProps: {},
    resizeHandles: [],
    isFloating: false,
    guardBackdrop,
  })),
}))

describe('AgentIntegrationsModal', () => {
  it('portals a fixed overlay with existing IntegrationsPage content and close controls', async () => {
    const onClose = vi.fn()
    const { container } = render(
      <div data-testid="agent-panel">
        <AgentIntegrationsModal onClose={onClose} />
      </div>,
    )

    const overlay = document.body.querySelector('div.fixed.inset-0')
    expect(overlay).not.toBeNull()
    expect(overlay!.classList.contains('z-[65]')).toBe(true)
    expect(container.contains(overlay)).toBe(false)
    expect(overlay!.querySelector('.glass-card')).not.toBeNull()
    expect(screen.getByTestId('integrations-page')).toHaveTextContent('Integrations page content')

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
