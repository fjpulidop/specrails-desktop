import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../lib/feature-flags', () => ({ FEATURE_CODE_EXPLORER: true }))
const state = vi.hoisted(() => ({ projectId: 'p1' }))
vi.mock('../../../lib/api', () => ({ getApiBase: () => `/api/projects/${state.projectId}` }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: state.projectId }) }))
const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})
import { TicketFilesTouched } from '../TicketFilesTouched'

const row = (id: number, repositoryId: string, filePath = 'src/index.ts', jobId: string | null = 'run') => ({ id, repositoryId, repositoryName: repositoryId, path: filePath, kind: 'modified', jobId, at: id })
const page = (entries: unknown[] = [], nextCursor: string | null = null, truncated = false) => ({ ok: true, json: async () => ({ entries, nextCursor, truncated }) })
function renderSection(ticketId = 7, onClose = vi.fn()) {
  return render(<MemoryRouter><TicketFilesTouched ticketId={ticketId} onClose={onClose} /></MemoryRouter>)
}
beforeEach(() => { navigate.mockClear(); state.projectId = 'p1' })

describe('TicketFilesTouched', () => {
  it('hides only a successfully loaded, complete empty history', async () => {
    global.fetch = vi.fn().mockResolvedValue(page())
    const { container } = renderSection()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledOnce())
    await waitFor(() => expect(container.firstChild).toBeNull())
  })
  it('retains repository and recorded job when identical paths in two repositories are opened', async () => {
    global.fetch = vi.fn().mockResolvedValue(page([row(3, 'backend'), row(2, 'frontend'), row(1, 'backend')]))
    const onClose = vi.fn()
    renderSection(7, onClose)
    await screen.findByText('backend')
    expect(screen.getAllByText('src/index.ts')).toHaveLength(2)
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/code/activity?ticketId=7&limit=50', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    fireEvent.click(screen.getByText('backend'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/code?repositoryId=backend&path=src%2Findex.ts&changeJobId=run')
  })
  it('loads continuation pages while preserving files and avoiding duplicate repository/path rows', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([row(3, 'backend')], 'opaque-cursor'))
      .mockResolvedValueOnce(page([row(2, 'backend'), row(1, 'frontend', 'deleted.ts', null)]))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /load more files|ticketFiles.loadMore/i }))
    await screen.findByText('deleted.ts')
    expect(screen.getAllByText('src/index.ts')).toHaveLength(1)
    expect(global.fetch).toHaveBeenLastCalledWith(expect.stringContaining('cursor=opaque-cursor'), expect.anything())
    fireEvent.click(screen.getByText('deleted.ts'))
    expect(navigate).toHaveBeenCalledWith('/code?repositoryId=frontend&path=deleted.ts')
  })
  it.each(['network', 'http'])('shows %s failures and allows retry instead of hiding them as no history', async failure => {
    global.fetch = failure === 'network' ? vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([row(1, 'backend')]))
      : vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(page([row(1, 'backend')]))
    renderSection()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry|ticketFiles.retry/i }))
    await screen.findByText('backend')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('does not hide a partial empty scan, and refreshes it on retry', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([], null, true)).mockResolvedValueOnce(page([row(1, 'backend')]))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: /retry|ticketFiles.retry/i }))
    await screen.findByText('backend')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
  it('ignores late responses after a project switch even if the fetch ignores cancellation', async () => {
    let resolveOld!: (value: ReturnType<typeof page>) => void
    global.fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(page([row(2, 'new-repo', 'new.ts')]))
    const view = renderSection()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledOnce())
    const oldSignal = vi.mocked(global.fetch).mock.calls[0][1]?.signal
    state.projectId = 'p2'
    view.rerender(<MemoryRouter><TicketFilesTouched ticketId={7} onClose={vi.fn()} /></MemoryRouter>)
    await screen.findByText('new.ts')
    await act(async () => { resolveOld(page([row(1, 'old-repo', 'old.ts')])) })
    expect(oldSignal?.aborted).toBe(true)
    expect(screen.queryByText('old.ts')).not.toBeInTheDocument()
    expect(screen.getByText('new.ts')).toBeInTheDocument()
  })
})
