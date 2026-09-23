import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../test-utils'
import { ProjectErrorBoundary } from '../features/projects/components/ProjectErrorBoundary'

function NormalChild() {
  return <div>Child content</div>
}

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test render error')
  return <div>Recovered</div>
}

describe('ProjectErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ProjectErrorBoundary>
        <NormalChild />
      </ProjectErrorBoundary>
    )
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('shows error UI when a child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ProjectErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ProjectErrorBoundary>
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()

    consoleSpy.mockRestore()
  })

  it('shows the project name in the error UI when provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ProjectErrorBoundary projectName="My Awesome Project">
        <ThrowingChild shouldThrow={true} />
      </ProjectErrorBoundary>
    )

    expect(screen.getByText(/My Awesome Project/)).toBeInTheDocument()

    consoleSpy.mockRestore()
  })

  it('does not show project name when not provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ProjectErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ProjectErrorBoundary>
    )

    expect(screen.queryByText(/An error occurred in/)).not.toBeInTheDocument()

    consoleSpy.mockRestore()
  })

  it('shows children again after retry when the error is resolved', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let shouldThrow = true
    function MaybeThrow() {
      if (shouldThrow) throw new Error('transient error')
      return <div>Recovered</div>
    }

    render(
      <ProjectErrorBoundary>
        <MaybeThrow />
      </ProjectErrorBoundary>
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()

    // Resolve the error condition, then click retry
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(screen.getByText('Recovered')).toBeInTheDocument()

    consoleSpy.mockRestore()
  })
})
