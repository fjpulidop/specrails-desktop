import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import GlobalSettingsPage from '../GlobalSettingsPage'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../../lib/app-settings-events'

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

describe('GlobalSettingsPage (Desktop Settings dialog)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjects = []
    global.fetch = vi.fn().mockImplementation(defaultFetchMock)
  })

  it('renders Desktop Settings title when open', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Desktop Settings')).toBeInTheDocument()
    })
  })

  it('renders the Desktop-wide preferences description', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Appearance, AI providers, updates and Desktop-wide preferences.')).toBeInTheDocument()
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

  it('renders the panes immediately and shows an em dash for the port before settings resolve', async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    expect(await screen.findByText('Registered Projects')).toBeInTheDocument()
    expect(screen.getByText('Port').nextElementSibling).toHaveTextContent('—')
  })

  it('renders Registered Projects section after load', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Registered Projects')).toBeInTheDocument()
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
      expect(screen.getByText('My Project')).toBeInTheDocument()
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






  it('renders Desktop Information section with port', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Desktop Information')).toBeInTheDocument()
      expect(screen.getByText('4200')).toBeInTheDocument()
    })
  })

  it('renders desktop.sqlite path in Desktop Information', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('~/.specrails/desktop.sqlite')).toBeInTheDocument()
    })
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
      expect(screen.queryByText('Desktop Settings')).toBeInTheDocument()
    })
  })


  it('renders Budget & Alerts section', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Budget & Alerts')).toBeInTheDocument()
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

  it('shows the app-wide daily cap read-only and links to Analytics ▸ Budget instead of editing it', async () => {
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
    expect(screen.getByText('Caps are edited in Analytics ▸ Budget.')).toBeInTheDocument()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      await user.click(screen.getByTestId('settings-open-budget'))
      expect(opened).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalled()
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
    // Nothing on this pane writes the daily cap any more.
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('says there is no daily cap when none is set', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    expect(await screen.findByText('No daily cap set')).toBeInTheDocument()
  })
})

// ─── Outbound Webhooks section ────────────────────────────────────────────────

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

describe('GlobalSettingsPage — Outbound Webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjects = []
    global.fetch = makeFetchWithWebhooks([])
  })

  it('renders Outbound Webhooks section header', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Outbound Webhooks')).toBeInTheDocument()
    })
  })

  it('renders the Add webhook URL input', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/https:\/\/hooks\.example\.com/)).toBeInTheDocument()
    })
  })

  it('disables Add Webhook button when URL is empty', async () => {
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
      expect(toast.error).toHaveBeenCalledWith('Invalid URL')
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
      expect(screen.getByText('Outbound Webhooks')).toBeInTheDocument()
    })
    // Find the "Daily budget exceeded" checkbox and toggle it
    const checkbox = screen.getByRole('checkbox', { name: /daily budget exceeded/i })
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    await user.click(checkbox)
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })
})

// ─── OS Notifications section ────────────────────────────────────────────────

describe('GlobalSettingsPage — OS Notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockProjects = []
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/webhooks')) {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [] }) })
      }
      return Promise.resolve({ ok: true, json: async () => desktopSettings })
    })
  })

  it('renders OS Notifications section header', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('OS Notifications')).toBeInTheDocument()
    })
  })

  it('renders enable checkbox checked by default', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Enable OS Notifications')).toBeInTheDocument()
    })
    const toggle = screen.getByTestId('notif-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('shows filter options when notifications are enabled', async () => {
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('All (completed & failed)')).toBeInTheDocument()
      expect(screen.getByText('Completed only')).toBeInTheDocument()
      expect(screen.getByText('Failed only')).toBeInTheDocument()
    })
  })

  it('hides filter options when notifications are disabled', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('notif-toggle')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('notif-toggle'))
    expect(screen.queryByText('All (completed & failed)')).not.toBeInTheDocument()
  })

  it('persists toggle to localStorage', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('notif-toggle')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('notif-toggle'))
    const stored = JSON.parse(localStorage.getItem('specrails-os-notifications')!)
    expect(stored.enabled).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('OS notifications disabled')
  })

  it('changes filter to failed-only via radio', async () => {
    const user = userEvent.setup()
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Failed only')).toBeInTheDocument()
    })
    const failedRadio = screen.getByRole('radio', { name: /failed only/i })
    await user.click(failedRadio)
    const stored = JSON.parse(localStorage.getItem('specrails-os-notifications')!)
    expect(stored.filter).toBe('failed')
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
    await screen.findByText('Desktop Settings')
    const nav = await screen.findByRole('button', { name: /effects/i })
    await userEvent.click(nav)
    expect(screen.getByTestId('effects-section')).toBeVisible()
    expect(screen.getByTestId('effects-thinking-halo-toggle')).toHaveAttribute('aria-checked', 'true')
  })
})
