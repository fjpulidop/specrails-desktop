import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaletteItem } from '../../lib/agent-context-palette'

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { warning: vi.fn(), dismiss: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const chat = vi.hoisted(() => ({
  active: null as null | { tier_level: number },
  draftTierLevel: 0,
  cycleTier: vi.fn(async () => {}),
  setTier: vi.fn(async () => {}),
}))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => chat }))

import { renderHook } from '@testing-library/react'
import { AgentContextPalette, AgentPlusMenu } from '../AgentContextPalette'
import { AgentMessage } from '../AgentMessage'
import { useGuardedTierCycle } from '../../hooks/useGuardedTierCycle'

const item = (id: string, title: string, group = 'Specs'): AgentPaletteItem => ({ id, title, group, icon: 'spec', insertText: `#${id} ` } as unknown as AgentPaletteItem)

function mountPalette(anchorTop: number, anchorBottom = anchorTop + 120) {
  const items = [item('1', 'First'), item('2', 'Second'), item('3', 'Third', 'Jobs')]
  const utils = render(
    <div data-testid="anchor">
      <AgentContextPalette paletteId="pal" items={items} mode="reference" query="" activeIndex={1} onActiveIndexChange={vi.fn()} onSelect={vi.fn()} />
    </div>,
  )
  return { ...utils, items, anchorBottom }
}

beforeEach(() => {
  vi.clearAllMocks()
  chat.active = null
  chat.draftTierLevel = 0
})

describe('AgentContextPalette placement', () => {
  const stubRect = (top: number, bottom: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })

  it('flips below its anchor when the space above is too small (the centred empty composer)', () => {
    stubRect(120, 260)
    mountPalette(120)
    const palette = screen.getByTestId('agent-context-palette')
    expect(palette).toHaveAttribute('data-placement', 'below')
    expect(palette.className).toContain('top-[calc(100%+0.5rem)]')
    // The body is capped to the room left below the anchor.
    const listbox = screen.getByRole('listbox')
    expect(parseInt(listbox.style.maxHeight, 10)).toBeGreaterThanOrEqual(160)
  })

  it('opens above with a height capped to the room above the anchor', () => {
    stubRect(500, 640)
    mountPalette(500)
    const palette = screen.getByTestId('agent-context-palette')
    expect(palette).toHaveAttribute('data-placement', 'above')
    expect(palette.className).toContain('bottom-[calc(100%+0.5rem)]')
    const max = parseInt(screen.getByRole('listbox').style.maxHeight, 10)
    expect(max).toBeLessThanOrEqual(500 - 8 - 16)
    expect(max).toBeGreaterThanOrEqual(160)
  })
})

