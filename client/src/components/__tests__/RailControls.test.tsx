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

  it('renders mode buttons and play button', () => {
    render(<RailControls {...defaultProps} />)
    expect(screen.getByText('Implement')).toBeInTheDocument()
    expect(screen.getByText('Batch')).toBeInTheDocument()
    expect(screen.getByTitle('Play')).toBeInTheDocument()
  })

  it('calls onModeChange when mode buttons clicked', () => {
    render(<RailControls {...defaultProps} />)
    fireEvent.click(screen.getByText('Batch'))
    expect(defaultProps.onModeChange).toHaveBeenCalledWith('batch-implement')
    fireEvent.click(screen.getByText('Implement'))
    expect(defaultProps.onModeChange).toHaveBeenCalledWith('implement')
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

  it('hides the Ultra segment by default', () => {
    render(<RailControls {...defaultProps} />)
    expect(screen.queryByText('Ultra')).not.toBeInTheDocument()
  })

  it('shows the Ultra segment when ultracodeAvailable', () => {
    render(<RailControls {...defaultProps} ultracodeAvailable />)
    expect(screen.getByText('Ultra')).toBeInTheDocument()
  })

  it('calls onModeChange with ultracode when Ultra clicked', () => {
    render(<RailControls {...defaultProps} ultracodeAvailable />)
    fireEvent.click(screen.getByText('Ultra'))
    expect(defaultProps.onModeChange).toHaveBeenCalledWith('ultracode')
  })

  describe('Interactive toggle', () => {
    it('shows only for ultracode mode when ultracode + interactive are available', () => {
      const { rerender } = render(
        <RailControls {...defaultProps} mode="implement" ultracodeAvailable interactiveAvailable />,
      )
      expect(screen.queryByRole('switch')).toBeNull()
      rerender(<RailControls {...defaultProps} mode="ultracode" ultracodeAvailable interactiveAvailable />)
      expect(screen.getByRole('switch')).toBeInTheDocument()
    })

    it('hidden when interactiveAvailable is false', () => {
      render(<RailControls {...defaultProps} mode="ultracode" ultracodeAvailable interactiveAvailable={false} />)
      expect(screen.queryByRole('switch')).toBeNull()
    })

    it('hidden while the rail is running', () => {
      render(<RailControls {...defaultProps} mode="ultracode" status="running" ultracodeAvailable interactiveAvailable />)
      expect(screen.queryByRole('switch')).toBeNull()
    })

    it('reflects checked state and toggles via onInteractiveChange', () => {
      const onInteractiveChange = vi.fn()
      const { rerender } = render(
        <RailControls {...defaultProps} mode="ultracode" ultracodeAvailable interactiveAvailable interactive={false} onInteractiveChange={onInteractiveChange} />,
      )
      const sw = screen.getByRole('switch')
      expect(sw).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(sw)
      expect(onInteractiveChange).toHaveBeenCalledWith(true)
      rerender(
        <RailControls {...defaultProps} mode="ultracode" ultracodeAvailable interactiveAvailable interactive onInteractiveChange={onInteractiveChange} />,
      )
      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    })
  })
})
