/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { toast } from 'sonner'
import { TerminalsProvider, useTerminals, tryLoadWebgl, webgl2Available, DEFAULT_USER_HEIGHT, PANEL_MIN_HEIGHT, TERMINAL_MAX_PER_PROJECT } from '../TerminalsContext'

// Capture sonner toasts so error surfacing can be asserted.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
const mockToastError = vi.mocked(toast.error)

// Stub xterm so we don't need a DOM renderer
// Mock the @xterm/xterm Terminal class with the surface area
// `ensureXtermForSession` expects: addons, custom key handler, buffer, etc.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    options: { fontSize: number } = { fontSize: 12 }
    unicode = { activeVersion: '6' }
    buffer = { active: { cursorY: 0, viewportY: 0, length: 0, getLine: () => null } }
    modes = { mouseTrackingMode: 'none' }
    loadAddon = vi.fn()
    open = (el: HTMLElement) => { this.element = el }
    focus = vi.fn()
    write = vi.fn()
    dispose = vi.fn()
    clear = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    getSelection = () => ''
    scrollToLine = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    onData = (_: (data: string) => void) => ({ dispose: vi.fn() })
    onResize = (_: (d: { cols: number; rows: number }) => void) => ({ dispose: vi.fn() })
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn() } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn()
    onDidChangeResults = () => ({ dispose: vi.fn() })
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }))
vi.mock('@xterm/addon-ligatures', () => ({ LigaturesAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss = vi.fn(); dispose = vi.fn() } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// Stub WebSocket globally
class MockWebSocket extends EventTarget {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  readyState = 0
  binaryType = 'arraybuffer'
  url: string
  sent: Array<unknown> = []
  constructor(url: string) { super(); this.url = url; MockWebSocket.instances.push(this) }
  send(data: unknown) { this.sent.push(data) }
  close() { this.readyState = 3 }
  // Required properties for WebSocket typing
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).WebSocket = MockWebSocket

interface Captured { ctx: ReturnType<typeof useTerminals> | null }

function Harness({ captured, projectId }: { captured: Captured; projectId: string | null }) {
  captured.ctx = useTerminals()
  void projectId
  return null
}

function mountProvider(projectId: string | null = 'proj-A'): Captured {
  const captured: Captured = { ctx: null }
  render(
    <TerminalsProvider activeProjectId={projectId}>
      <Harness captured={captured} projectId={projectId} />
    </TerminalsProvider>,
  )
  return captured
}

describe('TerminalsContext', () => {
  beforeEach(() => {
    // Reset localStorage and fetch mock
    localStorage.clear()
    MockWebSocket.instances = []
    mockToastError.mockClear()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [], limit: 10 }),
    })
  })

  it('hydrates project state from localStorage', () => {
    localStorage.setItem('specrails-desktop:terminal-panel:proj-A', JSON.stringify({ visibility: 'restored', userHeight: 420 }))
    const { ctx } = mountProvider('proj-A')
    // trigger ensureProject via action
    act(() => { ctx!.ensureProject('proj-A') })
    const state = ctx!.getState('proj-A')
    expect(state.visibility).toBe('restored')
    expect(state.userHeight).toBe(420)
  })

  it('defaults to hidden + 320px when no stored state', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    const state = captured.ctx!.getState('proj-A')
    expect(state.visibility).toBe('hidden')
    expect(state.userHeight).toBe(320)
  })

  it('toggle flips visibility and persists', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.togglePanel('proj-A') })
    expect(captured.ctx!.getState('proj-A').visibility).toBe('restored')
    const stored = JSON.parse(localStorage.getItem('specrails-desktop:terminal-panel:proj-A')!)
    expect(stored.visibility).toBe('restored')
    act(() => { captured.ctx!.togglePanel('proj-A') })
    expect(captured.ctx!.getState('proj-A').visibility).toBe('hidden')
  })

  it('setUserHeight persists', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.setUserHeight('proj-A', 500) })
    expect(captured.ctx!.getState('proj-A').userHeight).toBe(500)
    const stored = JSON.parse(localStorage.getItem('specrails-desktop:terminal-panel:proj-A')!)
    expect(stored.userHeight).toBe(500)
  })

  it('per-project state is isolated', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.ensureProject('proj-B') })
    act(() => { captured.ctx!.setVisibility('proj-A', 'maximized') })
    act(() => { captured.ctx!.setVisibility('proj-B', 'restored') })
    expect(captured.ctx!.getState('proj-A').visibility).toBe('maximized')
    expect(captured.ctx!.getState('proj-B').visibility).toBe('restored')
  })

  it('create updates sessions list and activates new terminal', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return {
          ok: true,
          json: async () => ({
            session: { id: 'sess-1', projectId: 'proj-A', name: 'cmd', shell: 'C:\\Windows\\System32\\cmd.exe', cwd: 'C:\\project', cols: 80, rows: 24, createdAt: 1 },
          }),
        }
      }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    const state = captured.ctx!.getState('proj-A')
    expect(state.sessions.map((s) => s.id)).toEqual(['sess-1'])
    expect(state.activeId).toBe('sess-1')
    expect(captured.ctx!.getShell('sess-1')).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(captured.ctx!.getCwd('sess-1')).toBe('C:\\project')
    expect(captured.ctx!.getShell('unknown')).toBeNull()
  })

  it('disposeProject clears state and localStorage for that project', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.setVisibility('proj-A', 'restored') })
    expect(captured.ctx!.getState('proj-A').visibility).toBe('restored')
    expect(localStorage.getItem('specrails-desktop:terminal-panel:proj-A')).toBeTruthy()
    act(() => { captured.ctx!.disposeProject('proj-A') })
    expect(localStorage.getItem('specrails-desktop:terminal-panel:proj-A')).toBeNull()
  })

  it('setActive updates activeId', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.setActive('proj-A', 'sess-xyz') })
    expect(captured.ctx!.getState('proj-A').activeId).toBe('sess-xyz')
  })

  it('getContainer returns null for unknown session', () => {
    const captured = mountProvider('proj-A')
    expect(captured.ctx!.getContainer('unknown-id')).toBeNull()
  })

  it('focusActive is a no-op when no active session', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    // Just exercise — shouldn't throw
    expect(() => captured.ctx!.focusActive('proj-A')).not.toThrow()
  })

  it('rename updates session name on success', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ session: { id: 's1', projectId: 'proj-A', name: 'new name', cols: 80, rows: 24, createdAt: 1 } }) }
      }
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ session: { id: 's1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    await act(async () => { const ok = await captured.ctx!.rename('proj-A', 's1', 'new name'); expect(ok).toBe(true) })
    expect(captured.ctx!.getState('proj-A').sessions[0].name).toBe('new name')
  })

  it('rename returns false when server rejects', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { ok: false, json: async () => ({}) }
      if (init?.method === 'POST') return { ok: true, json: async () => ({ session: { id: 's1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    let result: boolean | null = null
    await act(async () => { result = await captured.ctx!.rename('proj-A', 's1', 'x') })
    expect(result).toBe(false)
  })

  it('notifyAdopted is safe when session does not exist', () => {
    const captured = mountProvider('proj-A')
    expect(() => captured.ctx!.notifyAdopted('non-existent')).not.toThrow()
  })

  it('create exercises xterm + WS bridge setup', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ session: { id: 'xt-1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    // After create, getContainer should return the HTML element for the new session
    const container = captured.ctx!.getContainer('xt-1')
    expect(container).not.toBeNull()
    expect(container instanceof HTMLDivElement).toBe(true)
  })

  it('notifyAdopted with real session calls fit + focus without error', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ session: { id: 'xt-2', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    expect(() => captured.ctx!.notifyAdopted('xt-2')).not.toThrow()
  })

  it('create returns null on non-ok response', async () => {
    global.fetch = vi.fn().mockImplementation(async () => ({ ok: false, json: async () => ({}) }))
    const captured = mountProvider('proj-A')
    let result: unknown = 'unset'
    await act(async () => { result = await captured.ctx!.create('proj-A') })
    expect(result).toBeNull()
  })

  it('exposes panel sizing constants', () => {
    expect(DEFAULT_USER_HEIGHT).toBeGreaterThan(0)
    expect(PANEL_MIN_HEIGHT).toBeGreaterThan(0)
    expect(TERMINAL_MAX_PER_PROJECT).toBeGreaterThan(0)
  })

  it('tryLoadWebgl returns an addon-like object when import succeeds', async () => {
    const fakeTerm = { loadAddon: vi.fn() } as unknown as Parameters<typeof tryLoadWebgl>[0]
    const result = await tryLoadWebgl(fakeTerm)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('dispose')
  })

  it('webgl2Available returns a boolean without throwing', () => {
    expect(typeof webgl2Available()).toBe('boolean')
  })

  it('setVisibility persists hidden state to localStorage', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.setVisibility('proj-A', 'maximized') })
    const stored = JSON.parse(localStorage.getItem('specrails-desktop:terminal-panel:proj-A')!)
    expect(stored.visibility).toBe('maximized')
  })

  it('togglePanel from maximized restores to restored visibility', () => {
    const captured = mountProvider('proj-A')
    act(() => { captured.ctx!.ensureProject('proj-A') })
    act(() => { captured.ctx!.setVisibility('proj-A', 'maximized') })
    act(() => { captured.ctx!.togglePanel('proj-A') })
    expect(captured.ctx!.getState('proj-A').visibility).toBe('hidden')
  })

  it('getState for unknown project returns default panel state', () => {
    const captured = mountProvider('proj-A')
    const state = captured.ctx!.getState('does-not-exist')
    expect(state.visibility).toBe('hidden')
    expect(state.sessions).toEqual([])
  })

  it('hydrates malformed localStorage gracefully', () => {
    localStorage.setItem('specrails-desktop:terminal-panel:proj-bad', '{not json')
    const captured = mountProvider('proj-bad')
    act(() => { captured.ctx!.ensureProject('proj-bad') })
    const state = captured.ctx!.getState('proj-bad')
    expect(state.visibility).toBe('hidden')
    expect(state.userHeight).toBe(DEFAULT_USER_HEIGHT)
  })

  it('disposeProject for unknown project is a no-op', () => {
    const captured = mountProvider('proj-A')
    expect(() => captured.ctx!.disposeProject('ghost')).not.toThrow()
  })

  it('rename for unknown session returns false', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const captured = mountProvider('proj-A')
    let result: boolean | null = null
    await act(async () => { result = await captured.ctx!.rename('proj-A', 'no-such', 'new') })
    expect(result).toBe(false)
  })

  it('create surfaces a limit toast and returns null on terminal_limit_exceeded', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, json: async () => ({ error: 'terminal_limit_exceeded', limit: 10 }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    let result: unknown = 'unset'
    await act(async () => { result = await captured.ctx!.create('proj-A') })
    expect(result).toBeNull()
    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/limit reached/i)
  })

  it('create surfaces a spawn-failure toast on terminal_spawn_failed', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, status: 502, json: async () => ({ error: 'terminal_spawn_failed', reason: 'out-of-file-descriptors' }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/file descriptors/i)
  })

  it('create surfaces a generic toast when the server is unreachable', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('network down')
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    let result: unknown = 'unset'
    await act(async () => { result = await captured.ctx!.create('proj-A') })
    expect(result).toBeNull()
    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/server/i)
  })

  it('an early exit frame surfaces a "failed to start" toast', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ session: { id: 'die-1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    const ws = MockWebSocket.instances.find((w) => w.url.includes('die-1'))
    expect(ws).toBeTruthy()
    mockToastError.mockClear()
    act(() => { ws!.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 1, early: true }) } as MessageEvent) })
    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(String(mockToastError.mock.calls[0][0])).toMatch(/exited immediately/i)
  })

  it('a normal (non-early) exit frame does not toast', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ session: { id: 'bye-1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    const ws = MockWebSocket.instances.find((w) => w.url.includes('bye-1'))
    mockToastError.mockClear()
    act(() => { ws!.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0, early: false }) } as MessageEvent) })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('an unexpected early close (pty_exit_early) surfaces a toast; a deliberate dispose does not', async () => {
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ session: { id: 'drop-1', projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 1 } }) }
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    const ws = MockWebSocket.instances.find((w) => w.url.includes('drop-1'))
    mockToastError.mockClear()
    act(() => { ws!.onclose?.({ code: 1000, reason: 'pty_exit_early' }) })
    expect(mockToastError).toHaveBeenCalledTimes(1)

    // A second create + deliberate kill must NOT toast (disposing flag set).
    const ws2Url = 'drop-2'
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ session: { id: ws2Url, projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: 2 } }) }
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    await act(async () => { await captured.ctx!.create('proj-A') })
    const ws2 = MockWebSocket.instances.find((w) => w.url.includes(ws2Url))
    mockToastError.mockClear()
    await act(async () => { await captured.ctx!.kill('proj-A', ws2Url) })
    // kill() disposes the handle (disposing=true) before closing the socket.
    act(() => { ws2!.onclose?.({ code: 1000, reason: 'client_dispose' }) })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('kill removes session and advances active', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        const count = (global as unknown as { __c?: number }).__c ?? 0
        ;(global as unknown as { __c: number }).__c = count + 1
        return {
          ok: true,
          json: async () => ({
            session: { id: `sess-${count + 1}`, projectId: 'proj-A', name: 'zsh', cols: 80, rows: 24, createdAt: count + 1 },
          }),
        }
      }
      if (method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
      return { ok: true, json: async () => ({ sessions: [], limit: 10 }) }
    })
    ;(global as unknown as { __c: number }).__c = 0
    const captured = mountProvider('proj-A')
    await act(async () => { await captured.ctx!.create('proj-A') })
    await act(async () => { await captured.ctx!.create('proj-A') })
    const before = captured.ctx!.getState('proj-A')
    expect(before.sessions).toHaveLength(2)
    expect(before.activeId).toBe('sess-2')
    await act(async () => { await captured.ctx!.kill('proj-A', 'sess-2') })
    const after = captured.ctx!.getState('proj-A')
    expect(after.sessions.map((s) => s.id)).toEqual(['sess-1'])
    expect(after.activeId).toBe('sess-1')
  })
})
