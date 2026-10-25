import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '../../../../test-utils'
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
      expect(screen.getAllByText('Spend limits').length).toBeGreaterThan(0)
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

  it('shows the daily limit as a read-only summary with a link to Analytics ▸ Spend limits, not a second editor', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockConfig, dailyBudgetUsd: 5 }),
    })
    render(<SettingsPage />)
    expect(await screen.findByTestId('project-daily-budget-summary')).toHaveTextContent('Currently $5.00 a day')
    expect(screen.queryByPlaceholderText(/e\.g\. 5\.00/i)).toBeNull()
    expect(screen.getByText('Limits are edited in Analytics ▸ Spend limits.')).toBeInTheDocument()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Open Spend limits' }))
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

  it('offers a section index that scrolls to the section and marks it current', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    const user = userEvent.setup()
    render(<SettingsPage />)
    const nav = await screen.findByRole('navigation', { name: 'Project settings sections' })
    const scrollIntoView = vi.fn()
    const section = document.getElementById('settings-section-environment') as HTMLElement
    section.scrollIntoView = scrollIntoView
    const button = Array.from(nav.querySelectorAll('button')).find((b) => b.textContent === 'Environment') as HTMLButtonElement
    await user.click(button)
    expect(scrollIntoView).toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-current', 'true')
    expect(nav.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
  })

  it('marks the LAST section current when the page is scrolled to the bottom', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<div data-testid="scroller" style={{ overflowY: 'auto' }}><SettingsPage /></div>)
    const nav = await screen.findByRole('navigation', { name: 'Project settings sections' })
    const buttons = Array.from(nav.querySelectorAll('button'))
    expect(buttons[0]).toHaveAttribute('aria-current', 'true')
    const scroller = screen.getByTestId('scroller')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 2200 })
    act(() => { fireEvent.scroll(scroller) })
    await waitFor(() => expect(buttons[buttons.length - 1]).toHaveAttribute('aria-current', 'true'))
    expect(nav.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
  })

  it('keeps the heading outline h1 > h2 > h3 (one hidden h2 per section)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPage />)
    await screen.findByRole('navigation', { name: 'Project settings sections' })
    const sections = Array.from(document.querySelectorAll('[data-section-id]'))
    expect(sections.length).toBeGreaterThan(3)
    for (const section of sections) expect(section.querySelector(':scope > h2')).not.toBeNull()
  })

  it('reports a failed config load with a Retry instead of swallowing it', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const { toast } = await import('sonner')
    render(<SettingsPage />)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load the project configuration",
      expect.objectContaining({ action: expect.objectContaining({ label: 'Retry' }) }),
    ))
  })
})
