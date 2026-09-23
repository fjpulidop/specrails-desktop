import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
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

function makeFetchMock(telemetryEnabled: boolean) {
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/settings') && opts?.method === 'PATCH') {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, settings: { pipelineTelemetryEnabled: !telemetryEnabled, orchestratorModel: 'sonnet' } }) })
    }
    if (urlStr.endsWith('/settings')) {
      return Promise.resolve({ ok: true, json: async () => ({ pipelineTelemetryEnabled: telemetryEnabled, orchestratorModel: 'sonnet' }) })
    }
    if (urlStr.endsWith('/agent-models')) {
      return Promise.resolve({ ok: true, json: async () => ({ agents: [] }) })
    }
    if (urlStr.endsWith('/budget')) {
      return Promise.resolve({ ok: true, json: async () => ({ dailyBudgetUsd: null, jobCostThresholdUsd: null }) })
    }
    return Promise.resolve({ ok: true, json: async () => mockConfig })
  })
}

describe('SettingsPage — pipeline telemetry toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Pipeline Telemetry section', async () => {
    global.fetch = makeFetchMock(false)
    render(<SettingsPage />)
    await waitFor(() => {
      expect(screen.getByText('Pipeline Telemetry')).toBeInTheDocument()
    })
  })

  it('toggle defaults to OFF when server returns false', async () => {
    global.fetch = makeFetchMock(false)
    render(<SettingsPage />)
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /enable pipeline telemetry/i })
      expect(toggle.getAttribute('aria-checked')).toBe('false')
    })
  })

  it('toggle renders as ON when server returns true', async () => {
    global.fetch = makeFetchMock(true)
    render(<SettingsPage />)
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /enable pipeline telemetry/i })
      expect(toggle.getAttribute('aria-checked')).toBe('true')
    })
  })

  it('clicking toggle sends PATCH request to /settings', async () => {
    const fetchMock = makeFetchMock(false)
    global.fetch = fetchMock
    render(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /enable pipeline telemetry/i })).toBeInTheDocument()
    })

    const toggle = screen.getByRole('switch', { name: /enable pipeline telemetry/i })
    fireEvent.click(toggle)

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, opts]: [string, RequestInit]) =>
          String(url).endsWith('/settings') && opts?.method === 'PATCH'
      )
      expect(patchCall).toBeDefined()
      const body = JSON.parse(patchCall![1].body as string) as { pipelineTelemetryEnabled: boolean }
      expect(body.pipelineTelemetryEnabled).toBe(true)
    })
  })
})
