import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import PluginsPage from '../PluginsPage'

const registerHandler = vi.fn()
const unregisterHandler = vi.fn()

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler,
    unregisterHandler,
  }),
}))

vi.mock('../../hooks/useDesktop', () => ({
  projectProviders: (project: { provider: string; providers?: string[] }) =>
    project.providers && project.providers.length > 0 ? project.providers : [project.provider],
  useDesktop: () => ({
    projects: [
      project('proj-1', 'Specrails Desktop', 'claude', ['claude', 'codex']),
      project('proj-2', 'Codex Only', 'codex', ['codex']),
    ],
  }),
}))

vi.mock('../../components/jira/JiraConnectWizard', () => ({
  JiraConnectWizard: ({ apiBase }: { apiBase?: string }) => (
    <div data-testid="jira-wizard">Jira wizard for {apiBase}</div>
  ),
}))

function project(id: string, name: string, provider: string, providers: string[]) {
  return {
    id,
    slug: id,
    name,
    path: `/repo/${id}`,
    db_path: `/repo/${id}/jobs.sqlite`,
    provider,
    providers,
    added_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
  }
}

function headroomState(overrides: Record<string, unknown> = {}) {
  return {
    installed: false,
    installSource: null,
    version: null,
    executablePath: null,
    uvPath: null,
    port: 8787,
    phase: 'idle',
    activeProviders: { codex: false, claude: false },
    availableProviders: { codex: true, claude: true },
    detectedRoutes: { codex: false, claude: false },
    proxyRunning: false,
    proxyPid: null,
    learning: {
      enabled: false,
      baselineReady: false,
      baselineSamples: 0,
      updatedAt: null,
      lastIssue: null,
    },
    metrics: {
      updatedAt: null,
      proxyStatsAvailable: false,
      durableSavingsAvailable: false,
      outputSavingsAvailable: false,
      outputSavingsMethod: null,
      outputConfidence: null,
      providers: {
        codex: {
          provider: 'codex',
          label: 'Codex',
          active: false,
          available: true,
          detectedRoute: false,
          requests: 0,
          inputTokensSaved: 0,
          outputTokens: 0,
          outputTokensSaved: 0,
          outputSavingsPercent: 0,
          outputSavingsMethod: 'none',
          outputSavingsAllocated: false,
        },
        claude: {
          provider: 'claude',
          label: 'Claude',
          active: false,
          available: true,
          detectedRoute: false,
          requests: 0,
          inputTokensSaved: 0,
          outputTokens: 0,
          outputTokensSaved: 0,
          outputSavingsPercent: 0,
          outputSavingsMethod: 'none',
          outputSavingsAllocated: false,
        },
      },
      lastIssue: null,
    },
    lastIssue: null,
    updatedAt: null,
    ...overrides,
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function installFetchMock(state = headroomState()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)

    if (url.endsWith('/api/global-plugins/headroom')) {
      return json({ state })
    }
    if (url.includes('/jira/connection')) {
      return json({ connected: false })
    }
    if (url.endsWith('/plugins')) {
      return json({
        plugins: [
          {
            name: 'serena',
            version: '0.1.0',
            description: 'Project-local semantic code navigation.',
            whatItDoes: [],
            requirements: [],
            status: 'not-installed',
          },
        ],
      })
    }
    if (url.endsWith('/plugins/serena/preview-install')) {
      return json({
        files: [{ path: '.mcp/serena.json', op: 'create', summary: 'Serena MCP config' }],
        requirements: [{ name: 'uvx', installed: true, executable: true, meetsMinimum: true }],
      })
    }

    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function cardActionButton(title: string): HTMLElement {
  const titleEl = screen.getAllByText(title).find((candidate) => candidate.closest('article'))
  const card = titleEl?.closest('article')
  if (!card) throw new Error(`Plugin card not found: ${title}`)
  return within(card as HTMLElement).getByRole('button')
}

describe('PluginsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders project catalog and filters the single Headroom global panel', async () => {
    installFetchMock()

    render(<PluginsPage />)

    await waitFor(() => expect(screen.getAllByText('Headroom AI').length).toBeGreaterThan(0))
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.getByText('Project-local')).toBeInTheDocument()
    expect(screen.getAllByText('Jira').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Serena').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /^global$/i }))
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.queryByText('Project-local')).not.toBeInTheDocument()
    expect(screen.getByText('Optimize Codex and Claude launches through Headroom AI.')).toBeInTheDocument()
    expect(screen.queryByText('Sync project specs with a Jira board, status mapping, and completion comments.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^project$/i }))
    expect(screen.getByText('Project-local')).toBeInTheDocument()
    expect(screen.queryByText('Global')).not.toBeInTheDocument()
    expect(screen.getAllByText('Jira').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Serena').length).toBeGreaterThan(0)
    expect(screen.queryByText('Optimize Codex and Claude launches through Headroom AI.')).not.toBeInTheDocument()
  })

  it('shows Headroom issue guidance with a repair code', async () => {
    installFetchMock(headroomState({
      lastIssue: {
        code: 'UV_MISSING',
        title: 'Bundled uv was not found',
        guidance: 'Reinstall Specrails Desktop or run diagnostics to confirm the bundled runtime path.',
      },
    }))

    render(<PluginsPage />)

    fireEvent.click(await waitFor(() => cardActionButton('Headroom AI')))
    expect(await screen.findByText('Bundled uv was not found')).toBeInTheDocument()
    expect(screen.getByText('Reinstall Specrails Desktop or run diagnostics to confirm the bundled runtime path.')).toBeInTheDocument()
    expect(screen.getByText('Code: UV_MISSING')).toBeInTheDocument()
  })

  it('opens the Jira project wizard for the selected project api base', async () => {
    installFetchMock()

    render(<PluginsPage />)

    await waitFor(() => expect(cardActionButton('Jira')).toBeInTheDocument())
    fireEvent.click(cardActionButton('Jira'))
    fireEvent.click(await screen.findByRole('button', { name: /Specrails Desktop/ }))

    expect(screen.getByTestId('jira-wizard')).toHaveTextContent('/api/projects/proj-1')
  })

  it('keeps Serena project-local and disables projects without Claude', async () => {
    installFetchMock()

    render(<PluginsPage />)

    await waitFor(() => expect(cardActionButton('Serena')).toBeInTheDocument())
    fireEvent.click(cardActionButton('Serena'))

    expect(await screen.findByRole('button', { name: /Codex Only/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Specrails Desktop/ }))

    expect(await screen.findByText('Serena for Specrails Desktop')).toBeInTheDocument()
    expect(await screen.findByText(/\.mcp\/serena\.json/)).toBeInTheDocument()
  })

  it('shows Headroom output token savings by provider', async () => {
    const state = headroomState({
      installed: true,
      installSource: 'system',
      version: '0.30.0',
      executablePath: '/Users/test/.local/bin/headroom',
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
      learning: {
        enabled: true,
        baselineReady: true,
        baselineSamples: 42,
        updatedAt: '2026-07-08T10:00:00.000Z',
        lastIssue: null,
      },
    }) as ReturnType<typeof headroomState>
    state.metrics.outputSavingsAvailable = true
    state.metrics.outputSavingsMethod = 'estimated'
    state.metrics.updatedAt = '2026-07-08T10:00:00.000Z'
    state.metrics.providers.codex = {
      ...state.metrics.providers.codex,
      active: true,
      detectedRoute: true,
      requests: 12,
      inputTokens: 250000,
      inputTokensSaved: 125000,
      outputTokens: 45000,
      outputTokensSaved: 8400,
      outputSavingsMethod: 'estimated',
      outputSavingsPercent: 18.5,
    }
    installFetchMock(state)

    render(<PluginsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Manage/i }))

    expect(await screen.findByText('Headroom Token Savings')).toBeInTheDocument()
    expect(screen.getByText('Input + output')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getAllByText('Totals').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Input').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Output').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Processed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/250K tokens/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/125K tokens/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/45K tokens/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/8\.4K tokens/i).length).toBeGreaterThan(0)
    expect(screen.getByText('detected')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  it('labels Headroom output savings as unmeasured when only input savings are available', async () => {
    const state = headroomState({
      installed: true,
      installSource: 'managed',
      version: '0.30.0',
      executablePath: '/Users/test/.specrails/tools/bin/headroom',
      activeProviders: { codex: true, claude: false },
      detectedRoutes: { codex: true, claude: false },
    }) as ReturnType<typeof headroomState>
    state.metrics.updatedAt = '2026-07-08T10:00:00.000Z'
    state.metrics.providers.codex = {
      ...state.metrics.providers.codex,
      active: true,
      detectedRoute: true,
      requests: 1013,
      inputTokensSaved: 1490172,
      outputTokens: 470898,
      outputTokensSaved: 0,
      outputSavingsMethod: 'none',
    }
    installFetchMock(state)

    render(<PluginsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Manage/i }))

    expect(await screen.findByText('Headroom Token Savings')).toBeInTheDocument()
    expect(screen.getByText('Input active')).toBeInTheDocument()
    expect(screen.getAllByText('Totals').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Input').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Output').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Processed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/1\.5M tokens/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/470\.9K tokens/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0)
    expect(screen.queryByText('Output Tokens Saved')).not.toBeInTheDocument()
    expect(screen.queryByText('Output savings unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText(/no savings reported/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Learning')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting for output samples')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting for shaped responses')).not.toBeInTheDocument()
  })

  it('exposes Headroom uninstall behind confirmation', async () => {
    const fetchMock = installFetchMock(headroomState({
      installed: true,
      installSource: 'managed',
      version: '0.30.0',
      executablePath: '/Users/test/.specrails/tools/bin/headroom',
      activeProviders: { codex: true, claude: false },
    }))

    render(<PluginsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Manage/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Uninstall Headroom/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Uninstall$/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/global-plugins/headroom/uninstall'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
