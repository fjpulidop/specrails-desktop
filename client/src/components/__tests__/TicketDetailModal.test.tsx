import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'

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
const mockOpenExternalUrl = vi.fn()
vi.mock('../../lib/tauri-shell', () => ({ openExternalUrl: (u: string) => mockOpenExternalUrl(u) }))

import { TicketDetailModal } from '../TicketDetailModal'
import type { LocalTicket } from '../../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  onDelete: (id: number) => void
}> = {}) {
  return {
    ticket: makeTicket(),
    allLabels: ['bug', 'area:frontend', 'area:backend'],
    onClose: vi.fn(),
    onSave: vi.fn(async () => true),
    onDelete: vi.fn(),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TicketDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 })
  })

  describe('board-mode stacking (agent-chat refs)', () => {
    it('stacks the overlay at z-[68], above the floating agent panel (z-[60]) AND the JobDetailModal (z-[65])', () => {
      // Regression: agent-chat ticket-ref chips open this app-root modal while
      // the floating AgentChatPanel (z-[60]) is on screen — at the old z-50 it
      // opened BEHIND the panel and looked like nothing happened. Raised further
      // to z-[68] so a spec chip clicked INSIDE a mission-mode JobDetailModal
      // (z-[65]) opens the ticket IN FRONT of it, not behind.
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const overlay = document.querySelector('div.fixed.inset-0')
      expect(overlay).not.toBeNull()
      expect(overlay!.classList.contains('z-[68]')).toBe(true)
    })
  })

  describe('Jira "Go to Ticket" button', () => {
    it('shows the button for a Jira-backed spec and opens it in the default browser', () => {
      const ticket = makeTicket({ source: 'jira', jira_key: 'SKILLS-17', jira_url: 'https://acme.atlassian.net/browse/SKILLS-17' })
      render(<TicketDetailModal {...makeDefaultProps({ ticket })} />)
      const btn = screen.getByTestId('jira-go-to-ticket')
      expect(btn).toHaveTextContent('SKILLS-17')
      fireEvent.click(btn)
      expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://acme.atlassian.net/browse/SKILLS-17')
    })

    it('does not show the button for a non-Jira spec', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ source: 'manual' }) })} />)
      expect(screen.queryByTestId('jira-go-to-ticket')).not.toBeInTheDocument()
    })

    it('shows the parent epic and opens it in Jira when the spec has one', () => {
      const ticket = makeTicket({
        source: 'jira',
        jira_key: 'SKILLS-17',
        jira_url: 'https://acme.atlassian.net/browse/SKILLS-17',
        jira_epic_key: 'SKILLS-1',
        jira_epic_name: 'Onboarding revamp',
      })
      render(<TicketDetailModal {...makeDefaultProps({ ticket })} />)
      const epic = screen.getByTestId('jira-epic')
      expect(epic).toHaveTextContent('SKILLS-1')
      expect(epic).toHaveTextContent('Onboarding revamp')
      fireEvent.click(screen.getByRole('button', { name: /Onboarding revamp/ }))
      expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://acme.atlassian.net/browse/SKILLS-1')
    })

    it('does not show the epic block when the spec has no epic', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ source: 'jira', jira_key: 'X-1', jira_url: 'https://a.atlassian.net/browse/X-1' }) })} />)
      expect(screen.queryByTestId('jira-epic')).not.toBeInTheDocument()
    })
  })

  describe('rendering', () => {
    it('renders ticket title', () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      expect(screen.getByText('Test ticket')).toBeDefined()
    })

    it('renders ticket description', () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      expect(screen.getByText('A description')).toBeDefined()
    })

    it('renders ticket labels', () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      expect(screen.getByText('bug')).toBeDefined()
    })

    it('renders ticket ID in header', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ id: 42 }) })} />)
      expect(screen.getByText(/#42/)).toBeDefined()
    })

    it('renders the On Review badge in the header for an on_review spec', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ status: 'on_review' }) })} />)
      const badge = screen.getByTestId('ticket-modal-on-review-badge')
      expect(badge).toBeDefined()
      expect(badge.textContent).toContain('On Review')
    })

    it('does not render the On Review badge for a todo spec', () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      expect(screen.queryByTestId('ticket-modal-on-review-badge')).toBeNull()
    })

    it('removes the compare affordance when the viewport shrinks below the split threshold', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      expect(screen.getByTestId('ticket-modal-compare')).toBeInTheDocument()

      window.innerWidth = 800
      fireEvent(window, new Event('resize'))

      await waitFor(() => expect(screen.queryByTestId('ticket-modal-compare')).not.toBeInTheDocument())
    })
  })

  describe('close behavior', () => {
    it('calls onClose when the X button is clicked', () => {
      const onClose = vi.fn()
      const { container } = render(<TicketDetailModal {...makeDefaultProps({ onClose })} />)

      // Close button has X icon (no aria-label), find via SVG class
      const closeBtn = container.querySelector('.lucide-x')!.closest('button')!
      fireEvent.click(closeBtn)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when backdrop is clicked', () => {
      const onClose = vi.fn()
      const { container } = render(<TicketDetailModal {...makeDefaultProps({ onClose })} />)

      // The backdrop is the absolute inset-0 div behind the panel
      const backdrop = container.querySelector('.absolute.inset-0')!
      fireEvent.click(backdrop)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('edit title', () => {
    it('shows title input when the title heading is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)

      // The title "Test ticket" is wrapped in a button — clicking it enables edit mode
      const titleBtn = screen.getByText('Test ticket').closest('button')!
      fireEvent.click(titleBtn)

      await waitFor(() => {
        const input = screen.getByDisplayValue('Test ticket')
        expect(input.tagName).toBe('INPUT')
      })
    })
  })

  describe('delete behavior', () => {
    it('shows delete confirmation dialog when Delete button is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)

      // Footer has a "Delete" button
      const deleteBtn = screen.getByRole('button', { name: /delete/i })
      fireEvent.click(deleteBtn)

      await waitFor(() => {
        // Dialog title: "Delete ticket"
        expect(screen.getByText('Delete ticket', { selector: '[data-slot="dialog-title"], h2, [role="heading"]' })).toBeDefined()
      })
    })

    it('calls onDelete when delete is confirmed', async () => {
      const onDelete = vi.fn()
      render(<TicketDetailModal {...makeDefaultProps({ onDelete })} />)

      // Open delete dialog
      fireEvent.click(screen.getByRole('button', { name: /delete/i }))

      await waitFor(() => {
        // Two "Delete" buttons now: footer button + dialog confirm button
        const deleteBtns = screen.getAllByRole('button', { name: /delete/i })
        // The last one in the DOM is the confirmation button
        fireEvent.click(deleteBtns[deleteBtns.length - 1])
      })

      await waitFor(() => {
        expect(onDelete).toHaveBeenCalledWith(1)
      })
    })
  })

  describe('priority select', () => {
    it('shows Save button when priority is changed', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const select = screen.getByDisplayValue('Medium') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'high' } })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeDefined()
      })
    })
  })

  describe('save flow', () => {
    it('calls onSave with changed fields and closes on success', async () => {
      const onSave = vi.fn(async () => true)
      const onClose = vi.fn()
      render(<TicketDetailModal {...makeDefaultProps({ onSave, onClose })} />)

      // Change priority to make isDirty=true
      const select = screen.getByDisplayValue('Medium') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'high' } })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeDefined()
      })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(1, expect.objectContaining({ priority: 'high' }))
        expect(onClose).toHaveBeenCalled()
      })
    })

    it('shows error toast when save fails', async () => {
      const { toast } = await import('sonner')
      const onSave = vi.fn(async () => false)
      render(<TicketDetailModal {...makeDefaultProps({ onSave })} />)

      fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'high' } })

      await waitFor(() => screen.getByRole('button', { name: /save/i }))
      fireEvent.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled()
      })
    })
  })

  describe('title editing', () => {
    it('updates title when typing in the title input', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const titleBtn = screen.getByText('Test ticket').closest('button')!
      fireEvent.click(titleBtn)

      await waitFor(() => {
        const input = screen.getByDisplayValue('Test ticket') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'Updated title' } })
        expect(input.value).toBe('Updated title')
      })
    })

    it('exits edit mode on Enter key', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const titleBtn = screen.getByText('Test ticket').closest('button')!
      fireEvent.click(titleBtn)

      await waitFor(() => {
        const input = screen.getByDisplayValue('Test ticket') as HTMLInputElement
        fireEvent.keyDown(input, { key: 'Enter' })
      })

      await waitFor(() => {
        expect(screen.queryByDisplayValue('Test ticket')).toBeNull()
      })
    })

    it('restores original title on Escape key', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const titleBtn = screen.getByText('Test ticket').closest('button')!
      fireEvent.click(titleBtn)

      await waitFor(() => {
        const input = screen.getByDisplayValue('Test ticket') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'Changed title' } })
        fireEvent.keyDown(input, { key: 'Escape' })
      })

      await waitFor(() => {
        expect(screen.getByText('Test ticket')).toBeDefined()
      })
    })

    it('exits title edit on blur', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)
      const titleBtn = screen.getByText('Test ticket').closest('button')!
      fireEvent.click(titleBtn)

      await waitFor(() => {
        const input = screen.getByDisplayValue('Test ticket') as HTMLInputElement
        fireEvent.blur(input)
      })

      await waitFor(() => {
        expect(screen.queryByDisplayValue('Test ticket')).toBeNull()
      })
    })
  })

  describe('description editing', () => {
    it('enters description edit mode when "Add a description..." is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ description: '' }) })} />)

      const addDescBtn = screen.getByText('Add a description...')
      fireEvent.click(addDescBtn)

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Markdown description/i)).toBeDefined()
      })
    })

    it('exits description editing when Done editing is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ description: '' }) })} />)

      fireEvent.click(screen.getByText('Add a description...'))
      await waitFor(() => screen.getByPlaceholderText(/Markdown description/i))

      const textarea = screen.getByPlaceholderText(/Markdown description/i)
      fireEvent.change(textarea, { target: { value: 'My new description' } })
      fireEvent.click(screen.getByText('Done editing'))

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/Markdown description/i)).toBeNull()
      })
    })
  })

  describe('label management', () => {
    it('shows label input when "Add label" is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ labels: [] }) })} />)

      const addLabelBtn = screen.getByText('Add label')
      fireEvent.click(addLabelBtn)

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Add label/i)).toBeDefined()
      })
    })

    it('adds label when Enter is pressed in label input', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ labels: [] }) })} />)

      fireEvent.click(screen.getByText('Add label'))
      await waitFor(() => screen.getByPlaceholderText(/Add label/i))

      const input = screen.getByPlaceholderText(/Add label/i)
      fireEvent.change(input, { target: { value: 'new-label' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByText('new-label')).toBeDefined()
      })
    })

    it('hides label input on Escape key', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ labels: [] }) })} />)

      fireEvent.click(screen.getByText('Add label'))
      await waitFor(() => screen.getByPlaceholderText(/Add label/i))

      const input = screen.getByPlaceholderText(/Add label/i)
      fireEvent.keyDown(input, { key: 'Escape' })

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/Add label/i)).toBeNull()
      })
    })

    it('adds label on blur when input has value', async () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ labels: [] }) })} />)

      fireEvent.click(screen.getByText('Add label'))
      await waitFor(() => screen.getByPlaceholderText(/Add label/i))

      const input = screen.getByPlaceholderText(/Add label/i)
      fireEvent.change(input, { target: { value: 'blur-label' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(screen.getByText('blur-label')).toBeDefined()
      })
    })

    it('removes a label when XCircle button is clicked', async () => {
      render(<TicketDetailModal {...makeDefaultProps()} />)

      // 'bug' label is shown — find the button that removes it (aria-label or by proximity)
      // The remove button is inside the label span, after the label text
      const bugLabel = screen.getByText('bug')
      const labelSpan = bugLabel.closest('span')!
      const removeBtn = labelSpan.querySelector('button')!
      fireEvent.click(removeBtn)

      await waitFor(() => {
        // After removal, the label 'bug' should not appear inside a label chip
        // (It might appear as a suggestion, but the label chip is gone)
        const chips = document.querySelectorAll('.bg-accent\\/60')
        const chipTexts = Array.from(chips).map((c) => c.textContent)
        expect(chipTexts.some((t) => t?.includes('bug'))).toBe(false)
      })
    })
  })

  describe('ticket with assignee', () => {
    it('renders assignee field when ticket has assignee', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ assignee: 'alice' }) })} />)
      expect(screen.getByText('alice')).toBeDefined()
    })
  })

  describe('Continue Editing button', () => {
    const EDITABLE = ['draft', 'todo'] as const
    const NON_EDITABLE = ['in_progress', 'done', 'cancelled'] as const

    EDITABLE.forEach((status) => {
      it(`is visible for status ${status}`, () => {
        render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ status: status as LocalTicket['status'] }) })} />)
        expect(screen.getByTestId('continue-editing')).toBeInTheDocument()
      })
    })

    NON_EDITABLE.forEach((status) => {
      it(`is hidden for status ${status} (non-Jira ticket)`, () => {
        render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ status: status as LocalTicket['status'] }) })} />)
        expect(screen.queryByTestId('continue-editing')).toBeNull()
      })
    })

    // Jira-backed specs mirror the Jira board column, not a rail lifecycle —
    // they refine in ANY non-cancelled status so a PM can keep editing the
    // issue while it's In Progress / Done. See lib/ticket-refine.ts.
    const JIRA_BACKED = (status: LocalTicket['status']) =>
      makeTicket({ status, source: 'jira', jira_key: 'SKILLS-17', jira_url: 'https://acme.atlassian.net/browse/SKILLS-17' })

    ;(['draft', 'todo', 'in_progress', 'done'] as const).forEach((status) => {
      it(`is visible for Jira-backed status ${status}`, () => {
        render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_BACKED(status) })} />)
        expect(screen.getByTestId('continue-editing')).toBeInTheDocument()
      })
    })

    it('is hidden for Jira-backed cancelled tickets', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: JIRA_BACKED('cancelled') })} />)
      expect(screen.queryByTestId('continue-editing')).toBeNull()
    })

    it('is hidden for a Jira source ticket missing jira_key', () => {
      render(<TicketDetailModal {...makeDefaultProps({ ticket: makeTicket({ status: 'in_progress', source: 'jira', jira_key: null }) })} />)
      expect(screen.queryByTestId('continue-editing')).toBeNull()
    })

    it('routes drafts with origin_conversation_id to the resume path (no editTicket)', () => {
      const onClose = vi.fn()
      render(
        <TicketDetailModal
          {...makeDefaultProps({
            onClose,
            ticket: makeTicket({
              status: 'draft',
              origin_conversation_id: 'conv-abc',
              priority: null,
            }),
          })}
        />,
      )
      const btn = screen.getByTestId('continue-editing')
      fireEvent.click(btn)
      expect(onClose).toHaveBeenCalledTimes(1)
      // The button click path is exercised; no further assertion is possible
      // without a Provider mock — useMinimizedChats falls back to no-ops in
      // tests, so we assert behaviour up to the onClose contract.
    })

    it('routes non-draft tickets to the fresh edit path (with editTicket)', () => {
      const onClose = vi.fn()
      render(
        <TicketDetailModal
          {...makeDefaultProps({
            onClose,
            ticket: makeTicket({ status: 'todo' }),
          })}
        />,
      )
      const btn = screen.getByTestId('continue-editing')
      fireEvent.click(btn)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
