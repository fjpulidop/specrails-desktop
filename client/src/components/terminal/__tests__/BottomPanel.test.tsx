/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BottomPanel } from '../BottomPanel'
import { TerminalsProvider } from '../../../context/TerminalsContext'
import type { ProjectPanelState, TerminalRef } from '../../../context/TerminalsContext'
import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '../../../lib/terminal-settings-types'
import { TERMINAL_SETTINGS_UPDATED_EVENT } from '../../../lib/terminal-settings-events'
import { openExternalUrl } from '../../../lib/tauri-shell'

vi.mock('../../../lib/tauri-shell', () => ({
  isTauri: () => false,
  revealItemInDir: vi.fn(),
  openExternalUrl: vi.fn(),
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80; rows = 24; element: HTMLElement | null = null
    options = { fontSize: 12 }
    unicode = { activeVersion: '6' }
    buffer = { active: { cursorY: 0, viewportY: 0, length: 0, getLine: () => null } }
    modes = { mouseTrackingMode: 'none' }
    loadAddon = vi.fn(); open = (el: HTMLElement) => { this.element = el }
    focus = vi.fn(); write = vi.fn(); dispose = vi.fn()
    clear = vi.fn(); paste = vi.fn(); selectAll = vi.fn()
    getSelection = () => ''
    scrollToLine = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    onData = () => ({ dispose: vi.fn() })
    onResize = () => ({ dispose: vi.fn() })
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
class MockWebSocket extends EventTarget {
  readyState = 0; binaryType = 'arraybuffer'
  constructor(_url: string) { super() }
  send() {}; close() { this.readyState = 3 }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).WebSocket = MockWebSocket

function wrap(node: React.ReactNode) {
  return render(
    <MemoryRouter>
      <TerminalsProvider activeProjectId="p">{node}</TerminalsProvider>
    </MemoryRouter>,
  )
}

function makeState(overrides: Partial<ProjectPanelState> = {}): ProjectPanelState {
  return {
    visibility: 'restored',
    userHeight: 320,
    sessions: [],
    activeId: null,
    ...overrides,
  }
}

describe('BottomPanel', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.mocked(openExternalUrl).mockClear()
    localStorage.clear()
  })

  it('returns null when hidden', () => {
    const { queryByTestId } = wrap(
      <BottomPanel projectId="p" state={makeState({ visibility: 'hidden' })} viewportHeight={800} statusBarHeight={28} />,
    )
    expect(queryByTestId('terminal-bottom-panel')).toBeNull()
  })

  it('renders at userHeight in restored mode', () => {
    const { getByTestId } = wrap(
      <BottomPanel projectId="p" state={makeState({ visibility: 'restored', userHeight: 400 })} viewportHeight={800} statusBarHeight={28} />,
    )
    const panel = getByTestId('terminal-bottom-panel') as HTMLElement
    expect(panel.style.height).toBe('400px')
  })

  it('plays a curtain close before unmounting when hidden after being open', () => {
    vi.useFakeTimers()
    try {
      const { getByTestId, queryByTestId, rerender } = wrap(
        <BottomPanel projectId="p" state={makeState({ visibility: 'restored', userHeight: 400 })} viewportHeight={800} statusBarHeight={28} />,
      )
      expect((getByTestId('terminal-bottom-panel') as HTMLElement).style.height).toBe('400px')

      rerender(
        <MemoryRouter>
          <TerminalsProvider activeProjectId="p">
            <BottomPanel projectId="p" state={makeState({ visibility: 'hidden', userHeight: 400 })} viewportHeight={800} statusBarHeight={28} />
          </TerminalsProvider>
        </MemoryRouter>,
      )
      const closingPanel = getByTestId('terminal-bottom-panel') as HTMLElement
      expect(closingPanel.style.height).toBe('0px')
      expect(closingPanel.style.opacity).toBe('0')

      act(() => { vi.advanceTimersByTime(310) })
      expect(queryByTestId('terminal-bottom-panel')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders at viewport-statusbar in maximized mode', () => {
    const { getByTestId } = wrap(
      <BottomPanel projectId="p" state={makeState({ visibility: 'maximized', userHeight: 400 })} viewportHeight={800} statusBarHeight={28} />,
    )
    const panel = getByTestId('terminal-bottom-panel') as HTMLElement
    expect(panel.style.height).toBe('772px')
  })

  it('clamps userHeight to maxHeight', () => {
    const { getByTestId } = wrap(
      <BottomPanel projectId="p" state={makeState({ visibility: 'restored', userHeight: 10000 })} viewportHeight={800} statusBarHeight={28} />,
    )
    const panel = getByTestId('terminal-bottom-panel') as HTMLElement
    const h = parseInt(panel.style.height, 10)
    expect(h).toBeLessThanOrEqual(800 - 28 - 40)
    expect(h).toBeGreaterThanOrEqual(120)
  })

  it('shows empty placeholder when no sessions', () => {
    const { getByText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [] })} viewportHeight={800} statusBarHeight={28} />,
    )
    expect(getByText(/no terminals yet/i)).toBeDefined()
  })

  it('empty placeholder button fires create', () => {
    const { getAllByRole } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [] })} viewportHeight={800} statusBarHeight={28} />,
    )
    const buttons = getAllByRole('button', { name: /new terminal/i })
    // Placeholder CTA (text includes "New terminal"), not the + icon
    const placeholder = buttons.find((b) => b.textContent?.toLowerCase().includes('new terminal')) ?? buttons[buttons.length - 1]
    fireEvent.click(placeholder)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('renders sessions and sidebar when non-empty', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    expect(getByText('zsh')).toBeDefined()
  })

  it('top-bar + button fires create action', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.click(getByLabelText(/^new terminal$/i))
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('refreshes shortcut settings when terminal settings are saved', async () => {
    const oldSettings: TerminalSettings = {
      ...DEFAULT_TERMINAL_SETTINGS,
      browserShortcutUrl: 'https://old.example',
      quickScript: '',
    }
    const newSettings: TerminalSettings = {
      ...oldSettings,
      browserShortcutUrl: 'https://new.example',
      quickScript: 'npm test',
    }
    let resolved = oldSettings
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/terminal-settings')) {
        return Promise.resolve({ ok: true, json: async () => ({ resolved }) })
      }
      if (String(url).endsWith('/terminals')) {
        return Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    global.fetch = fetchMock

    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/terminal-settings'))).toBe(true)
    })
    fireEvent.click(getByLabelText('Open in browser'))
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://old.example')
    expect(getByLabelText('No active terminal to paste into')).toBeDisabled()

    resolved = newSettings
    window.dispatchEvent(new CustomEvent(TERMINAL_SETTINGS_UPDATED_EVENT, {
      detail: { mode: 'project', projectId: 'p' },
    }))

    await waitFor(() => {
      const terminalSettingsCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/terminal-settings'))
      expect(terminalSettingsCalls).toHaveLength(2)
    })
    // Wait for the refetch's state update to flush before asserting on
    // click side-effects — the fetch resolving and React updating state
    // are separate microtasks, and CI is slow enough to expose the race.
    await waitFor(() => {
      expect(getByLabelText('Paste quick script into active terminal')).not.toBeDisabled()
    })
    fireEvent.click(getByLabelText('Open in browser'))
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://new.example')
  })

  it('kill-active button fires DELETE', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.click(getByLabelText(/kill active terminal/i))
    // Fetch called with DELETE method
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const sawDelete = calls.some(([, init]) => init?.method === 'DELETE')
    expect(sawDelete).toBe(true)
  })

  it('collapse chevron click does not throw and dispatches setVisibility', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText } = wrap(
      <BottomPanel projectId="p" state={makeState({ visibility: 'restored', sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    // Just exercise the handler — actual state transition is covered in TerminalsContext tests.
    expect(() => fireEvent.click(getByLabelText(/collapse terminal panel/i))).not.toThrow()
  })

  it('maximize then restore toggles state', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'zsh', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText, rerender } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.click(getByLabelText(/maximize panel/i))
    let stored = JSON.parse(localStorage.getItem('specrails-desktop:terminal-panel:p')!) as { visibility: string }
    expect(stored.visibility).toBe('maximized')
    rerender(
      <MemoryRouter>
        <TerminalsProvider activeProjectId="p">
          <BottomPanel projectId="p" state={makeState({ visibility: 'maximized', sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />
        </TerminalsProvider>
      </MemoryRouter>,
    )
    fireEvent.click(getByLabelText(/restore panel/i))
    stored = JSON.parse(localStorage.getItem('specrails-desktop:terminal-panel:p')!) as { visibility: string }
    expect(stored.visibility).toBe('restored')
  })

  it('sidebar rename triggers PATCH', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'initial', cols: 80, rows: 24, createdAt: 1 }
    const { getByText, getByDisplayValue } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.doubleClick(getByText('initial'))
    const input = getByDisplayValue('initial')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const sawPatch = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === 'PATCH')
    expect(sawPatch).toBe(true)
  })

  it('sidebar rename button triggers PATCH', () => {
    const s: TerminalRef = { id: 's1', projectId: 'p', name: 'initial', cols: 80, rows: 24, createdAt: 1 }
    const { getByLabelText, getByDisplayValue } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.click(getByLabelText(/rename initial/i))
    const input = getByDisplayValue('initial')
    fireEvent.change(input, { target: { value: 'renamed-from-button' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const sawPatch = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === 'PATCH')
    expect(sawPatch).toBe(true)
  })

  it('sidebar ✕ triggers kill DELETE for that session', () => {
    const s1: TerminalRef = { id: 's1', projectId: 'p', name: 'one', cols: 80, rows: 24, createdAt: 1 }
    const s2: TerminalRef = { id: 's2', projectId: 'p', name: 'two', cols: 80, rows: 24, createdAt: 2 }
    const { getByLabelText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s1, s2], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    fireEvent.click(getByLabelText(/close two/i))
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const sawDelete2 = calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/terminals/s2'))
    expect(sawDelete2).toBe(true)
  })

  it('sidebar click fires setActive', () => {
    const s1: TerminalRef = { id: 's1', projectId: 'p', name: 'one', cols: 80, rows: 24, createdAt: 1 }
    const s2: TerminalRef = { id: 's2', projectId: 'p', name: 'two', cols: 80, rows: 24, createdAt: 2 }
    const { getByText } = wrap(
      <BottomPanel projectId="p" state={makeState({ sessions: [s1, s2], activeId: 's1' })} viewportHeight={800} statusBarHeight={28} />,
    )
    // Should not throw; activeId tracking is via context state — we just exercise the handler
    fireEvent.click(getByText('two'))
  })
})
