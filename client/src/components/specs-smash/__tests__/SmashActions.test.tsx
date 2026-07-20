import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { SmashActions, ticketCanSmash } from '../SmashActions'
import type { LocalTicket } from '../../../types'

// Mock the SmashTracker context's hook so tests don't need a real WS provider.
vi.mock('../../../context/SmashTrackerContext', () => ({
  useSmashInflight: () => null,
}))

// Mock origin to avoid import-time errors.
vi.mock('../../../lib/origin', () => ({
  API_ORIGIN: '',
}))

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1,
    title: 'Big spec',
    description: 'body\n\n## Contract Layer\n\nstuff',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    created_at: '2026-05-16T00:00:00Z',
    updated_at: '2026-05-16T00:00:00Z',
    created_by: 'test',
    source: 'manual',
    ...overrides,
  }
}

describe('ticketCanSmash', () => {
  it('approves a committed ticket with Contract Layer', () => {
    expect(ticketCanSmash(makeTicket(), true)).toBe(true)
  })
  it('rejects when feature flag is off', () => {
    expect(ticketCanSmash(makeTicket(), false)).toBe(false)
  })
  it('rejects drafts', () => {
    expect(ticketCanSmash(makeTicket({ status: 'draft' }), true)).toBe(false)
  })
  it('rejects child tickets', () => {
    expect(ticketCanSmash(makeTicket({ parent_epic_id: 99 }), true)).toBe(false)
  })
  it('rejects when no Contract Layer in description', () => {
    expect(ticketCanSmash(makeTicket({ description: 'plain' }), true)).toBe(false)
  })
})

describe('SmashActions', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ scheduled: true }) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('renders nothing when ticket is ineligible', () => {
    const { container } = render(
      <SmashActions
        ticket={makeTicket({ description: 'no contract' })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={0}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the SMASH button for eligible tickets', () => {
    render(
      <SmashActions ticket={makeTicket()} projectId="p" provider="claude" featureFlagOn childrenCount={0} />,
    )
    expect(screen.getByTestId('smash-button')).toBeInTheDocument()
  })

  it('clicking SMASH opens the confirm modal', () => {
    render(<SmashActions ticket={makeTicket()} projectId="p" provider="claude" featureFlagOn childrenCount={0} />)
    fireEvent.click(screen.getByTestId('smash-button'))
    expect(screen.getByTestId('smash-confirm-modal')).toBeInTheDocument()
    expect(screen.getByTestId('smash-mode-simple')).toBeInTheDocument()
    expect(screen.getByTestId('smash-mode-full')).toBeInTheDocument()
  })

  it('Cancel in modal returns to idle', () => {
    render(<SmashActions ticket={makeTicket()} projectId="p" provider="claude" featureFlagOn childrenCount={0} />)
    fireEvent.click(screen.getByTestId('smash-button'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByTestId('smash-confirm-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('smash-button')).toBeInTheDocument()
  })

  it('Continue in modal POSTs to the smash endpoint with mode=simple by default', async () => {
    render(<SmashActions ticket={makeTicket()} projectId="p" provider="claude" featureFlagOn childrenCount={0} />)
    fireEvent.click(screen.getByTestId('smash-button'))
    fireEvent.click(screen.getByTestId('smash-confirm-modal-continue'))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/p/tickets/1/smash'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"mode":"simple"'),
      }),
    )
  })

  it('selecting Full mode POSTs with mode=full', async () => {
    render(<SmashActions ticket={makeTicket()} projectId="p" provider="claude" featureFlagOn childrenCount={0} />)
    fireEvent.click(screen.getByTestId('smash-button'))
    fireEvent.click(screen.getByTestId('smash-mode-full'))
    fireEvent.click(screen.getByTestId('smash-confirm-modal-continue'))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/p/tickets/1/smash'),
      expect.objectContaining({
        body: expect.stringContaining('"mode":"full"'),
      }),
    )
  })

  it('renders Re-SMASH button for an épica', () => {
    render(
      <SmashActions
        ticket={makeTicket({ is_epic: true })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={3}
      />,
    )
    expect(screen.getByTestId('resmash-button')).toBeInTheDocument()
  })

  it('Re-SMASH on an épica with children opens modal with delete warning', () => {
    render(
      <SmashActions
        ticket={makeTicket({ is_epic: true })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={4}
      />,
    )
    fireEvent.click(screen.getByTestId('resmash-button'))
    expect(screen.getByTestId('smash-confirm-modal')).toBeInTheDocument()
    expect(screen.getByText(/delete the/)).toBeInTheDocument()
  })

  it('Re-SMASH on empty épica opens modal (no delete warning)', () => {
    render(
      <SmashActions
        ticket={makeTicket({ is_epic: true })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={0}
      />,
    )
    fireEvent.click(screen.getByTestId('resmash-button'))
    expect(screen.getByTestId('smash-confirm-modal')).toBeInTheDocument()
    expect(screen.queryByText(/delete the/)).not.toBeInTheDocument()
  })

  it('Kimi never renders Re-SMASH or executes a child DELETE', () => {
    const { container } = render(
      <SmashActions
        ticket={makeTicket({ is_epic: true })}
        projectId="p"
        provider="kimi"
        featureFlagOn
        childrenCount={4}
      />,
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('resmash-button')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed while resolving a ticket origin and keeps Re-SMASH hidden for a Kimi-origin ticket in a Claude-primary project', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ conversation: { provider: 'kimi' } }),
    } as Response)

    render(
      <SmashActions
        ticket={makeTicket({ is_epic: true, origin_conversation_id: 'conv-kimi' })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={4}
      />,
    )

    // No optimistic flash before the provider lookup resolves.
    expect(screen.queryByTestId('resmash-button')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p/chat/conversations/conv-kimi'),
      )
    })
    expect(screen.queryByTestId('resmash-button')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('interprets a NULL origin-conversation provider as the project primary', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ conversation: { provider: null } }),
    } as Response)

    render(
      <SmashActions
        ticket={makeTicket({ is_epic: true, origin_conversation_id: 'conv-primary' })}
        projectId="p"
        provider="claude"
        featureFlagOn
        childrenCount={0}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('resmash-button')).toBeInTheDocument())
  })
})
