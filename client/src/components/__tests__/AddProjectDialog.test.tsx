import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { AddProjectDialog } from '../AddProjectDialog'
import { __resetPrerequisitesCacheForTest } from '../../hooks/usePrerequisites'

const goodPrereqsStatus = {
  ok: true,
  platform: 'darwin' as const,
  prerequisites: [
    { key: 'node', label: 'Node.js', command: 'node', required: true, installed: true, version: 'v20.0.0', minVersion: '18.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
  ],
  missingRequired: [],
}

const missingGitPrereqsStatus = {
  ok: false,
  platform: 'darwin' as const,
  prerequisites: [
    { key: 'node', label: 'Node.js', command: 'node', required: true, installed: true, version: 'v20.0.0', minVersion: '18.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
    { key: 'git', label: 'Git', command: 'git', required: true, installed: false, meetsMinimum: false, installUrl: '', installHint: '' },
  ],
  missingRequired: [
    { key: 'git', label: 'Git', command: 'git', required: true, installed: false, meetsMinimum: false, installUrl: '', installHint: '' },
  ],
}

vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockStartSetupWizard = vi.fn()
const mockSetActiveProjectId = vi.fn()
const mockAddProject = vi.fn()

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    startSetupWizard: mockStartSetupWizard,
    setActiveProjectId: mockSetActiveProjectId,
    projects: [],
    activeProjectId: null,
    isLoading: false,
    addProject: mockAddProject,
    removeProject: vi.fn(),
    setupProjectIds: new Set(),
    completeSetupWizard: vi.fn(),
  }),
}))

/** URL-aware mock: routes by request URL so call order doesn't matter. */
function mockFetchSequence(opts?: {
  prereqStatus?: typeof goodPrereqsStatus | typeof missingGitPrereqsStatus
  prereqOk?: boolean
  projectResponse?: { ok: boolean; json: () => Promise<unknown> }
}) {
  const prereqStatus = opts?.prereqStatus ?? goodPrereqsStatus
  const prereqOk = opts?.prereqOk ?? true
  const providersResponse = { ok: true, json: async () => ({ claude: true, codex: false }) }

  global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/available-providers')) return providersResponse
    if (url.includes('/api/setup-prerequisites')) {
      return prereqOk
        ? { ok: true, json: async () => prereqStatus }
        : { ok: false, status: 500, json: async () => ({}) }
    }
    if (opts?.projectResponse) return opts.projectResponse
    return { ok: true, json: async () => ({}) }
  })
}