describe('AgentContextPalette as a listbox', () => {
  it('renders a labelled listbox with addressable options and presentational group headers', () => {
    mountPalette(500)
    const listbox = screen.getByRole('listbox', { name: 'Reference' })
    expect(listbox).toHaveAttribute('id', 'pal')
    const options = within(listbox).getAllByRole('option')
    expect(options.map((option) => option.id)).toEqual(['pal-opt-0', 'pal-opt-1', 'pal-opt-2'])
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(within(listbox).getByText('Jobs')).toHaveAttribute('role', 'presentation')
  })

  it('scrolls the active option into view', () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    mountPalette(500)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})

describe('AgentPlusMenu keyboard', () => {
  function mountMenu(overrides: Partial<Parameters<typeof AgentPlusMenu>[0]> = {}) {
    const onClose = vi.fn()
    const props = {
      open: true, canAttach: true, uploading: false, onToggle: vi.fn(), onClose, onOpenMode: vi.fn(), onAttachFile: vi.fn(),
      canBrowserCapture: false, onOpenBrowser: vi.fn(), ...overrides,
    }
    render(<AgentPlusMenu {...props} />)
    return { ...props, onClose }
  }

  it('is a menu that lands on the first item and moves with the arrows, Home and End (skipping disabled items)', () => {
    mountMenu()
    const trigger = screen.getByRole('button', { name: 'Add context or action' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(menu, { key: 'End' })
    // Browser capture is disabled, so End lands on the file attachment item.
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[3])
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(items[0])
  })

  it('closes on Escape and returns focus to its trigger', () => {
    const { onClose } = mountMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add context or action' }))
  })

  it('shows upload progress on the file item', () => {
    mountMenu({ uploading: true })
    const file = screen.getByTestId('agent-plus-file-attachment')
    expect(file).toBeDisabled()
    expect(file).toHaveTextContent('Uploading…')
  })
})

describe('AgentMessage reading and copying', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
  })

  it('labels each message as an article by its author', () => {
    render(<><AgentMessage role="user" content="hola" /><AgentMessage role="assistant" content="hi there" /></>)
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent('hola')
    expect(screen.getByRole('article', { name: 'Agent' })).toHaveTextContent('hi there')
  })

  it('gives fenced code a language label and a copy button that copies the code and announces it', async () => {
    render(<AgentMessage role="assistant" content={'Run:\n\n```ts\nconst a = 1\n```'} />)
    expect(screen.getByTestId('agent-code-language')).toHaveTextContent('ts')
    const copy = screen.getByRole('button', { name: 'Copy code' })
    expect(copy.className).toContain('focus-visible:opacity-100')
    await act(async () => { fireEvent.click(copy) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1\n')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(within(screen.getByRole('button', { name: 'Copied' })).getByRole('status')).toHaveTextContent('Copied')
  })

  it('keeps the message copy button reachable by keyboard and announces success', async () => {
    render(<AgentMessage role="assistant" content="hello" />)
    const copy = screen.getByRole('button', { name: 'Copy' })
    expect(copy.className).toContain('focus-visible:opacity-100')
    await act(async () => { fireEvent.click(copy) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
  })

  it('groups suggested replies with numbered, focus-visible chips', () => {
    render(<AgentMessage role="assistant" content={'Pick:\n\n```options\n["Yes", "No"]\n```'} isLast onPickOption={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'Suggested replies' })
    const [yes, no] = within(group).getAllByRole('button')
    expect(yes).toHaveTextContent('1Yes')
    expect(yes).toHaveAttribute('aria-keyshortcuts', 'Alt+1')
    expect(no).toHaveAttribute('aria-keyshortcuts', 'Alt+2')
    expect(yes.className).toContain('focus-visible:ring-2')
  })
})

describe('useGuardedTierCycle', () => {
  it('raises immediately below Autonomous', () => {
    chat.draftTierLevel = 1
    const { result } = renderHook(() => useGuardedTierCycle())
    act(() => result.current())
    expect(chat.cycleTier).toHaveBeenCalledTimes(1)
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('never enters Autonomous on ⇧⇥ alone: it asks, and the confirm action switches', () => {
    chat.draftTierLevel = 2
    const { result } = renderHook(() => useGuardedTierCycle())
    act(() => result.current())
    expect(chat.cycleTier).not.toHaveBeenCalled()
    expect(chat.setTier).not.toHaveBeenCalled()
    expect(toastMock.warning).toHaveBeenCalledWith('Autonomous can delete and kill processes.', expect.objectContaining({
      action: expect.objectContaining({ label: 'Switch to Autonomous' }),
    }))
    const options = toastMock.warning.mock.calls[0][1] as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    expect(chat.setTier).toHaveBeenCalledWith(3)
  })

  it('a second ⇧⇥ while the confirm is pending skips Autonomous back to Observe', () => {
    chat.draftTierLevel = 2
    const { result } = renderHook(() => useGuardedTierCycle())
    act(() => result.current())
    act(() => result.current())
    expect(chat.setTier).toHaveBeenCalledWith(0)
    expect(toastMock.dismiss).toHaveBeenCalled()
  })

  it('lowers from Autonomous without asking', () => {
    chat.active = { tier_level: 3 }
    const { result } = renderHook(() => useGuardedTierCycle())
    act(() => result.current())
    expect(chat.cycleTier).toHaveBeenCalledTimes(1)
    expect(toastMock.warning).not.toHaveBeenCalled()
  })
})
