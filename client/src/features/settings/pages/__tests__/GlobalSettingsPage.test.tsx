import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import GlobalSettingsPage from '../GlobalSettingsPage'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../../lib/app-settings-events'
import { attentionPrefsStore } from '../../../../lib/attention/attention-prefs-store'

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// MobileAccessSection (rendered inside the settings page) subscribes to the
// shared socket for live device updates; stub it so no provider is required.
// SpecrailsAgentsSection → useProviderDetection reads the raw context export,
// so the mock must ship it too (a missing export throws on property access).
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  SharedWebSocketContext: React.createContext(null),
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

// Controlled useDesktop mock: track removeProject calls
const mockRemoveProject = vi.fn()
let mockProjects: Array<{ id: string; slug: string; name: string; path: string; db_path: string; added_at: string; last_seen_at: string }> = []

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: mockProjects,
    activeProjectId: null,
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: mockRemoveProject,
  }),
}))

const desktopSettings = {
  port: 4200,
  version: '2.3.4',
  runningPort: 4395,
  databasePath: '~/.specrails-dev/.specrails/desktop.sqlite',
  specrailsTechUrl: 'http://localhost:3000',
}

const budgetResponse = { desktopDailyBudgetUsd: null, costToday: 0, budgetUtilizationPct: null }

const defaultTerminalSettings = {
  fontFamily: "'DM Mono', monospace",
  fontSize: 12,
  renderMode: 'auto',
  copyOnSelect: false,
  shellIntegrationEnabled: true,
  notifyOnCompletion: true,
  imageRendering: true,
  longCommandThresholdMs: 60_000,
}

function defaultFetchMock(url: string) {
  if (typeof url === 'string' && url.includes('/api/webhooks')) {
    return Promise.resolve({ ok: true, json: async () => ({ webhooks: [] }) })
  }
  if (typeof url === 'string' && url.includes('/api/budget')) {
    return Promise.resolve({ ok: true, json: async () => budgetResponse })
  }
  if (typeof url === 'string' && url.includes('/api/terminal-settings')) {
    return Promise.resolve({ ok: true, json: async () => defaultTerminalSettings })
  }
  return Promise.resolve({ ok: true, json: async () => desktopSettings })
}

