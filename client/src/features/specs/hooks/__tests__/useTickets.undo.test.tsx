import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useTickets, type LocalTicket } from '../useTickets'
import { UndoProvider } from '../../../../hooks/useUndo'
import { purgeProjectCache } from '../../../../hooks/useProjectCache'

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({ registerHandler: vi.fn(), unregisterHandler: vi.fn(), connectionStatus: 'connected' as const }),
}))
let mockActiveProjectId: string | null = 'proj-1'
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ get activeProjectId() { return mockActiveProjectId } }),
}))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const toastFn = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>
  fn.success = vi.fn(); fn.error = vi.fn(); fn.dismiss = vi.fn()
  return fn
})
vi.mock('sonner', () => ({ toast: toastFn }))

function ticket(over: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 7, title: 'Fix login', description: '', status: 'todo', priority: 'medium', labels: ['bug'],
    assignee: null, prerequisites: [], metadata: {}, created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z', created_by: 'user', source: 'manual', ...over,
  } as LocalTicket
}

const wrapper = ({ children }: { children: ReactNode }) => <UndoProvider>{children}</UndoProvider>

let calls: Array<{ url: string; method: string; body?: unknown }>
function installFetch(listed: LocalTicket[]) {
  calls = []
  ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'GET') return { ok: true, json: async () => ({ tickets: listed }) } as Response
    return { ok: true, json: async () => ({ ok: true }) } as Response
  })
}
const lastAction = () => (toastFn.mock.calls.at(-1)![1] as { action: { onClick: () => void } }).action

describe('useTickets: undo instead of confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    purgeProjectCache('proj-1')
    mockActiveProjectId = 'proj-1'
  })

  async function setup(listed = [ticket()]) {
    installFetch(listed)
    const hook = renderHook(() => useTickets(), { wrapper })
    await waitFor(() => expect(hook.result.current.tickets).toHaveLength(listed.length))
    return hook
  }

  it('delete applies at once and the toast Undo restores the spec', async () => {
    const { result } = await setup()
    await act(async () => { expect(await result.current.deleteTicket(7)).toBe(true) })
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/projects/proj-1/tickets/7'))).toBe(true)
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Deleted “Fix login”')
    // A deleted spec stays in Recently deleted: the toast says so.
    expect((toastFn.mock.calls.at(-1)![1] as { description: string }).description).toMatch(/kept 30 days in Recently deleted$/)
    await act(async () => { lastAction().onClick() })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/projects/proj-1/tickets/7/restore'))).toBe(true)
  })

  it('⌘Z restores the deleted spec', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.deleteTicket(7) })
    await act(async () => { fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', metaKey: true }) })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/tickets/7/restore'))).toBe(true)
  })

  it('⌘Z in another project does not restore it; Undo targets the project of the delete', async () => {
    const { result, rerender } = await setup()
    await act(async () => { await result.current.deleteTicket(7) })
    const action = lastAction()
    mockActiveProjectId = 'proj-2'
    rerender()
    await act(async () => { fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', metaKey: true }) })
    expect(calls.some((c) => c.url.endsWith('/restore'))).toBe(false)
    // The (dismissed) toast's button still addresses proj-1, never the active project.
    await act(async () => { action.onClick() })
    const restore = calls.find((c) => c.url.endsWith('/restore'))
    expect(restore?.url).toContain('/projects/proj-1/')
  })

  it('a failed delete shows no Undo', async () => {
    const { result } = await setup()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
    await act(async () => { expect(await result.current.deleteTicket(7)).toBe(false) })
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('a status move offers Undo that moves it back', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.updateTicketStatus(7, 'done') })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'done' })
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Moved #7 to Done')
    await act(async () => { lastAction().onClick() })
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.at(-1)?.body).toEqual({ status: 'todo' })
  })

  it('a label change offers Undo that restores the previous labels', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.updateTicket(7, { labels: ['bug', 'urgent'] }) })
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Labels updated on #7')
    await act(async () => { lastAction().onClick() })
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ labels: ['bug'] })
  })

  it('an edit that does not touch labels offers no Undo', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.updateTicket(7, { title: 'Renamed' }) })
    expect(toastFn).not.toHaveBeenCalled()
  })
})

