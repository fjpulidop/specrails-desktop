import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const desktop = vi.hoisted(() => ({ activeProjectId: 'proj-1' as string | null }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: desktop.activeProjectId }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }))
const refreshConversations = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../missions/context/AgentChatContext', () => ({ useAgentChat: () => ({ refreshConversations }) }))

import { toast } from 'sonner'
import { RecentlyDeletedSection } from '../RecentlyDeletedSection'

const SPEC = { ticket: { id: 12, title: 'Add dark mode' }, deletedAt: '2026-10-01T10:00:00.000Z', purgeAt: '2026-10-31T10:00:00.000Z' }
const MISSION = {
  conversation: { id: 'm-1', title: 'Plan the migration', pinned_project_id: 'proj-1' },
  deletedAt: '2026-10-02T10:00:00.000Z', purgeAt: '2026-11-01T10:00:00.000Z',
}

let specs: unknown[]
let missions: unknown[]
let calls: Array<{ url: string; method: string }>

function res(body: unknown, ok = true) { return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers({ "content-type": "application/json" }) } as Response }

beforeEach(() => {
  vi.clearAllMocks()
  desktop.activeProjectId = 'proj-1'
  specs = [SPEC]
  missions = [MISSION]
  calls = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (method === 'GET' && url.includes('/tickets/trash')) return res({ items: specs, retentionDays: 30 })
    if (method === 'GET' && url.includes('/conversations/trash')) return res({ items: missions, retentionDays: 30 })
    if (method === 'POST' && url.includes('/tickets/12/restore')) { specs = []; return res({ ok: true }) }
    if (method === 'POST' && url.includes('/conversations/m-1/restore')) { missions = []; return res({ ok: true, conversation: MISSION.conversation }) }
    if (method === 'DELETE' && url.includes('/tickets/trash/12')) { specs = []; return res({ ok: true }) }
    if (method === 'DELETE' && url.includes('/conversations/m-1')) { missions = []; return res({ ok: true }) }
    return res({})
  }) as never
})

describe('RecentlyDeletedSection', () => {
  it('lists deleted specs and missions of the active project with dates', async () => {
    render(<RecentlyDeletedSection />)
    expect(await screen.findByTestId('deleted-spec-12')).toHaveTextContent('#12 Add dark mode')
    expect(screen.getByTestId('deleted-mission-m-1')).toHaveTextContent('Plan the migration')
    expect(screen.getByTestId('deleted-spec-12')).toHaveTextContent(/Deleted .*removed for good/)
    expect(calls.some((c) => c.url.includes('/projects/proj-1/tickets/trash'))).toBe(true)
    expect(calls.some((c) => c.url.includes('conversations/trash?projectId=proj-1'))).toBe(true)
  })

  it('shows the EmptyState when nothing was deleted', async () => {
    specs = []; missions = []
    render(<RecentlyDeletedSection />)
    const empty = await screen.findByTestId('recently-deleted-empty')
    expect(empty).toHaveTextContent('Nothing recently deleted')
    expect(empty).toHaveTextContent('30 days')
  })

  it('shows an error state with Retry when loading fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => res({}, false))
    render(<RecentlyDeletedSection />)
    const err = await screen.findByTestId('recently-deleted-error')
    expect(err).toHaveTextContent("Couldn't load")
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('deleted-spec-12')).toBeInTheDocument()
  })

  it('Restore brings a spec back with no confirmation and drops it from the list', async () => {
    render(<RecentlyDeletedSection />)
    fireEvent.click(await screen.findByTestId('deleted-spec-12-restore'))
    await waitFor(() => expect(screen.queryByTestId('deleted-spec-12')).toBeNull())
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/projects/proj-1/tickets/12/restore'))).toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Restored “Add dark mode”')
  })

  it('Restore of a mission refreshes the mission list', async () => {
    render(<RecentlyDeletedSection />)
    fireEvent.click(await screen.findByTestId('deleted-mission-m-1-restore'))
    await waitFor(() => expect(screen.queryByTestId('deleted-mission-m-1')).toBeNull())
    expect(refreshConversations).toHaveBeenCalled()
  })

  it('Delete permanently asks first, and only the confirm deletes', async () => {
    render(<RecentlyDeletedSection />)
    fireEvent.click(await screen.findByTestId('deleted-spec-12-delete'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete permanently?')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)

    fireEvent.click(screen.getByTestId('deleted-spec-12-delete'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/tickets/trash/12'))).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('deleted-spec-12')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Deleted permanently')
  })

  it('permanently deleting a mission uses the permanent flag', async () => {
    render(<RecentlyDeletedSection />)
    fireEvent.click(await screen.findByTestId('deleted-mission-m-1-delete'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/conversations/m-1?permanent=1'))).toBe(true))
  })

  it('renders nothing without an active project', () => {
    desktop.activeProjectId = null
    const { container } = render(<RecentlyDeletedSection />)
    expect(container).toBeEmptyDOMElement()
  })
})
