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

  it('offers a sample project next to Add your project, without a Replay tour button (the tour lives under Help)', () => {
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Try it on a sample project/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add your first project/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replay tour/i })).not.toBeInTheDocument()
  })

  it('states the cost of the sample upfront, as an estimate', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        catalog: [{ id: 'tic-tac-toe', name: 'tic-tac-toe', specCount: 3 }],
        sample: null,
        defaultParentDir: '/Users/me/Specrails Samples',
        launch: { ready: true, preset: { provider: 'claude', model: 'haiku', local: false, loopId: 'factory:sdd-quick-openspec', runCapUsd: 1 }, localPreset: null, estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd: 1 },
      }),
    })
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(await screen.findByTestId('try-sample-cost')).toHaveTextContent(/\$0\.30–\$1/)
    expect(screen.getByTestId('try-sample-cost')).toHaveTextContent(/estimate/i)
  })

  it('offers the recording instead when no provider is ready', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ catalog: [], sample: null, defaultParentDir: '', launch: { ready: false, reason: 'no_provider', estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd: 1 } }),
    })
    render(<WelcomeScreen onAddProject={vi.fn()} />)
    expect(await screen.findByTestId('try-sample-cost')).toHaveTextContent(/recorded run/i)
  })
})
