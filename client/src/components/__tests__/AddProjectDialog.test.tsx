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

const mockSetActiveProjectId = vi.fn()
const mockAddProject = vi.fn()

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    setActiveProjectId: mockSetActiveProjectId,
    projects: [],
    activeProjectId: null,
    isLoading: false,
    addProject: mockAddProject,
    removeProject: vi.fn(),
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
      expect(mockAddProject).toHaveBeenCalledWith('/some/path', undefined)
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

  it('has_specrails=false no longer opens any wizard — silent add closes the dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mockAddProject.mockResolvedValueOnce({
      project: { id: 'new-proj', name: 'New Project' },
      has_specrails: false,
    })

    render(<AddProjectDialog open={true} onClose={onClose} />)
    const pathInput = screen.getByPlaceholderText('/Users/me/my-project')
    await user.type(pathInput, '/some/path')
    const addBtn = screen.getByRole('button', { name: /Add Project/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
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

  it('shows Add Project dialog title', async () => {
    render(<AddProjectDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Add Project/i })).toBeInTheDocument()
  })

})
