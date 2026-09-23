import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspaceProvider, useAgentWorkspace } from '../AgentWorkspaceContext'

function WorkspaceStateProbe() {
  const workspace = useAgentWorkspace()
  return (
    <div>
      <div data-testid="jobs-state">{workspace.jobsPaneOpen ? 'open' : 'closed'}</div>
      <div data-testid="code-state">{workspace.codePaneOpen ? 'open' : 'closed'}</div>
      <button type="button" onClick={workspace.toggleJobsPane}>Toggle jobs</button>
      <button type="button" onClick={workspace.toggleCodePane}>Toggle code</button>
    </div>
  )
}

describe('AgentWorkspaceContext', () => {
  it('toggles workspace panes', () => {
    render(
      <AgentWorkspaceProvider>
        <WorkspaceStateProbe />
      </AgentWorkspaceProvider>,
    )

    expect(screen.getByTestId('jobs-state')).toHaveTextContent('closed')
    expect(screen.getByTestId('code-state')).toHaveTextContent('closed')

    fireEvent.click(screen.getByRole('button', { name: /toggle jobs/i }))
    fireEvent.click(screen.getByRole('button', { name: /toggle code/i }))

    expect(screen.getByTestId('jobs-state')).toHaveTextContent('open')
    expect(screen.getByTestId('code-state')).toHaveTextContent('open')
  })
})
