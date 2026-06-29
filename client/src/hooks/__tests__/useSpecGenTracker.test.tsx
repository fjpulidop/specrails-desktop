import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { toast } from 'sonner'

import {
  SpecGenTrackerProvider,
  useSpecGenTracker,
  type SpecGenTrackerValue,
  type SpecRegistration,
} from '../useSpecGenTracker'
import { SharedWebSocketContext } from '../useSharedWebSocket'
import { savePendingSpec } from '../../lib/pending-specs'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../../lib/origin', () => ({ API_ORIGIN: '' }))

// useNavigate returns a NEW function on every render — this mirrors react-router,
// whose navigate identity changes on each route change. It is the exact trigger
// that used to re-run the localStorage-restore effect and duplicate the toast.
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

// Stable setActiveProjectId so only `navigate` drives openTicket's identity.
const setActiveProjectId = vi.fn()
vi.mock('../useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1', setActiveProjectId }),
}))

function makeWsValue() {
  const handlers = new Map<string, (msg: unknown) => void>()
  return {
    handlers,
    registerHandler: vi.fn((id: string, fn: (msg: unknown) => void) => { handlers.set(id, fn) }),
    unregisterHandler: vi.fn((id: string) => { handlers.delete(id) }),
    connectionStatus: 'connected' as const,
  }
}

let tracker: SpecGenTrackerValue | null = null
function Capture() {
  tracker = useSpecGenTracker()
  return null
}

function renderTracker(ws: ReturnType<typeof makeWsValue>) {
  const ui = (
    <SharedWebSocketContext.Provider value={ws as never}>
      <SpecGenTrackerProvider><Capture /></SpecGenTrackerProvider>
    </SharedWebSocketContext.Provider>
  )
  return render(ui)
}

function loadingIds() {
  return (toast.loading as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => (c[1] as { id?: string } | undefined)?.id)
    .filter((id): id is string => typeof id === 'string')
}

const reg = (over: Partial<SpecRegistration> = {}): SpecRegistration => ({
  toastId: 'live-toast',
  truncated: 'add a thing',
  knownTicketIds: new Set<number>(),
  projectId: 'proj-1',
  projectName: 'Proj',
  startTime: Date.now(),
  persistId: 'p1',
  ...over,
})

describe('useSpecGenTracker — navigation does not duplicate the spec toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tickets: [] }) } as Response)) as unknown as typeof fetch
  })
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  it('does NOT create a spec-restore toast for a live spec when navigation re-renders the provider', () => {
    const ws = makeWsValue()
    const { rerender } = renderTracker(ws)

    // User submits a Quick spec → registers it (saves to localStorage too).
    act(() => { tracker!.registerFastSpec('req-1', reg({ persistId: 'p1' })) })

    // Navigate to another section: react-router hands back a new `navigate`, so
    // the provider re-renders. The restore effect must NOT re-fire and re-create
    // the in-flight spec as a second toast.
    rerender(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SpecGenTrackerProvider><Capture /></SpecGenTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )

    // No restore toast was created for the still-in-flight spec.
    expect(loadingIds().some((id) => id.startsWith('spec-restore-'))).toBe(false)
  })

  it('still restores a genuinely-pending spec from localStorage exactly once (refresh), even across re-renders', () => {
    // Simulate a page refresh: a pending spec already sits in localStorage and
    // NOTHING is live-registered this session.
    savePendingSpec({
      id: 'p2', knownTicketIds: [], projectId: 'proj-1', projectName: 'Proj',
      startTime: Date.now(), truncated: 'pending one',
    })

    const ws = makeWsValue()
    const { rerender } = renderTracker(ws)

    rerender(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SpecGenTrackerProvider><Capture /></SpecGenTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )

    const restoreCalls = loadingIds().filter((id) => id === 'spec-restore-p2')
    expect(restoreCalls.length).toBe(1)
  })
})