describe('AddProjectDialog', () => {
  beforeEach(() => {
    mockStartSetupWizard.mockClear()
    mockSetActiveProjectId.mockClear()
    mockAddProject.mockReset()
    mockAddProject.mockResolvedValue({
      project: { id: 'new-proj', name: 'My Project' },
      has_specrails: true,
    })
    vi.clearAllMocks()
    __resetPrerequisitesCacheForTest()
    mockFetchSequence()
  })

  it('renders dialog when open=true — shows path input directly', () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('/Users/me/my-project')).toBeInTheDocument()
  })

  it('does not render dialog when open=false', () => {
    render(<AddProjectDialog open={false} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText('/Users/me/my-project')).not.toBeInTheDocument()
  })

  it('shows path and name inputs immediately on open', async () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText('/Users/me/my-project')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('My Project')).toBeInTheDocument()
  })

  it('submit button is disabled when path is empty', async () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    expect(addBtn).toBeDisabled()
  })

  it('submit button is enabled when path is filled and prerequisites are healthy', async () => {
    const user = userEvent.setup()
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    // Wait for the prereq fetch to settle into ok state
    await waitFor(() => expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'ok'))
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    expect(addBtn).not.toBeDisabled()
  })

  it('submit button stays disabled when a required tool is missing, even with a valid path', async () => {
    const user = userEvent.setup()
    mockFetchSequence({ prereqStatus: missingGitPrereqsStatus })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'missing'))

    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')

    const addBtn = screen.getByTestId('add-project-submit')
    expect(addBtn).toBeDisabled()
    expect(addBtn).toHaveAttribute('title', expect.stringMatching(/Git is required/i))
  })

  it('clicking "More info" opens the install instructions modal', async () => {
    const user = userEvent.setup()
    mockFetchSequence({ prereqStatus: missingGitPrereqsStatus })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('prerequisites-more-info')).toBeInTheDocument())

    await user.click(screen.getByTestId('prerequisites-more-info'))
    expect(screen.getByRole('heading', { name: /install developer tools/i })).toBeInTheDocument()
  })

  it('does not block submit when the prereq fetch errors (server install guard takes over)', async () => {
    const user = userEvent.setup()
    mockFetchSequence({ prereqOk: false })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('prerequisites-panel')).toHaveAttribute('data-state', 'error'))

    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    expect(screen.getByTestId('add-project-submit')).not.toBeDisabled()
  })

  it('successful submit calls API and closes dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(<AddProjectDialog open={true} onClose={onClose} />)
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockAddProject).toHaveBeenCalledWith('/some/path', undefined, ['claude'])
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('error response shows toast.error', async () => {
    const user = userEvent.setup()
    const { toast } = await import('sonner')
    mockAddProject.mockRejectedValueOnce(new Error('Path not found'))

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/bad/path')
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add project', expect.objectContaining({ description: 'Path not found' }))
    })
  })

  it('when has_specrails=false, triggers setup wizard and sets active project', async () => {
    const user = userEvent.setup()
    mockAddProject.mockResolvedValueOnce({
      project: { id: 'new-proj', name: 'New Project' },
      has_specrails: false,
    })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockSetActiveProjectId).toHaveBeenCalledWith('new-proj')
      expect(mockStartSetupWizard).toHaveBeenCalledWith('new-proj')
    })
  })

  it('cancel button closes the dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddProjectDialog open={true} onClose={onClose} />)
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    await user.click(cancelBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Claude and Codex provider toggles', async () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: /Claude/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Codex/i })).toBeInTheDocument()
  })

  it('Codex toggle is disabled with "not found" when codex is not on PATH', async () => {
    // Default fetch mock (in beforeEach) reports claude:true, codex:false.
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      const codexBtn = screen.getByRole('checkbox', { name: /Codex/i })
      expect(codexBtn).toBeDisabled()
      expect(codexBtn).toHaveTextContent(/not found/i)
    })
  })

  it('shows Add Project dialog title', async () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Add Project/i })).toBeInTheDocument()
  })

  it('Codex toggle is enabled when the server reports codex available (Stage C)', async () => {
    // Post-Stage-C: client honours the server's real codex availability.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ claude: true, codex: true }),
    })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      const codexBtn = screen.getByRole('checkbox', { name: /Codex/i })
      expect(codexBtn).not.toBeDisabled()
      // "not found" label is hidden when codex is available
      expect(codexBtn).not.toHaveTextContent(/not found/i)
    })
  })

  it('renders a Gemini toggle when the server reports it (data-driven, beta on)', async () => {
    // The provider list is data-driven: a beta-gated provider the server returns
    // appears with no per-provider edit. When the beta is off the server omits
    // gemini, so it never shows.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ claude: true, codex: true, gemini: true }),
    })

    render(<AddProjectDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      const geminiBtn = screen.getByRole('checkbox', { name: /Gemini/i })
      expect(geminiBtn).not.toBeDisabled()
      expect(geminiBtn).not.toHaveTextContent(/not found/i)
    })
  })

  it('selects both providers by default when both are available and submits both', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/available-providers')) return { ok: true, json: async () => ({ claude: true, codex: true }) }
      if (url.includes('/api/setup-prerequisites')) return { ok: true, json: async () => goodPrereqsStatus }
      return { ok: true, json: async () => ({}) }
    })
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Codex/i })).toHaveAttribute('aria-checked', 'true')
    })
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    await user.click(screen.getByTestId('add-project-submit'))
    await waitFor(() => {
      expect(mockAddProject).toHaveBeenCalledWith('/some/path', undefined, ['claude', 'codex'])
    })
  })
})
