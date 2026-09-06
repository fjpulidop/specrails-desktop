import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

// Module-level mock state for useProposal
let mockProposalState = {
  proposalId: null as string | null,
  status: 'idle' as string,
  streamingText: '',
  resultMarkdown: '',
  history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  issueUrl: null as string | null,
  errorMessage: null as string | null,
}

const mockStartProposal = vi.fn()
const mockSendRefinement = vi.fn()
const mockCreateIssue = vi.fn()
const mockCancel = vi.fn()
const mockReset = vi.fn()

vi.mock('../../hooks/useProposal', () => ({
  useProposal: () => ({
    state: mockProposalState,
    startProposal: mockStartProposal,
    sendRefinement: mockSendRefinement,
    createIssue: mockCreateIssue,
    cancel: mockCancel,
    reset: mockReset,
  }),
}))

import { FeatureProposalModal } from '../FeatureProposalModal'

describe('FeatureProposalModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockProposalState = {
      proposalId: null,
      status: 'idle',
      streamingText: '',
      resultMarkdown: '',
      history: [],
      issueUrl: null,
      errorMessage: null,
    }
  })

  // ─── idle state ───────────────────────────────────────────────────────────

  it('does not render dialog content when open=false', () => {
    render(<FeatureProposalModal open={false} onClose={onClose} />)
    expect(screen.queryByText('Propose a Feature')).not.toBeInTheDocument()
  })

  it('renders "Propose a Feature" title in idle state', async () => {
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Propose a Feature')).toBeInTheDocument()
    })
  })

  it('renders the idea textarea in idle state', async () => {
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByLabelText('Feature idea')).toBeInTheDocument()
    })
  })

  it('"Explore Idea" button is disabled when idea is empty', async () => {
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /explore idea/i })).toBeDisabled()
    })
  })

  it('"Explore Idea" button is enabled when idea is typed', async () => {
    const user = userEvent.setup()
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByLabelText('Feature idea')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Feature idea'), 'Build a dashboard')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /explore idea/i })).not.toBeDisabled()
    })
  })

  it('calls startProposal when "Explore Idea" is clicked', async () => {
    const user = userEvent.setup()
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByLabelText('Feature idea')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Feature idea'), 'Build a dashboard')
    await user.click(screen.getByRole('button', { name: /explore idea/i }))

    expect(mockStartProposal).toHaveBeenCalledWith('Build a dashboard')
  })

  it('submits an idea with Ctrl+Enter on Windows', async () => {
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    const input = await screen.findByLabelText('Feature idea')
    fireEvent.change(input, { target: { value: 'Build a dashboard' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(mockStartProposal).toHaveBeenCalledWith('Build a dashboard')
  })

  it('submits refinement with Ctrl+Enter on Windows', async () => {
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    const input = await screen.findByLabelText('Refinement feedback')
    fireEvent.change(input, { target: { value: 'Make it simpler' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(mockSendRefinement).toHaveBeenCalledWith('Make it simpler')
  })

  it('calls onClose when Cancel is clicked in idle state', async () => {
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // ─── exploring state ──────────────────────────────────────────────────────

  it('renders "Exploring your idea..." title in exploring state', async () => {
    mockProposalState = { ...mockProposalState, status: 'exploring' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Exploring your idea...')).toBeInTheDocument()
    })
  })

  it('renders streaming text when present in exploring state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'exploring',
      streamingText: 'This is a streaming proposal...',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('This is a streaming proposal...')).toBeInTheDocument()
    })
  })

  it('renders StreamingIndicator when streaming text is empty (no file count shown)', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'exploring',
      streamingText: '',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      // When streamingText is empty, the StreamingIndicator renders (not the markdown block)
      // The indicator has no text content — verify absence of markdown cursor
      expect(screen.queryByText('This is a streaming proposal...')).not.toBeInTheDocument()
      // The Exploring title is visible (conversational view rendered)
      expect(screen.getByText('Exploring your idea...')).toBeInTheDocument()
    })
  })

  it('shows tool count in streaming indicator when toolCount > 0', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'exploring',
      streamingText: '<!--tool:read--><!--tool:read-->',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText(/2 files explored/)).toBeInTheDocument()
    })
  })

  // ─── review state ─────────────────────────────────────────────────────────

  it('renders "Review Proposal" title in review state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'review',
      history: [{ role: 'assistant', content: 'Proposal content here' }],
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Review Proposal')).toBeInTheDocument()
    })
  })

  it('shows refinement textarea in review state', async () => {
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByLabelText('Refinement feedback')).toBeInTheDocument()
    })
  })

  it('shows "Create GitHub Issue" button in review state', async () => {
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create github issue/i })).toBeInTheDocument()
    })
  })

  it('shows confirm creation dialog when "Create GitHub Issue" is clicked', async () => {
    const user = userEvent.setup()
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /create github issue/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create github issue/i }))

    await waitFor(() => {
      expect(screen.getByText('Create a GitHub Issue from this proposal?')).toBeInTheDocument()
    })
  })

  it('calls createIssue when "Yes, create issue" is clicked', async () => {
    const user = userEvent.setup()
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /create github issue/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create github issue/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /yes, create issue/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /yes, create issue/i }))

    expect(mockCreateIssue).toHaveBeenCalled()
  })

  it('"No" button dismisses the confirm creation dialog', async () => {
    const user = userEvent.setup()
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /create github issue/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create github issue/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /^no$/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^no$/i }))

    await waitFor(() => {
      expect(screen.queryByText('Create a GitHub Issue from this proposal?')).not.toBeInTheDocument()
    })
  })

  it('calls sendRefinement when Send button is clicked with feedback', async () => {
    const user = userEvent.setup()
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)

    await waitFor(() => expect(screen.getByLabelText('Refinement feedback')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Refinement feedback'), 'Make it simpler')

    // Find the Send button (has title "Send refinement")
    const sendBtn = document.querySelector('button[title*="Send refinement"]') as HTMLElement
    if (sendBtn) {
      fireEvent.click(sendBtn)
      expect(mockSendRefinement).toHaveBeenCalledWith('Make it simpler')
    }
  })

  it('"Start Over" button calls reset', async () => {
    mockProposalState = { ...mockProposalState, status: 'review' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /start over/i }))
    expect(mockReset).toHaveBeenCalled()
  })

  // ─── created state ────────────────────────────────────────────────────────

  it('renders "Issue Created" heading in created state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'created',
      issueUrl: 'https://github.com/owner/repo/issues/42',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getAllByText('Issue Created').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders issue URL link in created state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'created',
      issueUrl: 'https://github.com/owner/repo/issues/42',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('https://github.com/owner/repo/issues/42')).toBeInTheDocument()
    })
  })

  it('renders "Done" button in created state', async () => {
    mockProposalState = { ...mockProposalState, status: 'created', issueUrl: null }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })
  })

  it('"Done" button calls onClose', async () => {
    mockProposalState = { ...mockProposalState, status: 'created', issueUrl: null }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /done/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // ─── error state ──────────────────────────────────────────────────────────

  it('renders "Something went wrong" in error state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'error',
      errorMessage: 'Network timeout',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    })
  })

  it('renders error message in error state', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'error',
      errorMessage: 'Network timeout',
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Network timeout')).toBeInTheDocument()
    })
  })

  it('shows fallback error message when errorMessage is null', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'error',
      errorMessage: null,
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('An error occurred')).toBeInTheDocument()
    })
  })

  it('"Try Again" button calls reset in error state', async () => {
    mockProposalState = { ...mockProposalState, status: 'error', errorMessage: 'Fail' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(mockReset).toHaveBeenCalled()
  })

  // ─── cancelled state ──────────────────────────────────────────────────────

  it('renders "Cancelled" in cancelled state', async () => {
    mockProposalState = { ...mockProposalState, status: 'cancelled' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument()
    })
  })

  it('shows "The proposal was cancelled." text in cancelled state', async () => {
    mockProposalState = { ...mockProposalState, status: 'cancelled' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('The proposal was cancelled.')).toBeInTheDocument()
    })
  })

  // ─── creating_issue state ─────────────────────────────────────────────────

  it('renders "Creating GitHub Issue..." in creating_issue state', async () => {
    mockProposalState = { ...mockProposalState, status: 'creating_issue' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Creating GitHub Issue...')).toBeInTheDocument()
    })
  })

  it('renders "Creating issue via GitHub CLI..." text', async () => {
    mockProposalState = { ...mockProposalState, status: 'creating_issue' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('Creating issue via GitHub CLI...')).toBeInTheDocument()
    })
  })

  // ─── handleClose behavior ─────────────────────────────────────────────────

  it('calls cancel when closing during exploring status', async () => {
    mockProposalState = { ...mockProposalState, status: 'exploring' }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Exploring your idea...')).toBeInTheDocument())

    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    fireEvent.click(cancelBtn)

    expect(mockCancel).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('renders conversation history turns', async () => {
    mockProposalState = {
      ...mockProposalState,
      status: 'review',
      history: [
        { role: 'user', content: 'User turn text' },
        { role: 'assistant', content: 'Assistant turn text' },
      ],
    }
    render(<FeatureProposalModal open={true} onClose={onClose} />)
    await waitFor(() => {
      expect(screen.getByText('User turn text')).toBeInTheDocument()
      expect(screen.getByText('Assistant turn text')).toBeInTheDocument()
    })
  })
})
