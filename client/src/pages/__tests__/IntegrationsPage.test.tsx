import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '../../test-utils'
import IntegrationsPage from '../IntegrationsPage'

vi.mock('../../hooks/useDesktop', () => ({
  // projectProviders is imported by IntegrationsPage from this module too.
  projectProviders: (p: { provider?: string; providers?: string[] }) =>
    p.providers && p.providers.length > 0 ? p.providers : [p.provider ?? 'claude'],
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [{ id: 'proj-1', provider: 'claude', providers: ['claude'] }],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

const handlers = new Map<string, (m: unknown) => void>()
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (m: unknown) => void) => { handlers.set(id, fn) },
    unregisterHandler: (id: string) => { handlers.delete(id) },
  }),
}))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  handlers.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * URL-routed fetch so the Jira card's GET /jira/connection (which always fires
 * on mount) never shifts the plugin fetch ordering. `pluginsBody` is what
 * GET /plugins returns; `previewBody` (optional) what preview-install returns.
 */
function routeFetch(pluginsBody: unknown, previewBody?: unknown) {
  fetchMock.mockImplementation((url: string) => {
    const u = String(url)
    if (u.includes('/jira/connection')) {
      return Promise.resolve({ ok: true, text: async () => JSON.stringify({ connected: false }) })
    }
    if (u.includes('preview-install')) {
      return Promise.resolve({ ok: true, json: async () => previewBody ?? {} })
    }
    if (u.endsWith('/plugins')) {
      return Promise.resolve({ ok: true, json: async () => pluginsBody })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const sampleCatalog = {
  plugins: [
    {
      name: 'serena',
      version: '1.0.0',
      description: 'Semantic nav',
      whatItDoes: ['symbol lookup'],
      requirements: [{ name: 'uv', minVersion: '0.1.0' }],
      status: 'not-installed',
    },
  ],
}

describe('IntegrationsPage', () => {
  it('always shows the Jira integration card', async () => {
    routeFetch(sampleCatalog)
    render(<IntegrationsPage />)
    await waitFor(() => expect(screen.getByTestId('jira-integration-card')).toBeInTheDocument())
    // The Connect button only appears after the async GET /jira/connection
    // resolves — wait for it (findBy) rather than asserting synchronously.
    expect(await screen.findByTestId('jira-connect-btn')).toBeInTheDocument()
  })

  it('renders cards for plugins from the catalog (Claude project)', async () => {
    routeFetch(sampleCatalog)
    render(<IntegrationsPage />)
    await waitFor(() => {
      expect(screen.getByText('serena')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /install/i })).toBeInTheDocument()
  })

  it('opens install dialog and fetches preview', async () => {
    routeFetch(sampleCatalog, {
      pluginName: 'serena',
      files: [{ path: '.mcp.json', op: 'create', summary: '+ mcpServers.serena' }],
      requirements: [{ name: 'uv', installed: true, executable: true, meetsMinimum: true, version: '0.1.0' }],
    })
    render(<IntegrationsPage />)
    await waitFor(() => screen.getByText('serena'))
    fireEvent.click(screen.getByRole('button', { name: /install/i }))
    await waitFor(() => {
      expect(screen.getByText(/Files that will change/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/\.mcp\.json/i)).toBeInTheDocument()
  })

  it('shows installed state with uninstall button', async () => {
    routeFetch({
      plugins: [{ ...sampleCatalog.plugins[0], status: 'installed', installedAt: 'now', health: 'ok' }],
    })
    render(<IntegrationsPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /uninstall/i })).toBeInTheDocument()
    })
  })

  // NOTE the explicit 15s TEST timeout: the inner findBy* retry budget (5s)
  // equalled vitest's default per-test 5s, so on a loaded CI runner the query
  // wait exhausted the whole test budget and died at ~5009ms (flaky).
  it('shows Auto-install button when uv prerequisite is missing', { timeout: 15000 }, async () => {
    routeFetch(sampleCatalog, {
      pluginName: 'serena',
      files: [{ path: '.mcp.json', op: 'create' }],
      requirements: [{ name: 'uv', installed: false, executable: false, meetsMinimum: false, minVersion: '0.1.0' }],
    })
    render(<IntegrationsPage />)
    await screen.findByText('serena')
    // Wait for the Install button to mount before clicking, then assert the
    // Auto-install button via findByRole — clicking Install triggers a
    // preview-install fetch whose modal renders the uv-missing requirement a
    // tick later, so a synchronous getByRole raced the async render under CI
    // load (flaky "Unable to find /auto-install/i"). findBy* retries; the bumped
    // timeout absorbs the two sequential async fetches on a slow runner.
    fireEvent.click(await screen.findByRole('button', { name: /install$/i }))
    expect(
      await screen.findByRole('button', { name: /auto-install/i }, { timeout: 5000 }),
    ).toBeInTheDocument()
  })

  it('shows the Jira card (not an empty state) when no plugins are bundled', async () => {
    routeFetch({ plugins: [] })
    render(<IntegrationsPage />)
    await waitFor(() => expect(screen.getByTestId('jira-integration-card')).toBeInTheDocument())
    expect(screen.queryByText('serena')).toBeNull()
  })

  it('renders orphan section', async () => {
    routeFetch({
      plugins: [{
        name: 'old-thing',
        version: '0.1.0',
        description: 'gone',
        whatItDoes: [],
        requirements: [],
        status: 'orphan',
      }],
    })
    render(<IntegrationsPage />)
    await waitFor(() => {
      expect(screen.getByText(/Deprecated/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /remove orphan/i })).toBeInTheDocument()
  })

  it('hides Claude-only plugins on a Codex-only project but still shows Jira', async () => {
    vi.resetModules()
    vi.doMock('../../hooks/useDesktop', () => ({
      projectProviders: () => ['codex'],
      useDesktop: () => ({
        activeProjectId: 'proj-1',
        projects: [{ id: 'proj-1', provider: 'codex', providers: ['codex'] }],
        isLoading: false,
        setupProjectIds: new Set(),
        setActiveProjectId: vi.fn(),
        startSetupWizard: vi.fn(),
        completeSetupWizard: vi.fn(),
        addProject: vi.fn(),
        removeProject: vi.fn(),
      }),
    }))
    routeFetch(sampleCatalog)
    const { default: CodexPage } = await import('../IntegrationsPage')
    render(<CodexPage />)
    await waitFor(() => expect(screen.getByTestId('jira-integration-card')).toBeInTheDocument())
    expect(screen.queryByText('serena')).toBeNull()
    vi.doUnmock('../../hooks/useDesktop')
  })
})
