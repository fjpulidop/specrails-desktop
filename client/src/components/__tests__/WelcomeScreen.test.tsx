import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { WelcomeScreen } from '../WelcomeScreen'

describe('WelcomeScreen', () => {
  it('renders welcome message', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.getByText(/welcome to/i)).toBeInTheDocument()
  })

  it('renders branding text', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.getByText('spec')).toBeInTheDocument()
    expect(screen.getByText('rails')).toBeInTheDocument()
    // The h2 contains "Welcome to specrails"
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/specrails/i)
  })

  it('shows description text about adding a project', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.getByText(/Add your first project to get started/i)).toBeInTheDocument()
  })

  it('shows add project button', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Add your first project/i })).toBeInTheDocument()
  })

  it('click calls onAddProject', async () => {
    const user = userEvent.setup()
    const onAddProject = vi.fn()
    render(<WelcomeScreen onAddProject={onAddProject} />)
    const btn = screen.getByRole('button', { name: /Add your first project/i })
    await user.click(btn)
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it('does not show the CLI terminal command hint (UI-first: web / Mac app only)', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.queryByText(/specrails-desktop add/i)).not.toBeInTheDocument()
  })

  it('offers a Replay tour action below the CTA when provided', async () => {
    const user = userEvent.setup()
    const onReplayTour = vi.fn()
    render(<WelcomeScreen onAddProject={vi.fn()} onReplayTour={onReplayTour} />)
    await user.click(screen.getByRole('button', { name: /Replay tour/i }))
    expect(onReplayTour).toHaveBeenCalledTimes(1)
  })

  it('hides Replay tour when no handler is given', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Replay tour/i })).not.toBeInTheDocument()
  })
})
