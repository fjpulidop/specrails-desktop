import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within, act } from '../../../test-utils'
import { ProjectRepositoriesSection } from '../ProjectRepositoriesSection'
import type { DesktopProject } from '../../../hooks/useDesktop'
import type { ProjectRepository } from '../../../lib/project-repositories'

const desktop = vi.hoisted(() => ({ activeProjectId: 'p1' as string | null, projects: [] as DesktopProject[], refreshProjects: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))
const primary: ProjectRepository = { id: 'primary-p1', projectId: 'p1', name: 'App', path: '/projects/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }
const api: ProjectRepository = { ...primary, id: 'api', name: 'API', path: '/projects/api', isPrimary: false, integrationBranch: 'develop' }
const makeProject = (id: string, repositories: ProjectRepository[]): DesktopProject => ({ id, slug: id, name: id, path: repositories[0].path, db_path: '', provider: 'claude', providers: ['claude'], added_at: '', last_seen_at: '', repositories })
const response = (value: unknown, ok = true, status = ok ? 200 : 409) => ({ ok, status, json: async () => value })
beforeEach(() => {
  vi.clearAllMocks(); desktop.refreshProjects.mockResolvedValue(undefined)
  desktop.activeProjectId = 'p1'; desktop.projects = [makeProject('p1', [primary, api])]
  global.fetch = vi.fn().mockResolvedValue(response({ repositories: [primary, api] }))
})

describe('ProjectRepositoriesSection', () => {
  it('protects primary path while allowing primary name and branch edits', async () => {
    const user = userEvent.setup()
    render(<ProjectRepositoriesSection />)
    const primaryRow = screen.getByText('App').parentElement!
    expect(within(primaryRow).queryByRole('button', { name: 'Detach' })).not.toBeInTheDocument()
    await user.click(within(primaryRow).getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toBeDisabled()
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed app')
    await user.type(screen.getByRole('textbox', { name: 'Integration branch' }), 'main')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(desktop.refreshProjects).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/repositories/primary-p1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Renamed app', integrationBranch: 'main' }) }))
  })

  it('adds a member, refreshes the inventory and preserves IDs when only renaming a referenced secondary', async () => {
    const user = userEvent.setup()
    const shared = { ...api, id: 'shared', name: 'Shared', path: '/projects/shared', integrationBranch: null }
    vi.mocked(fetch).mockResolvedValue(response({ repositories: [primary, api, shared] }) as Response)
    render(<ProjectRepositoriesSection />)
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' Shared ')
    await user.type(screen.getByRole('textbox', { name: 'Folder path' }), ' /projects/shared ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Shared')
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/repositories', expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/projects/shared', name: 'Shared', integrationBranch: null }) }))
    await user.click(within(screen.getByText('API').parentElement!).getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Backend')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p1/repositories/api', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Backend', integrationBranch: 'develop' }) })))
  })

  it('shows the server reference guard and retains the member until a successful detach', async () => {
    const user = userEvent.setup()
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'Repository is referenced by specs or pending deliveries' }, false) as Response)
    render(<ProjectRepositoriesSection />)
    await user.click(screen.getByRole('button', { name: 'Detach' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('referenced by specs')
    expect(screen.getByText('API')).toBeInTheDocument()
    expect(desktop.refreshProjects).not.toHaveBeenCalled()
    vi.mocked(fetch).mockResolvedValue(response({ repositories: [primary] }) as Response)
    await user.click(screen.getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(screen.queryByText('API')).not.toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/repositories/api', expect.objectContaining({ method: 'DELETE' }))
  })

  it('keeps a pending mutation bound to its original project after the user switches projects', async () => {
    const user = userEvent.setup()
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { rerender } = render(<ProjectRepositoriesSection />)
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    await user.type(screen.getByRole('textbox', { name: 'Folder path' }), '/projects/shared')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const b = { ...primary, id: 'primary-p2', projectId: 'p2', name: 'Other project', path: '/other' }
    desktop.projects = [...desktop.projects, makeProject('p2', [b])]; desktop.activeProjectId = 'p2'
    rerender(<ProjectRepositoriesSection />)
    expect(screen.getByText('Other project')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).not.toBeInTheDocument()
    await act(async () => finish(response({ ok: true }) as Response))
    await waitFor(() => expect(desktop.refreshProjects).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/repositories', { cache: 'no-store' })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/p2/'))).toBe(false)
    expect(screen.getByText('Other project')).toBeInTheDocument()
    expect(screen.queryByText('API')).not.toBeInTheDocument()
  })

  it('renders no repository editor without an active project', () => {
    desktop.activeProjectId = null
    const { container } = render(<ProjectRepositoriesSection />)
    expect(container).toBeEmptyDOMElement()
  })
})
