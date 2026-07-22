import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { SharedWebSocketContext } from '../../hooks/useSharedWebSocket'
import {
  MinimizedChatsProvider,
  useMinimizedChats,
  usePendingRestore,
  loadFromStorage,
  saveToStorage,
  type MinimizedChat,
} from '../MinimizedChatsContext'

const fakeWs = {
  registerHandler: () => {},
  unregisterHandler: () => {},
  connectionStatus: 'connected' as const,
}

const STORAGE_KEY = 'specrails-desktop:minimized-chats'
const PENDING_KEY = 'specrails-desktop:minimized-chats-pending'

// ─── Desktop mock ────────────────────────────────────────────────────────────

const desktopState = {
  projects: [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
  ] as Array<{ id: string; name: string }>,
  activeProjectId: 'p1' as string | null,
}
const setActiveProjectIdSpy = vi.fn((id: string | null) => {
  desktopState.activeProjectId = id
})

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: desktopState.projects,
    activeProjectId: desktopState.activeProjectId,
    setActiveProjectId: setActiveProjectIdSpy,
  }),
}))

// ─── Test harness ────────────────────────────────────────────────────────

function MinimizeButton({
  kind = 'explore-spec' as const,
  projectId = 'p1',
  label = 'Test spec',
  restoreRoute = '/',
  resumeConversationId = 'conv-1' as string | undefined,
  resumeRefineId = 'ref-1' as string | undefined,
}) {
  const { minimize } = useMinimizedChats()
  return (
    <button
      data-testid="do-minimize"
      onClick={() =>
        minimize({
          kind,
          projectId,
          label,
          restoreRoute,
          params:
            kind === 'explore-spec'
              ? {
                  initialIdea: 'idea',
                  pendingSpecId: 'pending-1',
                  initialAttachmentIds: [],
                  resumeConversationId,
                }
              : { agentId: 'sr-developer', baseBody: '---\nname: x\n---\n', resumeRefineId },
        })
      }
    >
      minimize
    </button>
  )
}

/** Drives context internals WITHOUT rendering chat labels, so label assertions
 *  stay unambiguous against the provider-rendered dock. */
function Probe() {
  const { chats, restore, close, updateLabel } = useMinimizedChats()
  return (
    <div>
      <span data-testid="chat-count">{chats.length}</span>
      <button data-testid="probe-restore-first" onClick={() => chats[0] && restore(chats[0].id)}>
        restore-first
      </button>
      <button data-testid="probe-close-first" onClick={() => chats[0] && close(chats[0].id)}>
        close-first
      </button>
      <button data-testid="probe-rename-first" onClick={() => chats[0] && updateLabel(chats[0].id, 'Renamed live')}>
        rename-first
      </button>
    </div>
  )
}

function PendingRestoreSpy({ kind, projectId }: { kind: 'explore-spec' | 'ai-edit'; projectId: string }) {
  usePendingRestore(kind, projectId, (chat) => {
    spyRestoreCallback(chat)
  })
  return <span data-testid="pending-spy" />
}

const spyRestoreCallback = vi.fn()

function LocationProbe() {
  const loc = useLocation()
  return <span data-testid="path">{loc.pathname}</span>
}

function renderWithProvider(ui: React.ReactNode, route = '/') {
  return render(
    <SharedWebSocketContext.Provider value={fakeWs}>
      <MemoryRouter initialEntries={[route]}>
        <MinimizedChatsProvider>
          <Routes>
            <Route path="*" element={<>{ui}<LocationProbe /></>} />
          </Routes>
        </MinimizedChatsProvider>
      </MemoryRouter>
    </SharedWebSocketContext.Provider>,
  )
}

