/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { toast } from 'sonner'
import { TerminalViewport } from '../TerminalViewport'

const mocks = vi.hoisted(() => ({
  useTerminals: vi.fn(),
}))

vi.mock('../../../context/TerminalsContext', () => ({
  useTerminals: () => mocks.useTerminals(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('../../../lib/tauri-shell', () => ({
  isTauri: () => false,
  revealItemInDir: vi.fn(),
}))

vi.mock('../PromptGutter', () => ({
  PromptGutter: () => null,
}))

vi.mock('../CommandTimingBadge', () => ({
  CommandTimingBadge: () => null,
}))

function makeTerm(overrides: Partial<FakeTerminal> = {}): FakeTerminal {
  return {
    paste: vi.fn(),
    getSelection: vi.fn(() => ''),
    modes: { mouseTrackingMode: 'none' },
    ...overrides,
  }
}

interface FakeTerminal {
  paste: ReturnType<typeof vi.fn>
  getSelection: ReturnType<typeof vi.fn>
  modes: { mouseTrackingMode: string }
}

function mockTerminals(term: FakeTerminal | null = null, writeToSession = vi.fn(() => false), shell: string | null = null) {
  mocks.useTerminals.mockReturnValue({
    subscribeOpenSearch: vi.fn(() => undefined),
    getSearchAddon: vi.fn(() => null),
    getTerminalInstance: vi.fn(() => term),
    writeToSession,
    getCwd: vi.fn(() => null),
    getShell: vi.fn(() => shell),
    getContainer: vi.fn(() => null),
    notifyAdopted: vi.fn(),
    refitActive: vi.fn(),
  })
}

describe('TerminalViewport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    mockTerminals(null)
  })

  it('renders a slot element', () => {
    const { container } = render(<TerminalViewport activeId={null} />)
    expect(container.querySelector('[data-terminal-viewport]')).toBeTruthy()
  })

  it('returns without error when activeId has no container yet', () => {
    const { container } = render(<TerminalViewport activeId="missing-id" />)
    expect(container.querySelector('[data-terminal-viewport]')).toBeTruthy()
  })

  it('pastes native file paths instead of allowing file previews on drop', () => {
    const term = makeTerm()
    const writeToSession = vi.fn(() => true)
    mockTerminals(term, writeToSession)
    const { container } = render(<TerminalViewport activeId="s1" />)
    const slot = container.querySelector('[data-terminal-viewport]') as HTMLElement
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'path', { value: '/Users/javi/Desktop/hello.txt' })

    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [file],
      },
    })
    event.stopPropagation = vi.fn()
    fireEvent(slot, event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(writeToSession).toHaveBeenCalledWith('s1', "'/Users/javi/Desktop/hello.txt'")
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('prevents file drops without native paths so the WebView does not render previews', () => {
    const term = makeTerm()
    mockTerminals(term)
    const { container } = render(<TerminalViewport activeId="s1" />)
    const slot = container.querySelector('[data-terminal-viewport]') as HTMLElement
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [file],
      },
    })
    event.stopPropagation = vi.fn()
    fireEvent(slot, event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('captures native paste events and writes text to the terminal', () => {
    const term = makeTerm()
    const writeToSession = vi.fn(() => true)
    mockTerminals(term, writeToSession)
    const { container } = render(<TerminalViewport activeId="s1" />)
    const slot = container.querySelector('[data-terminal-viewport]') as HTMLElement

    fireEvent.paste(slot, {
      clipboardData: {
        getData: (format: string) => format === 'text/plain' ? 'npm test' : '',
      },
    })

    expect(writeToSession).toHaveBeenCalledWith('s1', 'npm test')
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('writes shell-quoted file paths when files are pasted', () => {
    const term = makeTerm()
    const writeToSession = vi.fn(() => true)
    mockTerminals(term, writeToSession)
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    const { container } = render(<TerminalViewport activeId="s1" />)
    const slot = container.querySelector('[data-terminal-viewport]') as HTMLElement

    const fileA = Object.assign(new File([''], 'a.txt'), { path: '/Users/me/a.txt' })
    const fileB = Object.assign(new File([''], 'with space.txt'), { path: '/Users/me/with space.txt' })

    fireEvent.paste(slot, {
      clipboardData: {
        files: [fileA, fileB],
        getData: () => '',
      },
    })

    expect(writeToSession).toHaveBeenCalledWith('s1', "'/Users/me/a.txt' '/Users/me/with space.txt'")
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('captures native copy events when the terminal has a selection', () => {
    const term = makeTerm({ getSelection: vi.fn(() => 'selected text') })
    mockTerminals(term)
    const { container } = render(<TerminalViewport activeId="s1" />)
    const slot = container.querySelector('[data-terminal-viewport]') as HTMLElement
    const setData = vi.fn()

    fireEvent.copy(slot, {
      clipboardData: {
        setData,
      },
    })

    expect(setData).toHaveBeenCalledWith('text/plain', 'selected text')
  })

  it.each([
    ['C:\\Windows\\System32\\cmd.exe', '"C:\\A B\\hello^world.txt"'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', "'C:\\A B\\hello^world.txt'"],
  ])('pastes file paths using the actual Windows shell %s', (shell, quoted) => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    const write = vi.fn(() => true)
    mockTerminals(makeTerm(), write, shell)
    const { container } = render(<TerminalViewport activeId="s1" />)
    fireEvent.paste(container.querySelector('[data-terminal-viewport]')!, {
      clipboardData: { files: [Object.assign(new File([''], 'file.txt'), { path: 'C:\\A B\\hello^world.txt' })], getData: () => '' },
    })
    expect(write).toHaveBeenCalledWith('s1', quoted)
  })

  it('rejects a cmd path containing expansion syntax without writing any partial command', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    const write = vi.fn(() => true)
    const term = makeTerm()
    mockTerminals(term, write, 'cmd.exe')
    const { container } = render(<TerminalViewport activeId="s1" />)
    fireEvent.paste(container.querySelector('[data-terminal-viewport]')!, {
      clipboardData: { files: [Object.assign(new File([''], 'file.txt'), { path: 'C:\\%PATH%\\file.txt' })], getData: () => '' },
    })
    expect(write).not.toHaveBeenCalled()
    expect(term.paste).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledOnce()
  })
})
