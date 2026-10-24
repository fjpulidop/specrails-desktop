import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Skeleton } from '../skeleton'
import { LiveDot } from '../live-dot'
import { EmptyState } from '../empty-state'

describe('Skeleton', () => {
  it('renders a hidden shimmer block with caller sizing', () => {
    const { container } = render(<Skeleton className="h-20" />)
    const el = container.querySelector('[data-skeleton]')
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).toHaveClass('u-skeleton', 'h-20')
  })
})

describe('LiveDot', () => {
  it('shows a soft ring while pulsing and forwards a11y props', () => {
    const { container } = render(<LiveDot aria-label="Working" data-testid="dot" />)
    expect(screen.getByTestId('dot')).toHaveAttribute('aria-label', 'Working')
    expect(container.querySelector('[data-live-ring]')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('animate-ping')
  })

  it('omits the ring when not pulsing and honours a custom dot class', () => {
    const { container } = render(<LiveDot pulsing={false} dotClassName="bg-accent-info" />)
    expect(container.querySelector('[data-live-ring]')).toBeNull()
    expect(container.querySelector('.bg-accent-info')).toBeInTheDocument()
  })
})

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    render(<EmptyState title="Nothing here" description="Add one to start" action={<button>Add</button>} />)
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('Add one to start')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('works with only a title', () => {
    render(<EmptyState title="Empty" />)
    expect(screen.getByText('Empty')).toBeInTheDocument()
  })
})