function dockLabels(): string[] {
  const dock = screen.queryByTestId('minimized-chats-dock')
  if (!dock) return []
  return Array.from(dock.querySelectorAll('[data-testid^="minimized-chat-chip-"]')).map(
    (el) => (el.querySelector('.truncate')?.textContent ?? '').trim(),
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('MinimizedChatsContext', () => {
  beforeEach(() => {
    localStorage.clear()
    desktopState.projects = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ]
    desktopState.activeProjectId = 'p1'
    setActiveProjectIdSpy.mockClear()
    spyRestoreCallback.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('minimize adds a chip to the dock and persists synchronously to localStorage', async () => {
    const user = userEvent.setup()
    renderWithProvider(<MinimizeButton />)

    await user.click(screen.getByTestId('do-minimize'))

    expect(screen.getByText('Test spec')).toBeTruthy()
    // Synchronous durability: the entry is in localStorage immediately (the
    // minimize() callback writes before yielding, not only via the effect).
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MinimizedChat[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0].label).toBe('Test spec')
    expect(persisted[0].kind).toBe('explore-spec')
  })

  it('close drops the chip from the dock and from localStorage', async () => {
    const user = userEvent.setup()
    renderWithProvider(<><MinimizeButton /><Probe /></>)
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByText('Test spec')).toBeTruthy()

    await user.click(screen.getByTestId('probe-close-first'))

    expect(screen.queryByText('Test spec')).toBeNull()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([])
  })

  it('restore navigates to the chat route, switches project, and queues pending restore', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <>
        <MinimizeButton kind="ai-edit" projectId="p2" label="AI Edit · sr-developer" restoreRoute="/agents" />
        <Probe />
        <PendingRestoreSpy kind="ai-edit" projectId="p2" />
      </>,
      '/',
    )

    await user.click(screen.getByTestId('do-minimize'))
    await act(async () => {
      screen.getByTestId('probe-restore-first').click()
    })

    expect(setActiveProjectIdSpy).toHaveBeenCalledWith('p2')
    expect(screen.getByTestId('path').textContent).toBe('/agents')
    expect(spyRestoreCallback).toHaveBeenCalledTimes(1)
    expect(spyRestoreCallback.mock.calls[0][0]).toMatchObject({
      kind: 'ai-edit',
      params: { agentId: 'sr-developer', resumeRefineId: 'ref-1' },
    })
    // Chip removed from dock after restore (consumed → not re-added).
    expect(screen.queryByText('AI Edit · sr-developer')).toBeNull()
  })

  it('drops chips silently when the owning project disappears', async () => {
    const user = userEvent.setup()
    const { rerender } = renderWithProvider(<MinimizeButton projectId="p2" />)
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByText('Test spec')).toBeTruthy()

    desktopState.projects = [{ id: 'p1', name: 'Alpha' }]
    rerender(
      <SharedWebSocketContext.Provider value={fakeWs}>
        <MemoryRouter initialEntries={['/']}>
          <MinimizedChatsProvider>
            <Routes>
              <Route path="*" element={<MinimizeButton projectId="p2" />} />
            </Routes>
          </MinimizedChatsProvider>
        </MemoryRouter>
      </SharedWebSocketContext.Provider>,
    )

    expect(screen.queryByText('Test spec')).toBeNull()
  })

  it('hydrates from localStorage on mount and renders the chip in the dock', () => {
    const seed: MinimizedChat[] = [
      {
        id: 'seed-1',
        kind: 'explore-spec',
        projectId: 'p1',
        label: 'Resumed spec',
        restoreRoute: '/',
        createdAt: 1000,
        params: { initialIdea: 'i', pendingSpecId: 'p', initialAttachmentIds: [] },
      },
    ]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))

    renderWithProvider(<span />)

    expect(screen.getByText('Resumed spec')).toBeTruthy()
  })

  it('recovers orphaned pending restores into the dock on mount and clears the pending store', async () => {
    // Simulates a refresh that landed AFTER a restore click but BEFORE the
    // trigger consumed it: the pending store holds the only copy.
    const orphan: MinimizedChat[] = [
      {
        id: 'orphan-1',
        kind: 'explore-spec',
        projectId: 'p1',
        label: 'Orphaned spec',
        restoreRoute: '/',
        createdAt: 5,
        params: { initialIdea: 'i', pendingSpecId: 'p', initialAttachmentIds: [], resumeConversationId: 'c-orphan' },
      },
    ]
    localStorage.setItem(PENDING_KEY, JSON.stringify(orphan))

    renderWithProvider(<span />)

    await waitFor(() => expect(screen.getByText('Orphaned spec')).toBeTruthy())
    // Pending store cleared; chat folded into the durable dock store.
    expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')).toEqual([])
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MinimizedChat[]
    expect(persisted.map((c) => c.id)).toContain('orphan-1')
  })

  it('watchdog re-adds a restored chip to the dock if no trigger consumes it', async () => {
    vi.useFakeTimers()
    try {
      // No PendingRestoreSpy → nothing consumes the pending restore.
      render(
        <SharedWebSocketContext.Provider value={fakeWs}>
          <MemoryRouter initialEntries={['/']}>
            <MinimizedChatsProvider>
              <MinimizeButton label="Stranded spec" />
              <Probe />
            </MinimizedChatsProvider>
          </MemoryRouter>
        </SharedWebSocketContext.Provider>,
      )

      act(() => {
        screen.getByTestId('do-minimize').click()
      })
      expect(screen.getByText('Stranded spec')).toBeTruthy()

      act(() => {
        screen.getByTestId('probe-restore-first').click()
      })
      // Optimistically removed from the dock, parked in the pending store.
      expect(screen.queryByText('Stranded spec')).toBeNull()
      expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')).toHaveLength(1)

      // Watchdog fires → chip comes back, never lost.
      act(() => {
        vi.advanceTimersByTime(8000)
      })
      expect(screen.getByText('Stranded spec')).toBeTruthy()
      expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')).toEqual([])
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dedupes re-parked sessions: same conversation id yields a single chip', async () => {
    const user = userEvent.setup()
    renderWithProvider(<><MinimizeButton resumeConversationId="dup-conv" /><Probe /></>)

    await user.click(screen.getByTestId('do-minimize'))
    await user.click(screen.getByTestId('do-minimize'))

    expect(screen.getByTestId('chat-count').textContent).toBe('1')
    expect(dockLabels()).toEqual(['Test spec'])
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MinimizedChat[]
    expect(persisted).toHaveLength(1)
  })

  it('dedupes fresh sessions with no conversation id by their pendingSpecId', async () => {
    const user = userEvent.setup()
    renderWithProvider(<><MinimizeButton resumeConversationId={undefined} /><Probe /></>)
    await user.click(screen.getByTestId('do-minimize'))
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByTestId('chat-count').textContent).toBe('1')
  })

  it('restore is a no-op for a chip whose project no longer exists (chip stays put)', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <>
        <MinimizeButton projectId="p3-gone" label="Ghost spec" resumeConversationId={undefined} />
        <Probe />
      </>,
    )
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByText('Ghost spec')).toBeTruthy()

    await act(async () => {
      screen.getByTestId('probe-restore-first').click()
    })
    // Project gone → restore() bails out, chip is NOT dropped into a dead queue.
    expect(screen.getByText('Ghost spec')).toBeTruthy()
    expect(setActiveProjectIdSpy).not.toHaveBeenCalled()
  })

  it('keeps distinct chips when conversation ids differ', async () => {
    function TwoButtons() {
      const { minimize } = useMinimizedChats()
      const park = (label: string, conv: string) =>
        minimize({
          kind: 'explore-spec',
          projectId: 'p1',
          label,
          restoreRoute: '/',
          params: { initialIdea: 'i', pendingSpecId: conv, initialAttachmentIds: [], resumeConversationId: conv },
        })
      return (
        <>
          <button data-testid="park-a" onClick={() => park('Spec A', 'conv-a')}>a</button>
          <button data-testid="park-b" onClick={() => park('Spec B', 'conv-b')}>b</button>
        </>
      )
    }
    const user = userEvent.setup()
    renderWithProvider(<><TwoButtons /><Probe /></>)
    await user.click(screen.getByTestId('park-a'))
    await user.click(screen.getByTestId('park-b'))
    expect(screen.getByTestId('chat-count').textContent).toBe('2')
    await waitFor(() => expect(dockLabels().sort()).toEqual(['Spec A', 'Spec B']))
  })

  it('saveToStorage caps at 50 entries (drops oldest)', () => {
    const many: MinimizedChat[] = Array.from({ length: 60 }, (_, i) => ({
      id: `id-${i}`,
      kind: 'explore-spec' as const,
      projectId: 'p1',
      label: `chat ${i}`,
      restoreRoute: '/',
      createdAt: i,
      params: { initialIdea: 'i', pendingSpecId: 'p', initialAttachmentIds: [] },
    }))
    saveToStorage(many)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MinimizedChat[]
    expect(stored).toHaveLength(50)
    expect(stored[0].createdAt).toBe(10)
  })

  it('loadFromStorage filters invalid entries silently', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { kind: 'explore-spec' /* missing other fields */ },
        'not-an-object',
        {
          id: 'ok',
          kind: 'ai-edit',
          projectId: 'p1',
          label: 'valid',
          restoreRoute: '/agents',
          createdAt: 1,
          params: { agentId: 'sr-developer', baseBody: '' },
        },
      ]),
    )
    const loaded = loadFromStorage()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].label).toBe('valid')
  })

  it('loadFromStorage returns [] on malformed JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json')
    expect(loadFromStorage()).toEqual([])
  })

  it('updateLabel changes the chip label without re-creating the entry', async () => {
    const user = userEvent.setup()
    renderWithProvider(<><MinimizeButton /><Probe /></>)
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByText('Test spec')).toBeTruthy()
    await user.click(screen.getByTestId('probe-rename-first'))
    expect(screen.getByText('Renamed live')).toBeTruthy()
    expect(screen.queryByText('Test spec')).toBeNull()
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MinimizedChat[]
    expect(persisted[0].label).toBe('Renamed live')
  })

  it('reflects an updated project name in the chip without a chats change', async () => {
    const user = userEvent.setup()
    const { rerender } = renderWithProvider(<MinimizeButton />)
    await user.click(screen.getByTestId('do-minimize'))
    expect(screen.getByText(/Alpha/)).toBeTruthy()

    // Project renamed in the app — dock reads projects reactively.
    desktopState.projects = [
      { id: 'p1', name: 'Alpha Renamed' },
      { id: 'p2', name: 'Beta' },
    ]
    rerender(
      <SharedWebSocketContext.Provider value={fakeWs}>
        <MemoryRouter initialEntries={['/']}>
          <MinimizedChatsProvider>
            <Routes>
              <Route path="*" element={<MinimizeButton />} />
            </Routes>
          </MinimizedChatsProvider>
        </MemoryRouter>
      </SharedWebSocketContext.Provider>,
    )
    await waitFor(() => expect(screen.getByText(/Alpha Renamed/)).toBeTruthy())
  })

  it('live-updates a chip label from a `spec_draft.update` WS event', async () => {
    const handlers = new Map<string, (m: unknown) => void>()
    const wsWithEmit = {
      registerHandler: (id: string, fn: (m: unknown) => void) => handlers.set(id, fn),
      unregisterHandler: (id: string) => handlers.delete(id),
      connectionStatus: 'connected' as const,
    }
    function Seed() {
      const { minimize } = useMinimizedChats()
      return (
        <button
          data-testid="seed-with-conv"
          onClick={() =>
            minimize({
              kind: 'explore-spec',
              projectId: 'p1',
              label: 'pre-rename',
              restoreRoute: '/',
              params: {
                initialIdea: 'i',
                pendingSpecId: 'p',
                initialAttachmentIds: [],
                resumeConversationId: 'conv-7',
              },
            })
          }
        >
          seed
        </button>
      )
    }
    const user = userEvent.setup()
    render(
      <SharedWebSocketContext.Provider value={wsWithEmit}>
        <MemoryRouter>
          <MinimizedChatsProvider>
            <Seed />
          </MinimizedChatsProvider>
        </MemoryRouter>
      </SharedWebSocketContext.Provider>,
    )
    await user.click(screen.getByTestId('seed-with-conv'))
    expect(screen.getByText('pre-rename')).toBeTruthy()

    await act(async () => {
      handlers.get('minimized-chats:spec-draft')?.({
        type: 'spec_draft.update',
        conversationId: 'conv-7',
        draft: { title: 'Live new title' },
        ready: false,
        chips: [],
        changedFields: ['title'],
        timestamp: '',
      })
    })

    expect(screen.getByText('Live new title')).toBeTruthy()
  })
})
