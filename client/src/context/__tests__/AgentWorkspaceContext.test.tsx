import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspaceProvider, useAgentWorkspace } from '../AgentWorkspaceContext'

function IntegrationsStateProbe() {
  const workspace = useAgentWorkspace()
  return (
    <div>
      <div data-testid="integrations-state">
        {workspace.integrationsModalOpen ? 'open' : 'closed'}
      </div>
      <button type="button" onClick={workspace.toggleIntegrationsModal}>
        Toggle integrations
      </button>
    </div>
  )
}

describe('AgentWorkspaceContext', () => {
  it('defaults the integrations modal closed and toggles it open', () => {
    render(
      <AgentWorkspaceProvider>
        <IntegrationsStateProbe />
      </AgentWorkspaceProvider>,
    )

    expect(screen.getByTestId('integrations-state')).toHaveTextContent('closed')

    fireEvent.click(screen.getByRole('button', { name: /toggle integrations/i }))

    expect(screen.getByTestId('integrations-state')).toHaveTextContent('open')
  })
})