describe('GlobalSettingsPage (Settings dialog)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjects = []
    global.fetch = vi.fn().mockImplementation(defaultFetchMock)
  })

  it('renders the Settings title when open', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    })
  })

  it('renders the app-wide preferences description', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Appearance, AI providers, updates and app-wide preferences.')).toBeInTheDocument()
    })
  })

  it('groups the section nav under Personal, Agents and System and marks the active item', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' })
    for (const group of ['Personal', 'Agents', 'System']) {
      expect(within(nav).getByRole('group', { name: group })).toBeInTheDocument()
    }
    expect(within(nav).getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page')
    await user.click(within(nav).getByRole('button', { name: 'Webhooks' }))
    expect(within(nav).getByRole('button', { name: 'Webhooks' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('button', { name: 'Appearance' })).not.toHaveAttribute('aria-current')
  })

  it('spaces nav group labels more above than below (mt-4 / mb-1), first group flush', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    const labels = screen.getAllByTestId(/^settings-nav-group-label-/)
    expect(labels.length).toBeGreaterThan(1)
    expect(labels[0]).toHaveClass('mt-0', 'mb-1', 'text-label')
    for (const label of labels.slice(1)) {
      expect(label).toHaveClass('mt-4', 'mb-1', 'text-label')
      expect(label.className).not.toMatch(/text-\[11px\]/)
    }
  })

  it('is a workspace modal with a single scrolling body', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('data-dialog-size', 'workspace')
    expect(dialog.querySelector('[data-dialog-body]')).not.toBeNull()
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
  })

  it('returns focus to the remounted Settings trigger (found by aria-label) on close', async () => {
    const user = userEvent.setup()
    // The sidebar trigger re-renders with a new key while the modal is open —
    // the original node is gone when the modal closes.
    function Harness() {
      const [open, setOpen] = React.useState(false)
      const [generation, setGeneration] = React.useState(0)
      // Re-key the trigger shortly after the modal mounted (like the sidebar re-render).
      React.useEffect(() => {
        if (!open) return
        const id = setTimeout(() => setGeneration((g) => g + 1), 20)
        return () => clearTimeout(id)
      }, [open])
      return (
        <>
          <button key={generation} type="button" aria-label="App settings" onClick={() => setOpen(true)}>
            gear
          </button>
          <GlobalSettingsPage open={open} onClose={() => setOpen(false)} />
        </>
      )
    }
    render(<Harness />)
    const original = screen.getByRole('button', { name: 'App settings' })
    await user.click(original)
    await screen.findByRole('dialog')
    await waitFor(() => expect(original.isConnected).toBe(false))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'App settings', hidden: true }))
    })
  })

  it('shows the replay tour action in the Appearance pane', async () => {
    const onOpenOnboarding = vi.fn()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} onOpenOnboarding={onOpenOnboarding} />)
    fireEvent.click(await screen.findByTestId('replay-onboarding'))
    expect(onOpenOnboarding).toHaveBeenCalledTimes(1)
  })

  it('masks the webhook signing secret', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    const secret = await screen.findByPlaceholderText('Signing secret (optional)')
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret).toHaveAttribute('autocomplete', 'off')
  })

  it('renders the panes immediately and leaves the port out (no dash) before settings resolve', async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    expect(await screen.findByText('Registered projects')).toBeInTheDocument()
    expect(screen.queryByTestId('about-port')).not.toBeInTheDocument()
    expect(screen.getByTestId('about-projects')).toBeInTheDocument()
  })

  it('renders Registered projects section after load', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Registered projects')).toBeInTheDocument()
    })
  })

  it('shows "No projects registered yet" when projects is empty', async () => {
    mockProjects = []
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('No projects registered yet')).toBeInTheDocument()
    })
  })

  it('renders project list items when projects exist', async () => {
    mockProjects = [
      {
        id: 'p1',
        slug: 'proj-1',
        name: 'My Project',
        path: '/home/user/my-project',
        db_path: '/home/user/.specrails/projects/proj-1/jobs.sqlite',
        added_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2024-01-02T00:00:00Z',
      },
    ]
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      const registered = document.querySelector('[data-setting-id="registeredProjects"]') as HTMLElement
      expect(within(registered).getByText('My Project')).toBeInTheDocument()
      expect(screen.getByText('/home/user/my-project')).toBeInTheDocument()
    })
  })

  it('renders Remove button for each project', async () => {
    mockProjects = [
      {
        id: 'p1',
        slug: 'proj-1',
        name: 'My Project',
        path: '/home/user/my-project',
        db_path: '/home/user/.specrails/projects/proj-1/jobs.sqlite',
        added_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2024-01-02T00:00:00Z',
      },
    ]
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
    })
  })

  it('calls removeProject when Remove is clicked and resolves successfully', async () => {
    const { toast } = await import('sonner')
    mockRemoveProject.mockResolvedValueOnce(undefined)
    mockProjects = [
      {
        id: 'p1',
        slug: 'proj-1',
        name: 'My Project',
        path: '/home/user/my-project',
        db_path: '/home/user/.specrails/projects/proj-1/jobs.sqlite',
        added_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2024-01-02T00:00:00Z',
      },
    ]
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    // Removal is destructive: it only happens after the confirmation dialog.
    expect(mockRemoveProject).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove .*\?/ })).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(mockRemoveProject).toHaveBeenCalledWith('p1')
      expect(toast.success).toHaveBeenCalledWith('Project removed')
    })
  })

  it('shows toast error when removeProject throws', async () => {
    const { toast } = await import('sonner')
    mockRemoveProject.mockRejectedValueOnce(new Error('Permission denied'))
    mockProjects = [
      {
        id: 'p1',
        slug: 'proj-1',
        name: 'Failing Project',
        path: '/home/user/failing',
        db_path: '/home/user/.specrails/projects/proj-1/jobs.sqlite',
        added_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2024-01-02T00:00:00Z',
      },
    ]
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    // Removal is destructive: it only happens after the confirmation dialog.
    expect(mockRemoveProject).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Remove .*\?/ })).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to remove project',
        expect.objectContaining({ description: 'Permission denied' })
      )
    })
  })






  it('About shows the port and project count', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('About', { selector: 'h3, h2, [data-setting-id] *' })).toBeInTheDocument()
      // The port this instance listens on, not only the persisted setting.
      expect(screen.getByTestId('about-port')).toHaveTextContent('4395')
    })
  })

  it('About shows the real version and database location from the server, and leaves out what it did not report', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('about-version')).toHaveTextContent('2.3.4')
      expect(screen.getByTestId('about-database')).toHaveTextContent('~/.specrails-dev/.specrails/desktop.sqlite')
    })
    expect(screen.queryByText('~/.specrails/desktop.sqlite')).not.toBeInTheDocument()
  })

  it('does not fetch when open=false', () => {
    render(<GlobalSettingsPage open={false} onClose={vi.fn()} />)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('renders 0 for projects count when no projects', async () => {
    mockProjects = []
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      // "Projects" now appears both as a left-nav section and the Desktop
      // Information count label — assert at least one is present.
      expect(screen.getAllByText('Projects').length).toBeGreaterThan(0)
    })
  })

  it('handles fetch error gracefully (no crash)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    // Should not throw — isLoading goes false, settings stay null
    await waitFor(() => {
      // After error, isLoading becomes false
      expect(screen.queryByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    })
  })


  it('renders Spend limits & alerts section', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Spend limits & alerts')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/e\.g\. 0\.50/i)).toBeInTheDocument()
    })
  })

  it('saves cost alert threshold successfully', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => desktopSettings })          // GET settings
      .mockResolvedValueOnce({ ok: true, json: async () => ({ webhooks: [] }) })   // GET webhooks
      .mockResolvedValueOnce({ ok: true, json: async () => budgetResponse })       // GET budget
      .mockResolvedValue({ ok: true, json: async () => defaultTerminalSettings })  // catch-all
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. 0\.50/i)).toBeInTheDocument()
    })
    const input = screen.getByPlaceholderText(/e\.g\. 0\.50/i) as HTMLInputElement
    await user.type(input, '0.50')
    expect(screen.getByTestId('advanced-save-bar')).toHaveAttribute('data-sticky', 'true')
    await user.click(within(screen.getByTestId('advanced-save-bar')).getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Alert set for jobs over $0.50')
    })
  })

  it('disables cost alert when threshold is blank', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/settings')) {
        return Promise.resolve({ ok: true, json: async () => ({ ...desktopSettings, costAlertThresholdUsd: 2 }) })
      }
      return defaultFetchMock(url)
    })
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    const input = await screen.findByPlaceholderText(/e\.g\. 0\.50/i) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('2'))
    expect(within(screen.getByTestId('advanced-save-bar')).getByRole('button', { name: /save/i })).toBeDisabled()
    await user.clear(input)
    await user.click(within(screen.getByTestId('advanced-save-bar')).getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Cost alerts disabled')
    })
  })

  it('shows error when cost alert threshold is invalid', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation(defaultFetchMock)
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. 0\.50/i)).toBeInTheDocument()
    })
    const input = screen.getByPlaceholderText(/e\.g\. 0\.50/i) as HTMLInputElement
    await user.type(input, '-1')
    await user.click(within(screen.getByTestId('advanced-save-bar')).getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Enter a positive number or leave blank to disable')
    })
  })

  it('shows the app-wide daily limit read-only and links to Analytics ▸ Spend limits instead of editing it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const requests: Array<{ url: string; method?: string }> = []
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      requests.push({ url: String(url), method: opts?.method })
      if (typeof url === 'string' && url.includes('/api/webhooks')) {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [] }) })
      }
      if (typeof url === 'string' && url.includes('/api/budget')) {
        return Promise.resolve({ ok: true, json: async () => ({ desktopDailyBudgetUsd: 10 }) })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })
    render(<GlobalSettingsPage open={true} onClose={onClose} />)
    expect(await screen.findByText('Currently $10.00 a day')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/e\.g\. 10\.00/i)).toBeNull()
    expect(screen.getByText('Limits are edited in Analytics ▸ Spend limits.')).toBeInTheDocument()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      await user.click(screen.getByTestId('settings-open-budget'))
      expect(opened).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalled()
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
    // Nothing on this pane writes the daily limit any more.
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('says there is no daily limit when none is set', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    expect(await screen.findByText('No daily limit set')).toBeInTheDocument()
  })
})

