import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { RailControls } from '../RailControls'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

const defaultProps = {
  mode: 'implement' as const,
  status: 'idle' as const,
  ticketCount: 2,
  onModeChange: vi.fn(),
  onToggle: vi.fn(),
}

describe('RailControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the play button (mode selection moved to the rail Loop picker)', () => {
    render(<RailControls {...defaultProps} />)
    expect(screen.getByTitle('Play')).toBeInTheDocument()
    // The old mode segmented control is gone — RailControls no longer renders it.
    expect(screen.queryByText('Implement')).not.toBeInTheDocument()
    expect(screen.queryByText('Batch')).not.toBeInTheDocument()
  })

  it('calls onToggle when play button clicked', () => {
    render(<RailControls {...defaultProps} />)
    fireEvent.click(screen.getByTitle('Play'))
    expect(defaultProps.onToggle).toHaveBeenCalled()
  })

  it('shows Stop button while running', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-1" />)
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
  })

  it('shows View Log button while running with activeJobId', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-42" />)
    expect(screen.getByTitle('View job log')).toBeInTheDocument()
  })

  it('navigates to job log when View Log clicked', () => {
    render(<RailControls {...defaultProps} status="running" activeJobId="job-42" />)
    fireEvent.click(screen.getByTitle('View job log'))
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-42')
  })

  it('does not show View Log button when idle', () => {
    render(<RailControls {...defaultProps} status="idle" activeJobId="job-42" />)
    expect(screen.queryByTitle('View job log')).not.toBeInTheDocument()
  })

  it('does not show View Log button when running but no activeJobId', () => {
    render(<RailControls {...defaultProps} status="running" />)
    expect(screen.queryByTitle('View job log')).not.toBeInTheDocument()
  })

  it('shows failed state with retry title', () => {
    render(<RailControls {...defaultProps} status="failed" />)
    expect(screen.getByTitle('Job failed — click to retry')).toBeInTheDocument()
  })

  it('disables play button when no tickets', () => {
    render(<RailControls {...defaultProps} ticketCount={0} />)
    expect(screen.getByTitle('Add specs to this rail first')).toBeInTheDocument()
  })

  describe('Interactive toggle (removed — jobs are interactive by default)', () => {
    it('never renders a switch, even for ultracode rails', () => {
      render(<RailControls {...defaultProps} mode="ultracode" ultracodeAvailable />)
      expect(screen.queryByRole('switch')).toBeNull()
    })
  })
})