describe('useTickets: bulk changes with ONE grouped undo (CD4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    purgeProjectCache('proj-1')
    mockActiveProjectId = 'proj-1'
  })

  const three = () => [ticket({ id: 1, title: 'One', labels: ['bug'] }), ticket({ id: 2, title: 'Two', labels: [] }), ticket({ id: 3, title: 'Three', status: 'in_progress', priority: 'low' })]

  async function setup(listed = three()) {
    installFetch(listed)
    const hook = renderHook(() => useTickets(), { wrapper })
    await waitFor(() => expect(hook.result.current.tickets).toHaveLength(listed.length))
    calls.length = 0
    return hook
  }
  const undoToasts = () => toastFn.mock.calls.filter(([, opts]) => (opts as { action?: unknown } | undefined)?.action)

  it('bulk delete runs the per-spec DELETE, refetches once and pushes ONE Undo that restores all', async () => {
    const { result } = await setup()
    let outcome: Awaited<ReturnType<typeof result.current.bulkDelete>> | undefined
    await act(async () => { outcome = await result.current.bulkDelete([1, 2, 3]) })
    expect(outcome).toMatchObject({ ok: [1, 2, 3], failed: [], undoable: true })
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop())).toEqual(['1', '2', '3'])
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
    expect(undoToasts()).toHaveLength(1)
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Deleted 3 specs')
    expect((toastFn.mock.calls.at(-1)![1] as { description: string }).description).toMatch(/Recently deleted$/)
    calls.length = 0
    await act(async () => { lastAction().onClick() })
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url.split('/').slice(-2).join('/'))).toEqual(['3/restore', '2/restore', '1/restore'])
  })

  it('a partial failure reports the failed ids and the Undo only covers what succeeded', async () => {
    const { result } = await setup()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'DELETE' && url.endsWith('/2')) return { ok: false, status: 500, json: async () => ({}) } as Response
      if (method === 'GET') return { ok: true, json: async () => ({ tickets: three() }) } as Response
      return { ok: true, json: async () => ({ ok: true }) } as Response
    })
    let outcome: Awaited<ReturnType<typeof result.current.bulkDelete>> | undefined
    await act(async () => { outcome = await result.current.bulkDelete([1, 2, 3]) })
    expect(outcome).toMatchObject({ ok: [1, 3], failed: [2] })
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Deleted 2 specs')
    calls.length = 0
    await act(async () => { lastAction().onClick() })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('when everything fails there is no Undo', async () => {
    const { result } = await setup()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => (
      (init?.method ?? 'GET') === 'GET' ? ({ ok: true, json: async () => ({ tickets: three() }) } as Response) : ({ ok: false, status: 500, json: async () => ({}) } as Response)
    ))
    let outcome: Awaited<ReturnType<typeof result.current.bulkDelete>> | undefined
    await act(async () => { outcome = await result.current.bulkDelete([1, 2]) })
    expect(outcome).toMatchObject({ ok: [], failed: [1, 2], undoable: false })
    expect(undoToasts()).toHaveLength(0)
  })

  it('bulk status uses the status handler per spec and Undo moves each back to ITS previous status', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.bulkUpdateStatus([1, 3], 'done') })
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ status: 'done' }, { status: 'done' }])
    expect(undoToasts()).toHaveLength(1)
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Moved 2 specs to Done')
    calls.length = 0
    await act(async () => { lastAction().onClick() })
    const patches = calls.filter((c) => c.method === 'PATCH')
    // Reverse order; spec 3 was in progress, spec 1 was todo.
    expect(patches.map((p) => [p.url.split('/').pop(), p.body])).toEqual([['3', { status: 'in_progress' }], ['1', { status: 'todo' }]])
  })

  it('a move that changes nothing offers no Undo', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.bulkUpdateStatus([1], 'todo') })
    expect(undoToasts()).toHaveLength(0)
  })

  it('bulk labels add and remove per spec; a spec the change would not alter is skipped; Undo restores each previous set', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.bulkUpdateLabels([1, 2], { add: ['bug', 'ui'] }) })
    // #1 already has bug → gains ui; #2 gains both.
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url.split('/').pop(), c.body])).toEqual([['1', { labels: ['bug', 'ui'] }], ['2', { labels: ['bug', 'ui'] }]])
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Labels updated on 2 specs')
    calls.length = 0
    await act(async () => { lastAction().onClick() })
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url.split('/').pop(), c.body])).toEqual([['2', { labels: [] }], ['1', { labels: ['bug'] }]])
  })

  it('removing a label nobody has changes nothing and offers no Undo', async () => {
    const { result } = await setup()
    let outcome: Awaited<ReturnType<typeof result.current.bulkUpdateLabels>> | undefined
    await act(async () => { outcome = await result.current.bulkUpdateLabels([2], { remove: ['bug'] }) })
    expect(outcome).toMatchObject({ ok: [2], failed: [], undoable: false })
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('bulk priority is undoable as a group', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.bulkUpdatePriority([1, 3], 'critical') })
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ priority: 'critical' }, { priority: 'critical' }])
    expect(toastFn.mock.calls.at(-1)![0]).toBe('Priority changed on 2 specs')
    calls.length = 0
    await act(async () => { lastAction().onClick() })
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url.split('/').pop(), c.body])).toEqual([['3', { priority: 'low' }], ['1', { priority: 'medium' }]])
  })

  it('a single priority edit still pushes no Undo', async () => {
    const { result } = await setup()
    await act(async () => { await result.current.updateTicketPriority(1, 'high') })
    expect(undoToasts()).toHaveLength(0)
  })

  it('with no active project nothing is sent', async () => {
    const { result } = await setup()
    mockActiveProjectId = null
    const { result: r2 } = renderHook(() => useTickets(), { wrapper })
    calls.length = 0
    let outcome: Awaited<ReturnType<typeof r2.current.bulkDelete>> | undefined
    await act(async () => { outcome = await r2.current.bulkDelete([1, 2]) })
    expect(outcome).toMatchObject({ ok: [], failed: [1, 2] })
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    void result
  })
})
