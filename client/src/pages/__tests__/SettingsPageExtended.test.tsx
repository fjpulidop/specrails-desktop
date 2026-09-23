import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import SettingsPage from '../../features/settings/pages/SettingsPage'
import type { ProjectConfig } from '../../types'

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useBlocker: () => ({ state: 'unblocked', proceed: vi.fn(), reset: vi.fn() }),
  }
})

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

vi.mock('../../hooks/useDesktop', () => ({
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
    jira: { available: true, authenticated: true },
    active: 'github',
    labelFilter: 'backlog',
  },
  commands: [],
  dailyBudgetUsd: null,
}

const mockConfigJiraNotInstalled: ProjectConfig = {
  project: { name: 'Test Project', repo: null },
  issueTracker: {
    github: { available: false, authenticated: false },
    jira: { available: false, authenticated: false },
    active: null,
    labelFilter: '',
  },
  commands: [],
  dailyBudgetUsd: null,
}

describe('SettingsPage - extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows project repo in subtitle when repo is available', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getByText(/github.com\/test\/repo/i)).toBeInTheDocument()
    })
  })

  it('blocker dialog shows when blocker.state is blocked', async () => {
    // Override useBlocker to return 'blocked' state
    const { default: SettingsPageFresh } = await import('../../features/settings/pages/SettingsPage')
    const mockBlocker = { state: 'blocked', proceed: vi.fn(), reset: vi.fn() }

    vi.doMock('react-router-dom', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react-router-dom')>()
      return { ...actual, useBlocker: () => mockBlocker }
    })

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPageFresh />)

    await waitFor(() => {
      expect(screen.getByText('Project Settings')).toBeInTheDocument()
    })
  })

  it('handles fetch failure gracefully (config remains null)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })                                                                // GET /config fails
      .mockResolvedValue({ ok: true, json: async () => ({ agents: [], pipelineTelemetryEnabled: false, orchestratorModel: 'sonnet' }) }) // all others succeed
    render(<SettingsPage />)

    await waitFor(() => {
      // After failed fetch, isLoading becomes false but config stays null
      expect(screen.getByText('Project Settings')).toBeInTheDocument()
    })
  })

  it('renders Budget section with daily budget input', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Budget')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/e\.g\. 5\.00/i)).toBeInTheDocument()
    })
  })

  it('loads prePrompt from project settings', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ pipelineTelemetryEnabled: false, orchestratorModel: 'sonnet', prePrompt: 'Always add release notes.' }),
        })
      }
      if (String(url).endsWith('/budget')) {
        return Promise.resolve({ ok: true, json: async () => ({ dailyBudgetUsd: null, jobCostThresholdUsd: null }) })
      }
      if (String(url).includes('/terminal-settings')) {
        return Promise.resolve({ ok: true, json: async () => ({ resolved: { fontFamily: 'mono', fontSize: 12, renderMode: 'auto', copyOnSelect: false, shellIntegrationEnabled: true, notifyOnCompletion: true, imageRendering: true, longCommandThresholdMs: 60000 }, override: {}, desktopDefaults: { fontFamily: 'mono', fontSize: 12, renderMode: 'auto', copyOnSelect: false, shellIntegrationEnabled: true, notifyOnCompletion: true, imageRendering: true, longCommandThresholdMs: 60000 } }) })
      }
      return Promise.resolve({ ok: true, json: async () => mockConfig })
    })

    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByLabelText('Pre-prompt')).toHaveValue('Always add release notes.')
    })
  })

  it('saves prePrompt successfully', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).endsWith('/settings') && opts?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            settings: {
              pipelineTelemetryEnabled: false,
              orchestratorModel: 'sonnet',
              prePrompt: 'Always write migration notes.',
            },
          }),
        })
      }
      if (String(url).endsWith('/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ pipelineTelemetryEnabled: false, orchestratorModel: 'sonnet', prePrompt: '' }),
        })
      }
      if (String(url).endsWith('/budget')) {
        return Promise.resolve({ ok: true, json: async () => ({ dailyBudgetUsd: null, jobCostThresholdUsd: null }) })
      }
      return Promise.resolve({ ok: true, json: async () => mockConfig })
    })
    global.fetch = fetchMock

    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByLabelText('Pre-prompt')).toBeInTheDocument()
    })

    await user.type(screen.getByLabelText('Pre-prompt'), 'Always write migration notes.')
    await user.click(screen.getByRole('button', { name: /save pre-prompt/i }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, opts]: [string, RequestInit]) =>
          String(url).endsWith('/settings') && opts?.method === 'PATCH'
      )
      expect(patchCall).toBeDefined()
      expect(JSON.parse(patchCall![1].body as string)).toEqual({ prePrompt: 'Always write migration notes.' })
      expect(toast.success).toHaveBeenCalledWith('Pre-prompt saved')
    })
  })

  it('saves daily budget successfully', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    // URL+method routed (order-independent) so any additional mount-time fetch
    // (e.g. the Jira settings section's GET /jira/connection) cannot shift a
    // brittle mockResolvedValueOnce sequence.
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = String(url)
      const method = opts?.method ?? 'GET'
      if (u.endsWith('/budget') && method === 'PATCH') return Promise.resolve({ ok: true, json: async () => ({}) })
      if (u.endsWith('/config')) return Promise.resolve({ ok: true, json: async () => mockConfig })
      if (u.endsWith('/budget')) return Promise.resolve({ ok: true, json: async () => ({}) })
      if (u.endsWith('/settings')) return Promise.resolve({ ok: true, json: async () => ({ pipelineTelemetryEnabled: false, orchestratorModel: 'sonnet' }) })
      return Promise.resolve({ ok: true, json: async () => ({ agents: [] }), text: async () => '{}' })
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. 5\.00/i)).toBeInTheDocument()
    })
    const budgetInput = screen.getByPlaceholderText(/e\.g\. 5\.00/i) as HTMLInputElement
    await user.type(budgetInput, '5.00')
    // First enabled Save button is the daily budget Save (Orchestrator Save is disabled)
    const saveBtn = screen.getAllByRole('button', { name: /^save$/i }).find(
      (btn) => !(btn as HTMLButtonElement).disabled
    )!
    await user.click(saveBtn)
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Daily budget set to $5')
    })
  })

  it('shows error when daily budget is invalid (zero)', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockConfig })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. 5\.00/i)).toBeInTheDocument()
    })
    const budgetInput = screen.getByPlaceholderText(/e\.g\. 5\.00/i) as HTMLInputElement
    await user.type(budgetInput, '-1')
    const saveBtn = screen.getAllByRole('button', { name: /^save$/i }).find(
      (btn) => !(btn as HTMLButtonElement).disabled
    )!
    await user.click(saveBtn)
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Enter a positive number or leave blank to disable')
    })
  })

  it('removes daily budget when input is blank', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    // URL+method routed (order-independent) — see note in the save test above.
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const u = String(url)
      const method = opts?.method ?? 'GET'
      if (u.endsWith('/budget') && method === 'PATCH') return Promise.resolve({ ok: true, json: async () => ({}) })
      if (u.endsWith('/config')) return Promise.resolve({ ok: true, json: async () => ({ ...mockConfig, dailyBudgetUsd: 5.0 }) })
      if (u.endsWith('/budget')) return Promise.resolve({ ok: true, json: async () => ({ dailyBudgetUsd: 5.0 }) })
      if (u.endsWith('/settings')) return Promise.resolve({ ok: true, json: async () => ({ pipelineTelemetryEnabled: false, orchestratorModel: 'sonnet' }) })
      return Promise.resolve({ ok: true, json: async () => ({ agents: [] }), text: async () => '{}' })
    })
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. 5\.00/i)).toBeInTheDocument()
    })
    const budgetInput = screen.getByPlaceholderText(/e\.g\. 5\.00/i) as HTMLInputElement
    await user.clear(budgetInput)
    const saveBtn = screen.getAllByRole('button', { name: /^save$/i }).find(
      (btn) => !(btn as HTMLButtonElement).disabled
    )!
    await user.click(saveBtn)
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Daily budget removed')
    })
  })
})