// ─── Outbound webhooks section ────────────────────────────────────────────────

const mockWebhook = {
  id: 'wh-1',
  project_id: null,
  url: 'https://example.com/hook',
  secret: '',
  events: JSON.stringify(['job.completed']),
  enabled: 1,
  created_at: '2024-01-01T00:00:00Z',
}

function makeFetchWithWebhooks(webhooks: typeof mockWebhook[]) {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url === '/api/webhooks') {
      return Promise.resolve({ ok: true, json: async () => ({ webhooks }) })
    }
    if (typeof url === 'string' && url.includes('/api/budget')) {
      return Promise.resolve({ ok: true, json: async () => budgetResponse })
    }
    return Promise.resolve({ ok: true, json: async () => desktopSettings })
  })
}

describe('GlobalSettingsPage — Outbound webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjects = []
    global.fetch = makeFetchWithWebhooks([])
  })

  it('renders Outbound webhooks section header', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Outbound webhooks')).toBeInTheDocument()
    })
  })

  it('renders the Add webhook URL input', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/)).toBeInTheDocument()
    })
  })

  it('disables Add webhook button when URL is empty', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add webhook/i })).toBeInTheDocument()
    })
    const btn = screen.getByRole('button', { name: /add webhook/i })
    expect(btn).toBeDisabled()
  })

  it('adds a webhook successfully and reloads list', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    // URL+method keyed mock (not a brittle mockResolvedValueOnce sequence): the
    // component fires several settings fetches on mount, so a fixed sequence
    // misaligns and the POST response lands on the wrong call.
    let posted = false
    global.fetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (typeof url === 'string' && url === '/api/webhooks') {
        if (opts?.method === 'POST') {
          posted = true
          return Promise.resolve({ ok: true, json: async () => ({ webhook: mockWebhook }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: posted ? [mockWebhook] : [] }) })
      }
      if (typeof url === 'string' && url.includes('/api/budget')) {
        return Promise.resolve({ ok: true, json: async () => budgetResponse })
      }
      if (typeof url === 'string' && url.includes('/api/terminal-settings')) {
        return Promise.resolve({ ok: true, json: async () => defaultTerminalSettings })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })

    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/)).toBeInTheDocument()
    })
    await user.type(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/), 'https://example.com/hook')
    await user.click(screen.getByRole('button', { name: /add webhook/i }))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Webhook added')
    })
  })

  it('shows error when adding webhook fails with server message', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (typeof url === 'string' && url === '/api/webhooks') {
        if (opts?.method === 'POST') {
          return Promise.resolve({ ok: false, json: async () => ({ error: 'Invalid URL' }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [] }) })
      }
      if (typeof url === 'string' && url.includes('/api/budget')) {
        return Promise.resolve({ ok: true, json: async () => budgetResponse })
      }
      if (typeof url === 'string' && url.includes('/api/terminal-settings')) {
        return Promise.resolve({ ok: true, json: async () => defaultTerminalSettings })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })

    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/)).toBeInTheDocument()
    })
    await user.type(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/), 'https://example.com/hook')
    await user.click(screen.getByRole('button', { name: /add webhook/i }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Invalid URL', action: expect.objectContaining({ label: 'Retry' }) })
    })
  })

  it('renders a listed webhook URL', async () => {
    global.fetch = makeFetchWithWebhooks([mockWebhook])
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('https://example.com/hook')).toBeInTheDocument()
    })
  })

  it('toggles a webhook on/off', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/webhooks') {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [mockWebhook] }) })
      }
      if (url === '/api/budget') {
        return Promise.resolve({ ok: true, json: async () => budgetResponse })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable' })).toHaveAttribute('aria-checked', 'true')
    })
    await user.click(screen.getByRole('switch', { name: 'Enable' }))
    // Patch call should have been made
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/webhooks/wh-1'),
      expect.objectContaining({ method: 'PATCH' })
    )
  })

  it('deletes a webhook and shows success toast', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/webhooks') {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [mockWebhook] }) })
      }
      if (url === '/api/budget') {
        return Promise.resolve({ ok: true, json: async () => budgetResponse })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove webhook?' })
    expect(dialog).toHaveTextContent('https://example.com/hook will stop receiving Desktop events.')
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/webhooks/wh-1'), expect.objectContaining({ method: 'DELETE' }))
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Webhook removed')
    })
  })

  it('sends a test ping and shows success toast', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/webhooks') {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [mockWebhook] }) })
      }
      if (url === '/api/budget') {
        return Promise.resolve({ ok: true, json: async () => budgetResponse })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send test ping' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Send test ping' }))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Test ping sent')
    })
  })

  it('toggles event checkbox selection', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Outbound webhooks')).toBeInTheDocument()
    })
    // Find the "Daily limit exceeded" checkbox and toggle it
    const checkbox = screen.getByRole('checkbox', { name: /daily limit exceeded/i })
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    await user.click(checkbox)
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })
})

