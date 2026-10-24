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
