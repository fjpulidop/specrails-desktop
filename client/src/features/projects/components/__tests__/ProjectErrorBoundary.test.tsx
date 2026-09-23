import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { ProjectErrorBoundary } from '../ProjectErrorBoundary'

// Component that throws an error, used to trigger error boundary
function BrokenComponent({ shouldThrow }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test render error')
  }
  return <div>Normal content</div>
}

describe('ProjectErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress console.error from error boundary componentDidCatch
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders children when no error occurs', () => {
    render(
      <ProjectErrorBoundary>
        <div>Child content</div>
      </ProjectErrorBoundary>
    )
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('renders "Something went wrong" when child throws', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('does not render children when error occurs', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.queryByText('Normal content')).not.toBeInTheDocument()
  })

  it('renders error message from thrown error', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.getByText('Test render error')).toBeInTheDocument()
  })

  it('renders Retry button when error occurs', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('renders projectName in error message when provided', () => {
    render(
      <ProjectErrorBoundary projectName="My Project">
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.getByText('My Project')).toBeInTheDocument()
    expect(screen.getByText(/An error occurred in/)).toBeInTheDocument()
  })

  it('does not render "An error occurred in" when projectName is not provided', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(screen.queryByText(/An error occurred in/)).not.toBeInTheDocument()
  })

  it('resets error state when Retry is clicked', () => {
    // We need a component that can be toggled
    const { rerender } = render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    // After retry, error state clears — children render again (but still broken in this test)
    // The boundary re-renders children, which throws again → back to error state
    // What we can verify is that the click doesn't throw and the boundary is still rendered
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('shows children again after Retry when child no longer throws', () => {
    let shouldThrow = true

    function ToggleComponent() {
      if (shouldThrow) throw new Error('toggle error')
      return <div>Recovery content</div>
    }

    render(
      <ProjectErrorBoundary>
        <ToggleComponent />
      </ProjectErrorBoundary>
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()

    // Fix the component before retry
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(screen.getByText('Recovery content')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
  })

  it('calls console.error in componentDidCatch', () => {
    render(
      <ProjectErrorBoundary>
        <BrokenComponent shouldThrow={true} />
      </ProjectErrorBoundary>
    )
    expect(console.error).toHaveBeenCalled()
  })
})