// ─── Notifications (attention) section ───────────────────────────────────────

describe('GlobalSettingsPage — Notifications', () => {
  const patches: unknown[] = []
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    attentionPrefsStore.reset()
    patches.length = 0
    mockProjects = [{ id: 'p1', slug: 'acme', name: 'Acme', path: '/acme', db_path: '/x', added_at: '', last_seen_at: '' }]
    let prefs = {
      enabled: true, sound: false, dockBadge: true, mutedProjects: [] as string[],
      categories: { question: true, review: true, failed: true, budget: true, done: true },
    }
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/api/attention-prefs')) {
        if (init?.method === 'PATCH') {
          const patch = JSON.parse(String(init.body))
          patches.push(patch)
          prefs = { ...prefs, ...patch, categories: { ...prefs.categories, ...(patch.categories ?? {}) } }
        }
        return Promise.resolve({ ok: true, json: async () => prefs })
      }
      return defaultFetchMock(url)
    })
  })

  it('has its own section with the master switch, the categories, sound and the Dock badge', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} initialSection="notifications" />)
    const card = await screen.findByTestId('attention-settings')
    expect(within(card).getByRole('switch', { name: 'Notify me' })).toHaveAttribute('aria-checked', 'true')
    for (const label of ['Questions and replies', 'Reviews ready', 'Failures', 'Spending limits', 'Finished jobs']) {
      expect(within(card).getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'true')
    }
    expect(within(card).getByRole('switch', { name: 'Play a sound' })).toHaveAttribute('aria-checked', 'false')
    expect(within(card).getByRole('switch', { name: 'Dock badge' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByTestId('notif-toggle')).not.toBeInTheDocument()
  })

  it('saves a category on the server and keeps the switch in step', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} initialSection="notifications" />)
    const done = await screen.findByRole('switch', { name: 'Finished jobs' })
    await user.click(done)
    await waitFor(() => expect(patches).toEqual([{ categories: { done: false } }]))
    expect(done).toHaveAttribute('aria-checked', 'false')
  })

  it('turning everything off disables the categories', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} initialSection="notifications" />)
    await user.click(await screen.findByRole('switch', { name: 'Notify me' }))
    await waitFor(() => expect(patches).toEqual([{ enabled: false }]))
    expect(screen.getByRole('switch', { name: 'Failures' })).toBeDisabled()
  })

  it('mutes a project from the project list', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} initialSection="notifications" />)
    const projects = await screen.findByTestId('attention-projects')
    await user.click(within(projects).getByRole('switch', { name: 'Acme' }))
    await waitFor(() => expect(patches).toEqual([{ mutedProjects: ['p1'] }]))
    expect(within(projects).getByRole('switch', { name: 'Acme' })).toHaveAttribute('aria-checked', 'false')
  })

  it('migrates the old job-notification prefs once and drops them', async () => {
    localStorage.setItem('specrails-os-notifications', JSON.stringify({ enabled: true, filter: 'failed' }))
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} initialSection="notifications" />)
    await waitFor(() => expect(patches).toEqual([{ categories: { done: false } }]))
    await waitFor(() => expect(localStorage.getItem('specrails-os-notifications')).toBeNull())
    expect(await screen.findByRole('switch', { name: 'Finished jobs' })).toHaveAttribute('aria-checked', 'false')
  })
})

describe('GlobalSettingsPage — Effects section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjects = []
    global.fetch = vi.fn().mockImplementation(defaultFetchMock)
  })

  it('lists Effects in the left nav and shows the thinking-halo switch when selected', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Settings' })
    const nav = await screen.findByRole('button', { name: /effects/i })
    await userEvent.click(nav)
    expect(screen.getByTestId('effects-section')).toBeVisible()
    expect(screen.getByTestId('effects-thinking-halo-toggle')).toHaveAttribute('aria-checked', 'true')
  })
})
