import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { TicketStatusDot, TicketStatusBadge } from '../TicketStatusIndicator'

describe('TicketStatusDot', () => {
  it('renders with aria-label "Todo" for todo status', () => {
    render(<TicketStatusDot status="todo" />)
    expect(screen.getByLabelText('Todo')).toBeDefined()
  })

  it('renders with aria-label "In progress" for in_progress status', () => {
    render(<TicketStatusDot status="in_progress" />)
    expect(screen.getByLabelText('In progress')).toBeDefined()
  })

  it('renders with aria-label "Done" for done status', () => {
    render(<TicketStatusDot status="done" />)
    expect(screen.getByLabelText('Done')).toBeDefined()
  })

  it('renders with aria-label "Cancelled" for cancelled status', () => {
    render(<TicketStatusDot status="cancelled" />)
    expect(screen.getByLabelText('Cancelled')).toBeDefined()
  })

  it('renders with aria-label "On review" for on_review status', () => {
    render(<TicketStatusDot status="on_review" />)
    expect(screen.getByLabelText('On review')).toBeDefined()
  })
})

describe('TicketStatusBadge', () => {
  it('renders "Todo" label for todo status', () => {
    render(<TicketStatusBadge status="todo" />)
    expect(screen.getByText('Todo')).toBeDefined()
  })

  it('renders "In progress" label for in_progress status', () => {
    render(<TicketStatusBadge status="in_progress" />)
    expect(screen.getByText('In progress')).toBeDefined()
  })

  it('renders "Done" label for done status', () => {
    render(<TicketStatusBadge status="done" />)
    expect(screen.getByText('Done')).toBeDefined()
  })

  it('renders "Cancelled" label for cancelled status', () => {
    render(<TicketStatusBadge status="cancelled" />)
    expect(screen.getByText('Cancelled')).toBeDefined()
  })

  it('renders "On review" label with the accent-review variant for on_review status', () => {
    render(<TicketStatusBadge status="on_review" />)
    const badge = screen.getByText('On review')
    expect(badge).toBeDefined()
    expect(badge.className).toContain('text-accent-review')
  })
})

describe('on_review lamp canon', () => {
  it('draws the dot and the badge with the review token, never amber', () => {
    const { container, unmount } = render(<TicketStatusDot status="on_review" />)
    expect(container.innerHTML).toContain('bg-accent-review')
    expect(container.innerHTML).not.toContain('accent-warning')
    unmount()
    const badge = render(<TicketStatusBadge status="on_review" />)
    expect(badge.container.innerHTML).toContain('text-accent-review')
    expect(badge.container.innerHTML).not.toContain('accent-warning')
  })
})

describe('run-state vocabulary', () => {
  it('draws a cancelled spec as stopped (muted slash), never a red X', () => {
    const { container } = render(<TicketStatusDot status="cancelled" />)
    expect(container.querySelector('[data-run-state="stopped"]')).not.toBeNull()
    expect(container.querySelector('.lucide-circle-slash')).not.toBeNull()
    expect(container.innerHTML).not.toContain('destructive')
    const badge = render(<TicketStatusBadge status="cancelled" />)
    expect(badge.container.innerHTML).toContain('text-muted-foreground')
    expect(badge.container.innerHTML).not.toContain('destructive')
  })

  it('draws a done spec with the success CheckCircle2', () => {
    const { container } = render(<TicketStatusDot status="done" />)
    expect(container.querySelector('[data-run-state="done"]')).toHaveClass('text-accent-success')
  })

  it('pulses an in-progress spec with the info lamp', () => {
    const { container } = render(<TicketStatusDot status="in_progress" />)
    expect(container.querySelector('[data-live-ring]')).not.toBeNull()
    expect(container.innerHTML).toContain('bg-accent-info')
  })
})
