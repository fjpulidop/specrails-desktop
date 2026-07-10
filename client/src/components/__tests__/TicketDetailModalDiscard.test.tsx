import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../test-utils'

// Mirror the providers/mocks the base TicketDetailModal test sets up.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
  }),
}))
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [],
    activeProjectId: 'proj-test',
    setActiveProjectId: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    isLoading: false,
    isSwitchingProject: false,
    setupProjectIds: new Set(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
  }),
}))
vi.mock('../../lib/tauri-shell', () => ({ openExternalUrl: vi.fn() }))

// The discard feature toggles on the Jira connection probe.
const mockUseJiraConnection = vi.fn()
vi.mock('../../hooks/useJiraConnection', () => ({
  useJiraConnection: () => mockUseJiraConnection(),
}))

// Keep the discard dialog as the real component so its testid renders when opened.
import { TicketDetailModal } from '../TicketDetailModal'
import type { LocalTicket } from '../../types'

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1, title: 'Test ticket', description: 'A description', status: 'todo', priority: 'medium',
    labels: ['bug'], assignee: null, prerequisites: [], metadata: {},
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'user', source: 'manual',
    ...overrides,
  }
}

function makeDefaultProps(overrides: Partial<{
  ticket: LocalTicket
  allLabels: string[]
  onClose: () => void
  onSave: (id: number, fields: Partial<LocalTicket>) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
}> = {}) {
  return {
    ticket: makeTicket(),
    allLabels: ['bug', 'area:frontend', 'area:backend'],
    onClose: vi.fn(),
    onSave: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    ...overrides,
  }
}

const JIRA_TICKET = makeTicket({ source: 'jira', jira_key: 'PROJ-7', jira_url: 'https://acme.atlassian.net/browse/PROJ-7' })

describe('TicketDetailModal — Jira discard ("Move to <status>")', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: not connected → normal Delete button.
    mockUseJiraConnection.mockReturnValue({ connected: false, jiraProjectKey: null, discardStatus: null, loading: false })
  })

  describe('when connected with a discard status on a Jira-backed spec', () => {
    beforeEach(() => {
      mockUseJiraConnection.mockReturnValue({
        connected: true,
        jiraProjectKey: 'PROJ',
        discardStatus: 'Cancelled',
        loading: false,
      })
    })

    it('shows the Move-to button and no Delete button', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_TICKET })} />)
      expect(screen.getByTestId('jira-move-to-button')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    })

    it('opens the discard dialog when the Move-to button is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_TICKET })} />)
      fireEvent.click(screen.getByTestId('jira-move-to-button'))
      await waitFor(() => {
        expect(screen.getByTestId('jira-discard-dialog')).toBeInTheDocument()
      })
    })
  })

  describe('falls back to the normal Delete button', () => {
    it('when the Jira connection is not connected', () => {
      mockUseJiraConnection.mockReturnValue({ connected: false, jiraProjectKey: null, discardStatus: null, loading: false })
      render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_TICKET })} />)
      expect(screen.queryByTestId('jira-move-to-button')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
    })

    it('when connected but no discard status is configured', () => {
      mockUseJiraConnection.mockReturnValue({ connected: true, jiraProjectKey: 'PROJ', discardStatus: null, loading: false })
      render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_TICKET })} />)
      expect(screen.queryByTestId('jira-move-to-button')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
    })

    it('when the ticket is not Jira-backed even though Jira is configured', () => {
      mockUseJiraConnection.mockReturnValue({ connected: true, jiraProjectKey: 'PROJ', discardStatus: 'Cancelled', loading: false })
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ source: 'manual', jira_key: null }) })} />)
      expect(screen.queryByTestId('jira-move-to-button')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
    })
  })
})
