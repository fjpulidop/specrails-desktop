/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { TerminalTopBar } from '../TerminalTopBar'

function renderBar(overrides: Partial<Parameters<typeof TerminalTopBar>[0]> = {}) {
  const handlers = {
    onCreate: vi.fn(),
    onOpenCli: vi.fn(),
    onOpenBrowser: vi.fn(),
    onPasteScript: vi.fn(),
    onConfigureBrowser: vi.fn(),
    onConfigureScript: vi.fn(),
    onKillActive: vi.fn(),
    onToggleMaximize: vi.fn(),
    onCollapse: vi.fn(),
  }
  const props = {
    visibility: 'restored' as const,
    canCreate: true,
    hasActive: true,
    pasteScriptDisabled: false,
    ...handlers,
    ...overrides,
  }
  const rendered = render(<TerminalTopBar {...props} />)
  return { ...rendered, ...handlers }
}

describe('TerminalTopBar', () => {
  it('renders Terminal label', () => {
    const { getByText } = renderBar()
    expect(getByText('Terminal')).toBeDefined()
  })

  it('fires onCreate when + clicked', () => {
    const { getByLabelText, onCreate } = renderBar()
    fireEvent.click(getByLabelText(/^new terminal$/i))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('+ is disabled with tooltip when canCreate is false', () => {
    const { getAllByLabelText } = renderBar({ canCreate: false })
    // Both the Open Claude and the New Terminal share the "max 10" tooltip text;
    // assert at least one is disabled.
    const btns = getAllByLabelText(/max 10 terminals/i)
    expect(btns.length).toBeGreaterThan(0)
    expect(btns.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('fires onKillActive when trash clicked', () => {
    const { getByLabelText, onKillActive } = renderBar()
    fireEvent.click(getByLabelText(/kill active terminal/i))
    expect(onKillActive).toHaveBeenCalledTimes(1)
  })

  it('trash is disabled when hasActive is false', () => {
    const { getByLabelText } = renderBar({ hasActive: false })
    expect((getByLabelText(/kill active terminal/i) as HTMLButtonElement).disabled).toBe(true)
  })

  it('fires onToggleMaximize when maximize clicked', () => {
    const { getByLabelText, onToggleMaximize } = renderBar()
    fireEvent.click(getByLabelText(/maximize panel/i))
    expect(onToggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('fires onCollapse when chevron clicked', () => {
    const { getByLabelText, onCollapse } = renderBar()
    fireEvent.click(getByLabelText(/collapse terminal panel/i))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('shows Restore button when maximized', () => {
    const { getByLabelText } = renderBar({ visibility: 'maximized' })
    expect(getByLabelText(/restore panel/i)).toBeDefined()
  })

  it('labels the CLI shortcut "Open Claude" by default', () => {
    const { getByLabelText } = renderBar()
    expect(getByLabelText(/open claude in new terminal/i)).toBeDefined()
  })

  it('labels the CLI shortcut "Open Codex" when provider is codex', () => {
    const { getByLabelText } = renderBar({ provider: 'codex' })
    expect(getByLabelText(/open codex in new terminal/i)).toBeDefined()
  })
})
