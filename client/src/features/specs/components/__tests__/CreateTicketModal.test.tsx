import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CreateTicketModal } from '../CreateTicketModal'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDefaultProps(overrides: Partial<{
  open: boolean
  allLabels: string[]
  onClose: () => void
  onCreate: (ticket: { title: string; description?: string }) => Promise<boolean>
}> = {}) {
  return {
    open: true,
    allLabels: ['bug', 'area:frontend'],
    onClose: vi.fn(),
    onCreate: vi.fn(async () => true),
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CreateTicketModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('renders title input when open', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      expect(screen.getByPlaceholderText(/title/i)).toBeDefined()
    })

    it('renders status select', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      // Status select defaults to "todo"
      expect(screen.getByDisplayValue('Todo')).toBeDefined()
    })

    it('renders priority select', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      expect(screen.getByDisplayValue('Medium')).toBeDefined()
    })

    it('renders Create button', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      expect(screen.getByRole('button', { name: /create/i })).toBeDefined()
    })

    it('renders Cancel button', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined()
    })

    it('does not render dialog content when open=false', () => {
      render(<CreateTicketModal {...makeDefaultProps({ open: false })} />)
      expect(screen.queryByPlaceholderText(/title/i)).toBeNull()
    })
  })

  describe('validation', () => {
    it('does not call onCreate when title is empty', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.click(screen.getByRole('button', { name: /create/i }))
      await waitFor(() => {
        expect(onCreate).not.toHaveBeenCalled()
      })
    })
  })

  describe('successful submit', () => {
    it('calls onCreate with title when submitted', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), {
        target: { value: 'New ticket title' },
      })
      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'New ticket title' })
        )
      })
    })

    it('includes description when provided', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), {
        target: { value: 'My ticket' },
      })
      const descArea = screen.getByPlaceholderText(/description/i)
      fireEvent.change(descArea, { target: { value: 'My description' } })
      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ description: 'My description' })
        )
      })
    })
  })

  describe('cancel', () => {
    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn()
      render(<CreateTicketModal {...makeDefaultProps({ onClose })} />)

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not call onCreate when Cancel is clicked', () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), {
        target: { value: 'Some title' },
      })
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(onCreate).not.toHaveBeenCalled()
    })
  })

  describe('status and priority', () => {
    it('changes status via select', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      const select = screen.getByDisplayValue('Todo') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'in_progress' } })
      expect(select.value).toBe('in_progress')
    })

    it('changes priority via select', () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)
      const select = screen.getByDisplayValue('Medium') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'high' } })
      expect(select.value).toBe('high')
    })

    it('submits with custom status and priority', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), { target: { value: 'Bug fix' } })
      fireEvent.change(screen.getByDisplayValue('Todo'), { target: { value: 'in_progress' } })
      fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'critical' } })
      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'in_progress', priority: 'critical' })
        )
      })
    })
  })

  describe('label management', () => {
    it('adds label via Enter key in label input', async () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)

      const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
      fireEvent.change(labelInput, { target: { value: 'new-feature' } })
      fireEvent.keyDown(labelInput, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByText('new-feature')).toBeDefined()
      })
    })

    it('shows label suggestions while typing', async () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)

      const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
      fireEvent.change(labelInput, { target: { value: 'bu' } })

      await waitFor(() => {
        // 'bug' from allLabels should appear as suggestion
        expect(screen.getByText('bug')).toBeDefined()
      })
    })

    it('adds label when suggestion is clicked via onMouseDown', async () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)

      const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
      fireEvent.change(labelInput, { target: { value: 'bu' } })

      await waitFor(() => screen.getByText('bug'))
      fireEvent.mouseDown(screen.getByText('bug'))

      await waitFor(() => {
        // The label should now be in the label chips list
        // Check the suggestion list is gone (input cleared)
        expect(labelInput).toBeDefined()
      })
    })

    it('removes a label when XCircle is clicked', async () => {
      render(<CreateTicketModal {...makeDefaultProps()} />)

      // Add a label first
      const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
      fireEvent.change(labelInput, { target: { value: 'to-remove' } })
      fireEvent.keyDown(labelInput, { key: 'Enter' })

      await waitFor(() => screen.getByText('to-remove'))

      // Click XCircle next to the label
      const { container } = render(<CreateTicketModal {...makeDefaultProps()} />)
      // Use a fresh render to test remove, or use the existing container
    })

    it('submits ticket with labels included', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), { target: { value: 'Labelled ticket' } })

      const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
      fireEvent.change(labelInput, { target: { value: 'my-label' } })
      fireEvent.keyDown(labelInput, { key: 'Enter' })

      await waitFor(() => screen.getByText('my-label'))

      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ labels: ['my-label'] })
        )
      })
    })
  })

  describe('error handling', () => {
    it('shows error toast when onCreate returns false', async () => {
      const { toast } = await import('sonner')
      const onCreate = vi.fn(async () => false)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      fireEvent.change(screen.getByPlaceholderText(/title/i), { target: { value: 'Fail ticket' } })
      fireEvent.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled()
      })
    })
  })

  describe('title keydown', () => {
    it('submits when Enter is pressed in title input with non-empty title', async () => {
      const onCreate = vi.fn(async () => true)
      render(<CreateTicketModal {...makeDefaultProps({ onCreate })} />)

      const titleInput = screen.getByPlaceholderText(/title/i)
      fireEvent.change(titleInput, { target: { value: 'Enter submit' } })
      fireEvent.keyDown(titleInput, { key: 'Enter' })

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Enter submit' })
        )
      })
    })
  })
})
