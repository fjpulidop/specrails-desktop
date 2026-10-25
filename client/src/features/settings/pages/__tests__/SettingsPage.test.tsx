import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import SettingsPage from '../SettingsPage'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../../lib/app-settings-events'
import type { ProjectConfig } from '../../../../types'

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// useBlocker requires a data router; stub it out for unit tests
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useBlocker: () => ({ state: 'unblocked', proceed: vi.fn(), reset: vi.fn() }),
  }
})

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api',
}))

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

const mockConfig: ProjectConfig = {
  project: { name: 'Test Project', repo: 'github.com/test/repo' },
  issueTracker: {
    github: { available: true, authenticated: true },
    jira: { available: false, authenticated: false },
    active: 'github',
    labelFilter: 'backlog',
  },
  commands: [],
  dailyBudgetUsd: null,
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading skeleton initially when fetch is in-flight', () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}))
    const { container } = render(<SettingsPage />)
    const pulseElements = container.querySelectorAll('.motion-safe\\:animate-pulse')
    expect(pulseElements.length).toBeGreaterThan(0)
  })

  it('renders Settings heading after load', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Project Settings')).toBeInTheDocument()
    })
  })

  it('loads config on mount and shows project name', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText(/Test Project/i)).toBeInTheDocument()
    })
  })

  it('shows Budget section after load', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Budget')).toBeInTheDocument()
    })
  })

  it('shows Worktree environment section after load', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Worktree environment')).toBeInTheDocument()
    })
  })

  it('shows Rail Pre-prompt section after load', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockConfig,
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Rail Pre-prompt')).toBeInTheDocument()
      expect(screen.getByLabelText('Pre-prompt')).toBeInTheDocument()
    })
  })

  it('shows the daily limit as a read-only summary with a link to Analytics ▸ Budget, not a second editor', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockConfig, dailyBudgetUsd: 5 }),
    })
    render(<SettingsPage />)
    expect(await screen.findByTestId('project-daily-budget-summary')).toHaveTextContent('Currently $5.00 a day')
    expect(screen.queryByPlaceholderText(/e\.g\. 5\.00/i)).toBeNull()
    expect(screen.getByText('Limits are edited in Analytics ▸ Budget.')).toBeInTheDocument()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Open Budget' }))
      expect(opened).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
  })

  it('lands on the block named by ?setting= (⌘K "/" in Board mode)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPage />, { route: '/settings?setting=projectBudget' })
    await waitFor(() => {
      const el = document.querySelector('[data-setting-id="projectBudget"]') as HTMLElement
      expect(el).toHaveAttribute('data-setting-flash', 'true')
      expect(el.contains(document.activeElement)).toBe(true)
    })
  })
})
