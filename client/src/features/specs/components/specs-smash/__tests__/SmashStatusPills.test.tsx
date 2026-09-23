import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SmashStatusPills } from '../SmashStatusPills'

describe('SmashStatusPills', () => {
  it('renders nothing when stage is null', () => {
    const { container } = render(<SmashStatusPills stage={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the analyzing pill', () => {
    render(<SmashStatusPills stage="analyzing" />)
    expect(screen.getByTestId('smash-status-pills')).toBeInTheDocument()
    expect(screen.getByText(/Analyzing spec/)).toBeInTheDocument()
  })

  it('renders the identifying pill', () => {
    render(<SmashStatusPills stage="identifying" />)
    expect(screen.getByText(/Identifying subtasks/)).toBeInTheDocument()
  })

  it('renders the ordering pill', () => {
    render(<SmashStatusPills stage="ordering" />)
    expect(screen.getByText(/Ordering execution/)).toBeInTheDocument()
  })

  it('updates label when stage prop transitions immediately with minDisplayMs=0', async () => {
    const { rerender } = render(<SmashStatusPills stage="analyzing" minDisplayMs={0} />)
    expect(screen.getByText(/Analyzing spec/)).toBeInTheDocument()
    rerender(<SmashStatusPills stage="ordering" minDisplayMs={0} />)
    // The async setTimeout(0) fires on next tick — wait for it.
    await waitFor(() => {
      expect(screen.getByText(/Ordering execution/)).toBeInTheDocument()
    }, { timeout: 1000 })
  })
})
