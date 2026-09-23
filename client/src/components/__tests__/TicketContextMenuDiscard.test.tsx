import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { TicketContextMenu } from '../../features/specs/components/TicketContextMenu'
import { JiraDiscardProvider } from '../../features/integrations/context/JiraDiscardContext'
import type { LocalTicket } from '../../types'

// Control the single connection probe the provider performs.
const jiraState = { connected: true, jiraProjectKey: 'PROJ', discardStatus: 'Cancelled' as string | null, loading: false }
vi.mock('../../features/integrations/hooks/useJiraConnection', () => ({
  useJiraConnection: () => jiraState,
}))

// The discard dialog (opened by the move-to item) imports these.
vi.mock('../../features/integrations/lib/jira-api', () => ({ jiraApi: { discardSpec: vi.fn().mockResolvedValue({ ok: true }) } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const jiraTicket: Pick<LocalTicket, 'id' | 'title' | 'status' | 'priority' | 'source' | 'jira_key'> = {
  id: 78, title: 'Skill spec', status: 'todo', priority: 'medium', source: 'jira', jira_key: 'PROJ-78',
}

function renderMenu(ticket: typeof jiraTicket) {
  return render(
    <JiraDiscardProvider>
      <TicketContextMenu ticket={ticket} onDelete={vi.fn()} onStatusChange={vi.fn()} onPriorityChange={vi.fn()}>
        <span>Target</span>
      </TicketContextMenu>
    </JiraDiscardProvider>
  )
}

describe('TicketContextMenu — Jira discard', () => {
  beforeEach(() => {
    jiraState.connected = true
    jiraState.discardStatus = 'Cancelled'
  })

  it('shows "Move to <status>" instead of Delete for a Jira-backed spec', () => {
    renderMenu(jiraTicket)
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByTestId('jira-move-to-menuitem')).toBeDefined()
    expect(screen.getByText('Move to Cancelled')).toBeDefined()
    expect(screen.queryByText('Delete ticket')).toBeNull()
  })

  it('opens the discard dialog when the move-to item is clicked', () => {
    renderMenu(jiraTicket)
    fireEvent.contextMenu(screen.getByText('Target'))
    fireEvent.click(screen.getByTestId('jira-move-to-menuitem'))
    expect(screen.getByTestId('jira-discard-dialog')).toBeDefined()
  })

  it('keeps the normal Delete for a non-Jira ticket', () => {
    renderMenu({ ...jiraTicket, source: 'manual', jira_key: null })
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByText('Delete ticket')).toBeDefined()
    expect(screen.queryByTestId('jira-move-to-menuitem')).toBeNull()
  })

  it('keeps the normal Delete when no discard status is configured', () => {
    jiraState.discardStatus = null
    renderMenu(jiraTicket)
    fireEvent.contextMenu(screen.getByText('Target'))
    expect(screen.getByText('Delete ticket')).toBeDefined()
    expect(screen.queryByTestId('jira-move-to-menuitem')).toBeNull()
  })
})
