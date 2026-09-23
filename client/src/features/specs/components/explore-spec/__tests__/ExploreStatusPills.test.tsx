import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ExploreStatusPills } from '../ExploreStatusPills'

describe('ExploreStatusPills', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('renders Connecting… when active and no system/tool/text yet', () => {
    render(<ExploreStatusPills active hasSystemEvent={false} hasToolUse={false} hasText={false} />)
    const pill = screen.getByTestId('explore-status-pill')
    expect(pill.dataset.stage).toBe('connecting')
    expect(pill.textContent).toContain('Connecting')
  })

  it('renders nothing when active is false', () => {
    const { container } = render(
      <ExploreStatusPills active={false} hasSystemEvent={false} hasToolUse={false} hasText={false} />,
    )
    expect(container.querySelector('[data-testid="explore-status-pill"]')).toBeNull()
  })

  it('unmounts when first text delta arrives', () => {
    const { rerender, container } = render(
      <ExploreStatusPills active hasSystemEvent hasToolUse={false} hasText={false} minDisplayMs={0} />,
    )
    act(() => { vi.advanceTimersByTime(10) })
    expect(container.querySelector('[data-testid="explore-status-pill"]')).not.toBeNull()
    rerender(<ExploreStatusPills active hasSystemEvent hasToolUse={false} hasText minDisplayMs={0} />)
    act(() => { vi.advanceTimersByTime(10) })
    expect(container.querySelector('[data-testid="explore-status-pill"]')).toBeNull()
  })

  it('progresses connecting → thinking → tool when flags arrive', () => {
    const { rerender } = render(
      <ExploreStatusPills active hasSystemEvent={false} hasToolUse={false} hasText={false} minDisplayMs={0} />,
    )
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('connecting')
    rerender(<ExploreStatusPills active hasSystemEvent hasToolUse={false} hasText={false} minDisplayMs={0} />)
    act(() => { vi.advanceTimersByTime(10) })
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('thinking')
    rerender(<ExploreStatusPills active hasSystemEvent hasToolUse hasText={false} minDisplayMs={0} />)
    act(() => { vi.advanceTimersByTime(10) })
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('tool')
  })

  it('enforces minimum display time before advancing stage', () => {
    const { rerender } = render(
      <ExploreStatusPills active hasSystemEvent={false} hasToolUse={false} hasText={false} minDisplayMs={200} />,
    )
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('connecting')
    // Stage flips upstream immediately but UI must wait the threshold.
    rerender(<ExploreStatusPills active hasSystemEvent hasToolUse={false} hasText={false} minDisplayMs={200} />)
    act(() => { vi.advanceTimersByTime(50) })
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('connecting')
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByTestId('explore-status-pill').dataset.stage).toBe('thinking')
  })
})
