import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentWorkspaceProvider, useAgentWorkspace } from '../AgentWorkspaceContext'

function WorkspaceStateProbe() {
  const workspace = useAgentWorkspace()
  return (
    <div>
      <div data-testid="jobs-state">{workspace.jobsPaneOpen ? 'open' : 'closed'}</div>
      <div data-testid="code-state">{workspace.codePaneOpen ? 'open' : 'closed'}</div>
      <div data-testid="analytics-state">{workspace.analyticsPaneOpen ? 'open' : 'closed'}</div>
      <button type="button" onClick={workspace.toggleJobsPane}>Toggle jobs</button>
      <button type="button" onClick={workspace.toggleCodePane}>Toggle code</button>
      <button type="button" onClick={workspace.openAnalyticsPane}>Open analytics</button>
      <button type="button" onClick={() => workspace.restoreWorkspace({ codePaneOpen: true, jobsPaneOpen: false, analyticsPaneOpen: true, browserOpen: false, pendingCaptures: [] })}>Restore legacy</button>
    </div>
  )
}

describe('AgentWorkspaceContext', () => {
  it('toggles workspace panes, keeping Jobs / Files / Analytics mutually exclusive', () => {
    render(
      <AgentWorkspaceProvider>
        <WorkspaceStateProbe />
      </AgentWorkspaceProvider>,
    )

    expect(screen.getByTestId('jobs-state')).toHaveTextContent('closed')
    expect(screen.getByTestId('code-state')).toHaveTextContent('closed')

    fireEvent.click(screen.getByRole('button', { name: /toggle jobs/i }))
    expect(screen.getByTestId('jobs-state')).toHaveTextContent('open')

    fireEvent.click(screen.getByRole('button', { name: /toggle code/i }))
    expect(screen.getByTestId('code-state')).toHaveTextContent('open')
    expect(screen.getByTestId('jobs-state')).toHaveTextContent('closed')

    fireEvent.click(screen.getByRole('button', { name: /open analytics/i }))
    expect(screen.getByTestId('analytics-state')).toHaveTextContent('open')
    expect(screen.getByTestId('code-state')).toHaveTextContent('closed')

    fireEvent.click(screen.getByRole('button', { name: /toggle code/i }))
    fireEvent.click(screen.getByRole('button', { name: /toggle code/i }))
    expect(screen.getByTestId('code-state')).toHaveTextContent('closed')
    expect(screen.getByTestId('analytics-state')).toHaveTextContent('closed')
  })

  it('restores a legacy snapshot with several panes open to the first in jobs → code → analytics order', () => {
    render(
      <AgentWorkspaceProvider>
        <WorkspaceStateProbe />
      </AgentWorkspaceProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /restore legacy/i }))
    expect(screen.getByTestId('code-state')).toHaveTextContent('open')
    expect(screen.getByTestId('analytics-state')).toHaveTextContent('closed')
    expect(screen.getByTestId('jobs-state')).toHaveTextContent('closed')
  })
})
