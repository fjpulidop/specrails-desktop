import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../../test-utils'

// Mock the Jira API client — discardSpec resolves by default.
vi.mock('../../../lib/jira-api', () => ({
  jiraApi: {
    discardSpec: vi.fn(async () => ({ ok: true })),
  },
}))
// Mock sonner toasts.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { DiscardSpecDialog } from '../DiscardSpecDialog'
import { jiraApi } from '../../../lib/jira-api'
import { toast } from 'sonner'

function makeProps(overrides: Partial<React.ComponentProps<typeof DiscardSpecDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    ticket: { id: 7, title: 'My spec', jira_key: 'PROJ-7' },
    discardStatus: 'Cancelled',
    onDiscarded: vi.fn(),
    ...overrides,
  }
}

describe('DiscardSpecDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the title and body for the configured discard status', () => {
    render(<DiscardSpecDialog {...makeProps()} />)
    expect(screen.getByTestId('jira-discard-dialog')).toBeInTheDocument()
    // Title interpolates the status; body interpolates status + key.
    expect(screen.getByText('Move spec to Cancelled?')).toBeInTheDocument()
    expect(screen.getByText(/This spec's Jira issue PROJ-7 will be moved to/)).toBeInTheDocument()
  })

  it('confirms with the typed comment and calls onDiscarded', async () => {
    const onOpenChange = vi.fn()
    const onDiscarded = vi.fn()
    render(<DiscardSpecDialog {...makeProps({ onOpenChange, onDiscarded })} />)

    const textarea = screen.getByTestId('jira-discard-comment')
    fireEvent.change(textarea, { target: { value: 'Out of scope' } })

    fireEvent.click(screen.getByTestId('jira-discard-confirm'))

    await waitFor(() => {
      expect(jiraApi.discardSpec).toHaveBeenCalledWith(7, 'Out of scope')
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onDiscarded).toHaveBeenCalled()
    })
  })

  it('passes null when the comment is empty/whitespace-only', async () => {
    render(<DiscardSpecDialog {...makeProps()} />)

    const textarea = screen.getByTestId('jira-discard-comment')
    fireEvent.change(textarea, { target: { value: '   ' } })

    fireEvent.click(screen.getByTestId('jira-discard-confirm'))

    await waitFor(() => {
      expect(jiraApi.discardSpec).toHaveBeenCalledWith(7, null)
    })
  })

  it('closes via Cancel without calling discardSpec', () => {
    const onOpenChange = vi.fn()
    const onDiscarded = vi.fn()
    render(<DiscardSpecDialog {...makeProps({ onOpenChange, onDiscarded })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(jiraApi.discardSpec).not.toHaveBeenCalled()
    expect(onDiscarded).not.toHaveBeenCalled()
  })

  it('surfaces an error toast when discardSpec rejects', async () => {
    ;(jiraApi.discardSpec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const onDiscarded = vi.fn()
    render(<DiscardSpecDialog {...makeProps({ onDiscarded })} />)

    fireEvent.click(screen.getByTestId('jira-discard-confirm'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    expect(onDiscarded).not.toHaveBeenCalled()
  })
})
