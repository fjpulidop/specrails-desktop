import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { SpecCard } from '../SpecCard'
import type { LocalTicket } from '../../types'

// SpecCard uses useSortable from @dnd-kit/sortable — must be inside DndContext
// We mock the sortable hook to simplify rendering outside DndContext.
// `lastSortableOpts` records the options of the LAST useSortable call so tests
// can assert the drag-disabled gating (jiggle / on_review).
let lastSortableOpts: { id: number; disabled?: boolean } | null = null
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/sortable')>()
  return {
    ...mod,
    useSortable: (opts: { id: number; disabled?: boolean }) => {
      lastSortableOpts = opts
      return {
        attributes: {},
        listeners: {},
        setNodeRef: vi.fn(),
        transform: null,
        transition: undefined,
        isDragging: false,
      }
    },
  }
})

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}))

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 42,
    title: 'Build the feature',
    description: 'Some description',
    status: 'todo',
    priority: 'medium',
    labels: ['backend'],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'user',
    source: 'propose-spec',
    ...overrides,
  }
}

describe('SpecCard', () => {
  const onClickMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the ticket title', () => {
    render(<SpecCard ticket={makeTicket()} onClick={onClickMock} />)
    expect(screen.getByText('Build the feature')).toBeInTheDocument()
  })

  it('renders the ticket id', () => {
    render(<SpecCard ticket={makeTicket()} onClick={onClickMock} />)
    expect(screen.getByText('#42')).toBeInTheDocument()
  })

  it('renders the priority badge', () => {
    render(<SpecCard ticket={makeTicket({ priority: 'high' })} onClick={onClickMock} />)
    expect(screen.getByText('high')).toBeInTheDocument()
  })

  it('renders critical priority badge', () => {
    render(<SpecCard ticket={makeTicket({ priority: 'critical' })} onClick={onClickMock} />)
    expect(screen.getByText('critical')).toBeInTheDocument()
  })

  it('renders low priority badge', () => {
    render(<SpecCard ticket={makeTicket({ priority: 'low' })} onClick={onClickMock} />)
    expect(screen.getByText('low')).toBeInTheDocument()
  })

  it('renders a Review badge when needs_review is set', () => {
    render(<SpecCard ticket={makeTicket({ status: 'done', needs_review: true })} onClick={onClickMock} />)
    expect(screen.getByTestId('needs-review-badge-42')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('does not render a Review badge when needs_review is unset', () => {
    render(<SpecCard ticket={makeTicket({ status: 'done' })} onClick={onClickMock} />)
    expect(screen.queryByTestId('needs-review-badge-42')).not.toBeInTheDocument()
  })

  it('renders a Jira badge when jira_key is set', () => {
    render(<SpecCard ticket={makeTicket({ jira_key: 'ACME-7' })} onClick={onClickMock} />)
    const badge = screen.getByTestId('jira-badge-42')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('ACME-7')
  })

  it('calls onClick when card is clicked', () => {
    const ticket = makeTicket()
    render(<SpecCard ticket={ticket} onClick={onClickMock} />)
    fireEvent.click(screen.getByText('Build the feature'))
    expect(onClickMock).toHaveBeenCalledWith(ticket)
  })

  it('calls onClick when Enter key is pressed', () => {
    const ticket = makeTicket()
    render(<SpecCard ticket={ticket} onClick={onClickMock} />)
    const card = screen.getByText('Build the feature').closest('[role="button"]')!
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onClickMock).toHaveBeenCalledWith(ticket)
  })

  it('entire card surface is draggable (no separate grip handle)', () => {
    render(<SpecCard ticket={makeTicket()} onClick={onClickMock} />)
    const card = screen.getByText('Build the feature').closest('[role="button"]')!
    expect(card).toHaveClass('cursor-grab')
  })

  it('has correct accessibility role and tabIndex', () => {
    const ticket = makeTicket()
    render(<SpecCard ticket={ticket} onClick={onClickMock} />)
    const card = screen.getByText('Build the feature').closest('[role="button"]')!
    expect(card).toHaveAttribute('role', 'button')
    expect(card).toHaveAttribute('tabIndex', '0')
  })

  it('shows a breathing Contract badge while Contract Layer is being refined', () => {
    render(<SpecCard ticket={makeTicket()} onClick={onClickMock} contractRefining />)
    expect(screen.getByText('Contract')).toBeInTheDocument()
    const card = screen.getByText('Build the feature').closest('[role="button"]')!
    expect(card).toHaveAttribute('data-contract-refining', 'true')
    expect(card).toHaveClass('animate-pulse')
    expect(screen.queryByText('medium')).not.toBeInTheDocument()
  })

  describe('draft variant', () => {
    it('renders a Draft pill in place of the priority pill when status=draft', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'draft', priority: null })}
          onClick={onClickMock}
        />,
      )
      expect(screen.getByText('Draft')).toBeInTheDocument()
      expect(screen.queryByText('medium')).not.toBeInTheDocument()
      expect(screen.queryByText('high')).not.toBeInTheDocument()
    })

    it('marks the card with data-draft attribute', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'draft', priority: null })}
          onClick={onClickMock}
        />,
      )
      const card = screen.getByText('Build the feature').closest('[role="button"]')!
      expect(card).toHaveAttribute('data-draft', 'true')
    })

    it('uses semantic theme tokens (no brand-named colours like dracula-*)', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'draft', priority: null })}
          onClick={onClickMock}
        />,
      )
      const card = screen.getByText('Build the feature').closest('[role="button"]')!
      const html = card.outerHTML
      // Sanity: regression guard against hardcoded brand tokens
      expect(html).not.toMatch(/dracula-/)
      // Positive: at least one accent-* token applied
      expect(html).toMatch(/accent-secondary/)
    })

    it('hides priority pill when ticket.priority is null but status is not draft', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'todo', priority: null })}
          onClick={onClickMock}
        />,
      )
      expect(screen.queryByText('Draft')).not.toBeInTheDocument()
      expect(screen.queryByText('medium')).not.toBeInTheDocument()
    })
  })

  describe('on_review variant', () => {
    it('renders an On Review pill in place of the priority pill', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'on_review', priority: 'high' })}
          onClick={onClickMock}
        />,
      )
      expect(screen.getByTestId('on-review-badge-42')).toBeInTheDocument()
      expect(screen.getByText('On Review')).toBeInTheDocument()
      expect(screen.queryByText('high')).not.toBeInTheDocument()
    })

    it('marks the card with data-on-review and uses the accent-warning token', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'on_review' })}
          onClick={onClickMock}
        />,
      )
      const card = screen.getByText('Build the feature').closest('[role="button"]')!
      expect(card).toHaveAttribute('data-on-review', 'true')
      expect(card.outerHTML).toMatch(/accent-warning/)
      expect(card.outerHTML).not.toMatch(/dracula-/)
    })

    it('disables drag (frozen awaiting the PR decision) and drops the grab cursor', () => {
      render(
        <SpecCard
          ticket={makeTicket({ status: 'on_review' })}
          onClick={onClickMock}
        />,
      )
      expect(lastSortableOpts?.disabled).toBe(true)
      const card = screen.getByText('Build the feature').closest('[role="button"]')!
      expect(card.className).not.toContain('cursor-grab')
    })

    it('keeps drag enabled for a plain todo spec (regression pin)', () => {
      render(<SpecCard ticket={makeTicket({ status: 'todo' })} onClick={onClickMock} />)
      expect(lastSortableOpts?.disabled).toBe(false)
    })
  })

  describe('épica variant', () => {
    it('renders the épica badge with children count when is_epic=true', () => {
      render(
        <SpecCard
          ticket={makeTicket({ is_epic: true })}
          onClick={onClickMock}
          epicChildrenCount={4}
        />,
      )
      expect(screen.getByTestId('epic-badge-42')).toBeInTheDocument()
      expect(screen.getByText(/Epic · 4/)).toBeInTheDocument()
    })

    it('renders 0 hijos for an emptied épica', () => {
      render(
        <SpecCard
          ticket={makeTicket({ is_epic: true })}
          onClick={onClickMock}
          epicChildrenCount={0}
        />,
      )
      expect(screen.getByText(/Epic · 0/)).toBeInTheDocument()
    })

    it('uses accent-highlight semantic token for the épica badge', () => {
      const { container } = render(
        <SpecCard
          ticket={makeTicket({ is_epic: true })}
          onClick={onClickMock}
          epicChildrenCount={2}
        />,
      )
      expect(container.innerHTML).toMatch(/accent-highlight/)
      expect(container.innerHTML).not.toMatch(/dracula-/)
    })
  })

  describe('jiggle / long-press delete', () => {
    it('does NOT render the delete button when not in jiggle mode', () => {
      render(<SpecCard ticket={makeTicket()} onClick={onClickMock} jiggleMode={false} onDelete={vi.fn()} />)
      expect(screen.queryByTestId('spec-card-delete-42')).not.toBeInTheDocument()
    })

    it('renders the delete button when jiggleMode is true', () => {
      render(<SpecCard ticket={makeTicket()} onClick={onClickMock} jiggleMode={true} onDelete={vi.fn()} />)
      expect(screen.getByTestId('spec-card-delete-42')).toBeInTheDocument()
    })

    it('does NOT render the delete button without onDelete prop even in jiggle mode', () => {
      render(<SpecCard ticket={makeTicket()} onClick={onClickMock} jiggleMode={true} />)
      expect(screen.queryByTestId('spec-card-delete-42')).not.toBeInTheDocument()
    })

    it('applies the animate-jiggle class when jiggleMode is true', () => {
      render(<SpecCard ticket={makeTicket()} onClick={onClickMock} jiggleMode={true} onDelete={vi.fn()} />)
      const card = screen.getByText('Build the feature').closest('[role="button"]')!
      expect(card).toHaveClass('animate-jiggle')
      expect(card).toHaveAttribute('data-jiggle', 'true')
    })

    it('clicking the delete button fires onDelete with the ticket', () => {
      const onDelete = vi.fn()
      const ticket = makeTicket()
      render(<SpecCard ticket={ticket} onClick={onClickMock} jiggleMode={true} onDelete={onDelete} />)
      fireEvent.click(screen.getByTestId('spec-card-delete-42'))
      expect(onDelete).toHaveBeenCalledWith(ticket)
    })

    it('clicking the card body in jiggle mode does not open the modal', () => {
      render(<SpecCard ticket={makeTicket()} onClick={onClickMock} jiggleMode={true} onDelete={vi.fn()} />)
      fireEvent.click(screen.getByText('Build the feature'))
      expect(onClickMock).not.toHaveBeenCalled()
    })
  })

  describe('child-of-épica variant', () => {
    it('renders the parent épica pill when parent_epic_id is set and title resolves', () => {
      render(
        <SpecCard
          ticket={makeTicket({ id: 5, parent_epic_id: 42 })}
          onClick={onClickMock}
          parentEpicTitle="Real-time collab"
        />,
      )
      expect(screen.getByTestId('epic-child-pill-5')).toBeInTheDocument()
      expect(screen.getByText(/Real-time collab/)).toBeInTheDocument()
    })

    it('hides the parent pill when parent epic was deleted (parentEpicTitle null)', () => {
      render(
        <SpecCard
          ticket={makeTicket({ id: 5, parent_epic_id: 999 })}
          onClick={onClickMock}
          parentEpicTitle={null}
        />,
      )
      expect(screen.queryByTestId('epic-child-pill-5')).not.toBeInTheDocument()
    })

    it('uses accent-secondary semantic token for the child pill', () => {
      const { container } = render(
        <SpecCard
          ticket={makeTicket({ id: 5, parent_epic_id: 42 })}
          onClick={onClickMock}
          parentEpicTitle="X"
        />,
      )
      expect(container.innerHTML).toMatch(/accent-secondary/)
    })
  })

  describe('Raw badge', () => {
    it('renders a Raw badge for a free-prompt ticket', () => {
      render(<SpecCard ticket={makeTicket({ source: 'free-prompt' })} onClick={onClickMock} />)
      expect(screen.getByTestId('raw-badge-42')).toBeInTheDocument()
      expect(screen.getByText('Raw')).toBeInTheDocument()
    })

    it('shows the priority pill alongside the Raw badge', () => {
      render(<SpecCard ticket={makeTicket({ source: 'free-prompt', priority: 'high' })} onClick={onClickMock} />)
      expect(screen.getByTestId('raw-badge-42')).toBeInTheDocument()
      expect(screen.getByText('high')).toBeInTheDocument()
    })

    it('does not render a Raw badge for non-free-prompt tickets', () => {
      render(<SpecCard ticket={makeTicket({ source: 'propose-spec' })} onClick={onClickMock} />)
      expect(screen.queryByTestId('raw-badge-42')).not.toBeInTheDocument()
    })
  })
})
