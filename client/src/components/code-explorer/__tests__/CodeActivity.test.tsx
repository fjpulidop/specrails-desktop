import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  repositoryId: 'frontend', repositoryPath: '/fixture/frontend',
  handlers: new Map<string, (message: unknown) => void>(),
  registerHandler: vi.fn(), unregisterHandler: vi.fn(),
}))
vi.mock('../CodeRepositoryContext', () => ({ useCodeRepository: () => ({ repositoryId: state.repositoryId, repositoryPath: state.repositoryPath }) }))
vi.mock('../../../lib/project-repositories', () => ({ repositoryApiBase: (projectId: string) => `/api/projects/${projectId}` }))
vi.mock('../../../hooks/useSharedWebSocket', () => ({ useSharedWebSocket: () => ({ registerHandler: state.registerHandler, unregisterHandler: state.unregisterHandler }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options?.ticketId ? `${key} ${options.ticketId}` : key, i18n: { language: 'en' } }) }))
import { CodeActivity } from '../CodeActivity'

type Props = ComponentProps<typeof CodeActivity>
const at = Date.UTC(2026, 8, 6, 10, 0)
const entry = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, repositoryId: 'frontend', repositoryName: 'Frontend', path: `src/file-${id}.ts`,
  jobId: 'run-frontend', ticketId: 7, kind: 'modified', at, hasPatch: true, patchTruncated: false, ...overrides,
})
const page = (entries: unknown[] = [], nextCursor: string | null = null, truncated = false) => ({
  ok: true, json: async () => ({ entries, nextCursor, truncated }),
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function view(overrides: Partial<Props> = {}) {
  const props: Props = { projectId: 'project-one', repositoryName: 'Frontend', multipleRepositories: true, onOpen: vi.fn(), ...overrides }
  return { ...render(<CodeActivity {...props} />), props }
}
beforeEach(() => {
  state.repositoryId = 'frontend'; state.repositoryPath = '/fixture/frontend'
  state.handlers.clear(); state.registerHandler.mockReset(); state.unregisterHandler.mockReset()
  state.registerHandler.mockImplementation((id: string, handler: (message: unknown) => void) => state.handlers.set(id, handler))
  state.unregisterHandler.mockImplementation((id: string) => state.handlers.delete(id))
})
afterEach(() => { vi.useRealTimers() })

describe('recorded code activity', () => {
  it('opens identical paths in their recorded repositories and uses millisecond timestamps', async () => {
    global.fetch = vi.fn().mockResolvedValue(page([
      entry(2, { repositoryId: 'backend', repositoryName: 'Backend', path: 'src/index.ts', jobId: 'run-backend' }),
      entry(1, { path: 'src/index.ts' }),
    ]))
    const { props, container } = view({ jobId: 'filter-job', ticketId: 7 })
    const files = await screen.findAllByRole('button', { name: /src\/index.ts/ })
    fireEvent.click(files[0]); fireEvent.click(files[1])
    expect(props.onOpen).toHaveBeenNthCalledWith(1, { repositoryId: 'backend', path: 'src/index.ts', changeJobId: 'run-backend' })
    expect(props.onOpen).toHaveBeenNthCalledWith(2, { repositoryId: 'frontend', path: 'src/index.ts', changeJobId: 'run-frontend' })
    expect(container.querySelector('time')?.dateTime).toBe('2026-09-06T10:00:00.000Z')
    const url = new URL(vi.mocked(global.fetch).mock.calls[0][0] as string, 'http://fixture')
    expect(url.pathname).toBe('/api/projects/project-one/code/activity')
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', jobId: 'filter-job', ticketId: '7' })
  })

  it('appends bounded pages and deduplicates by provenance id rather than relative path', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([entry(3, { path: 'same.ts' })], 'cursor-one'))
      .mockResolvedValueOnce(page([entry(3, { path: 'same.ts' }), entry(2, { path: 'same.ts', repositoryId: 'backend', repositoryName: 'Backend' })], 'cursor-two'))
      .mockResolvedValueOnce(page([entry(1, { path: 'last.ts' })]))
    view()
    fireEvent.click(await screen.findByRole('button', { name: 'activity.loadMore' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /same.ts/ })).toHaveLength(2))
    expect(vi.mocked(global.fetch).mock.calls[1][0]).toContain('cursor=cursor-one')
    fireEvent.click(screen.getByRole('button', { name: 'activity.loadMore' }))
    await screen.findByRole('button', { name: /last.ts/ })
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'activity.loadMore' })).not.toBeInTheDocument()
    expect(vi.mocked(global.fetch).mock.calls[2][0]).toContain('cursor=cursor-two')
  })

  it.each(['network', 'http'])('surfaces initial %s failures and retries the same scoped query', async failure => {
    global.fetch = failure === 'network' ? vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([entry(1)]))
      : vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(page([entry(1)]))
    view({ multipleRepositories: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('activity.failed')
    fireEvent.click(screen.getByRole('button', { name: 'explore.retry' }))
    await screen.findByRole('button', { name: /src\/file-1.ts/ })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(vi.mocked(global.fetch).mock.calls[1][0]).toBe(vi.mocked(global.fetch).mock.calls[0][0])
    expect(vi.mocked(global.fetch).mock.calls[1][0]).toContain('repositoryId=frontend')
  })

  it('preserves loaded records while retrying a failed continuation page', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([entry(2)], 'resume-cursor'))
      .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(page([entry(1)]))
    view()
    fireEvent.click(await screen.findByRole('button', { name: 'activity.loadMore' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: /src\/file-2.ts/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'explore.retry' }))
    await screen.findByRole('button', { name: /src\/file-1.ts/ })
    expect(vi.mocked(global.fetch).mock.calls[2][0]).toContain('cursor=resume-cursor')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('distinguishes missing and partial patches, and does not call a partial empty scan complete', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([
      entry(2, { path: 'deleted.ts', kind: 'deleted', hasPatch: false, jobId: null }),
      entry(1, { path: 'partial.ts', patchTruncated: true }),
    ], null, true)).mockResolvedValueOnce(page([], null, true))
    const { props } = view()
    const missing = await screen.findByRole('button', { name: /deleted.ts/ })
    expect(missing).toHaveTextContent('activity.noPatch')
    expect(screen.getByRole('button', { name: /partial.ts/ })).toHaveTextContent('activity.partialPatch')
    expect(screen.getByRole('status')).toHaveTextContent('activity.partial')
    fireEvent.click(missing)
    expect(props.onOpen).toHaveBeenCalledWith({ repositoryId: 'frontend', path: 'deleted.ts', changeJobId: null })
    fireEvent.click(screen.getByRole('button', { name: 'explore.refresh' }))
    await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'explore.refresh' })).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('activity.partial')
    expect(screen.queryByText('activity.empty')).not.toBeInTheDocument()
  })

  it('shows each spec identity when a batch shares one repository and job', async () => {
    global.fetch = vi.fn().mockResolvedValue(page([entry(2, { ticketId: 7 }), entry(1, { ticketId: 8 })]))
    view()
    await screen.findByRole('button', { name: /src\/file-1.ts/ })
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('story.spec 7')).toBeInTheDocument()
    expect(within(rows[1]).getByText('story.spec 8')).toBeInTheDocument()
  })

  it('ignores late all-repository data after switching to the current repository', async () => {
    const old = deferred<ReturnType<typeof page>>()
    global.fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([entry(1, { path: 'current.ts' })]))
    view()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByRole('combobox', { name: 'activity.scope' }), { target: { value: 'current' } })
    await screen.findByRole('button', { name: /current.ts/ })
    await act(async () => old.resolve(page([entry(2, { path: 'stale.ts', repositoryId: 'backend' })])))
    expect(screen.queryByRole('button', { name: /stale.ts/ })).not.toBeInTheDocument()
    expect(vi.mocked(global.fetch).mock.calls[1][0]).toContain('repositoryId=frontend')
    expect(vi.mocked(global.fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('cancels old continuation requests across project, repository and ticket changes', async () => {
    const old = deferred<ReturnType<typeof page>>()
    global.fetch = vi.fn().mockResolvedValueOnce(page([entry(3, { path: 'old-page.ts' })], 'old-cursor'))
      .mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([entry(1, { path: 'new-project.ts', repositoryId: 'other-repo', ticketId: 9 })]))
    const { props, rerender } = view({ multipleRepositories: false, ticketId: 7 })
    fireEvent.click(await screen.findByRole('button', { name: 'activity.loadMore' }))
    state.repositoryId = 'other-repo'; state.repositoryPath = '/fixture/other'
    rerender(<CodeActivity {...props} projectId="project-two" ticketId={9} />)
    await screen.findByRole('button', { name: /new-project.ts/ })
    await act(async () => old.resolve(page([entry(2, { path: 'late-old-page.ts' })])))
    expect(screen.queryByText('old-page.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('late-old-page.ts')).not.toBeInTheDocument()
    const finalUrl = vi.mocked(global.fetch).mock.calls[2][0] as string
    expect(finalUrl).toContain('/projects/project-two/code/activity?')
    expect(finalUrl).toContain('repositoryId=other-repo'); expect(finalUrl).toContain('ticketId=9')
    expect(finalUrl).not.toContain('cursor=')
    expect(vi.mocked(global.fetch).mock.calls[1][1]?.signal?.aborted).toBe(true)
  })

  it('rejects non-advancing cursors and retains the previously loaded page', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(page([entry(2)], 'same')).mockResolvedValueOnce(page([entry(1)], 'same'))
    view()
    fireEvent.click(await screen.findByRole('button', { name: 'activity.loadMore' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: /src\/file-2.ts/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /src\/file-1.ts/ })).not.toBeInTheDocument()
  })

  it('keeps simultaneous explorers subscribed independently and coalesces matching updates', async () => {
    global.fetch = vi.fn().mockResolvedValue(page([entry(1)]))
    const first = view()
    const second = view()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('activity.loading')).not.toBeInTheDocument())
    expect(state.handlers.size).toBe(2)
    first.unmount()
    expect(state.handlers.size).toBe(1)
    vi.useFakeTimers()
    const receive = [...state.handlers.values()][0]
    await act(async () => {
      receive({ type: 'file.provenance_updated', projectId: 'different-project' })
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    await act(async () => {
      for (let i = 0; i < 5; i++) receive({ type: 'file.provenance_updated', projectId: 'project-one' })
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(global.fetch).toHaveBeenCalledTimes(3)
    second.unmount()
    expect(state.handlers.size).toBe(0)
  })
})
