import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MissionSplitViewsProvider, PRIMARY_PANE, useMissionPaneId, useMissionSplitViews, type MissionSplitViews } from '../../context/MissionSplitViewsContext'
import { MissionSplitLayout } from '../MissionSplitLayout'
import { MissionPaneLayoutMenu } from '../MissionPaneLayoutMenu'
import { splitLeaves } from '../../lib/mission-split-tree'

// The pane's whole mission stack is replaced by a stateful probe: it counts
// mounts and keeps typed text and a live "stream" in local state, so a remount
// would lose them.
const mounts = vi.hoisted(() => new Map<string, number>())
const Fixed = createContext<string | null>(null)
const conversations = ['p', 'a', 'b', 'c', 'd'].map(id => ({ id, title: `Mission ${id}`, archivedAt: null, updated_at: id === 'p' ? '2026-10-01' : `2026-11-0${id.charCodeAt(0) - 96}` }))
vi.mock('../../context/AgentChatContext', () => ({
  AgentChatProvider: ({ fixedConversationId, children }: { fixedConversationId: string; children: ReactNode }) =>
    <Fixed.Provider value={fixedConversationId}>{children}</Fixed.Provider>,
  useAgentChat: () => {
    const id = useContext(Fixed) ?? 'p'
    return { active: { id }, conversations, selectConversation: async () => {} }
  },
}))
vi.mock('../../context/AgentWorkspaceContext', () => ({ AgentWorkspaceProvider: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('../AgentBrowserCaptureHost', () => ({ AgentBrowserCaptureHost: () => null }))
vi.mock('../AgentModeSurface', () => ({ AgentModeSurface: () => <Probe /> }))

function Probe() {
  const paneId = useMissionPaneId() ?? 'none'
  const [stream, setStream] = useState('')
  useEffect(() => { mounts.set(paneId, (mounts.get(paneId) ?? 0) + 1) }, [paneId])
  return <div data-testid={`probe-${paneId}`}>
    <input aria-label={`draft ${paneId}`} />
    <button onClick={() => setStream(value => `${value}token `)}>stream {paneId}</button>
    <output data-testid={`stream-${paneId}`}>{stream}</output>
    <MissionPaneLayoutMenu />
  </div>
}

let views: MissionSplitViews
function Capture() { views = useMissionSplitViews(); return null }
function Harness({ children }: { children?: ReactNode }) {
  return <MissionSplitViewsProvider primaryId="p"><Capture />
    <MissionSplitLayout><Probe /></MissionSplitLayout>{children}
  </MissionSplitViewsProvider>
}

let size = { width: 1600, height: 900 }
beforeEach(() => {
  mounts.clear()
  size = { width: 1600, height: 900 }
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.splitCount ? size.width : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.splitCount ? size.height : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, x: 0, y: 0, width: size.width, height: size.height, right: size.width, bottom: size.height, toJSON: () => ({}) } as DOMRect
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

const pane = (id: string) => document.querySelector<HTMLElement>(`[data-split-pane="${id}"]`)!
const divider = (path = 'root') => document.querySelector<HTMLElement>(`[data-split-divider="${path}"]`)!

describe('MissionSplitLayout', () => {
  it('never remounts a live pane when the layout is split, moved, swapped, resized or maximized', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    act(() => views.open('a'))
    act(() => views.open('b'))
    await user.type(screen.getByLabelText('draft a'), 'unsent')
    await user.click(screen.getByRole('button', { name: 'stream a' }))
    const nodes = [PRIMARY_PANE, 'a', 'b'].map(pane)
    act(() => views.openBeside('c', 'down', 'a'))
    act(() => views.move('a', 'left'))
    act(() => views.swap('b', PRIMARY_PANE))
    act(() => views.setRatio([], 0.4))
    act(() => views.equalize())
    act(() => views.toggleMaximize('a'))
    act(() => views.toggleMaximize())
    expect([PRIMARY_PANE, 'a', 'b'].map(pane)).toEqual(nodes)
    expect(screen.getByLabelText('draft a')).toHaveValue('unsent')
    expect(screen.getByTestId('stream-a')).toHaveTextContent('token')
    expect(mounts.get('a')).toBe(1)
    expect(mounts.get(PRIMARY_PANE)).toBe(1)
    // DOM order is the order panes were added, whatever the arrangement.
    expect([...document.querySelectorAll('[data-split-pane]')].map(node => node.getAttribute('data-split-pane'))).toEqual([PRIMARY_PANE, 'a', 'b', 'c'])
  })

  it('draws panes as boxes of the tree and hides all but a maximized pane (inert, still mounted)', () => {
    render(<Harness />)
    act(() => views.open('a'))
    expect(pane(PRIMARY_PANE)).toHaveStyle({ left: '0%', width: '50%' })
    expect(pane('a')).toHaveStyle({ left: '50%', width: '50%' })
    act(() => views.toggleMaximize('a'))
    expect(pane('a')).toHaveStyle({ left: '0%', width: '100%' })
    expect(pane(PRIMARY_PANE)).toHaveStyle({ visibility: 'hidden' })
    expect(pane(PRIMARY_PANE)).toHaveAttribute('inert')
    expect(document.querySelector('[data-split-divider]')).toBeNull()
    expect(document.querySelector('[data-mission-split-layout]')).toHaveAttribute('data-split-mode', 'maximized')
  })

  it('drags a divider with pointer capture: previews without rendering, keeps the grab offset, clamps, snaps and commits once', () => {
    render(<Harness />)
    act(() => views.open('a'))
    const handle = divider()
    expect(handle).toHaveAttribute('role', 'separator')
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '50')
    const committed = views.tree
    fireEvent.pointerDown(handle, { button: 0, clientX: 805, pointerId: 1 })
    expect(document.querySelector('[data-split-drag-shield]')).not.toBeNull()
    fireEvent.pointerMove(window, { clientX: 405, pointerId: 1, buttons: 1 })
    // Previewed imperatively: the stored tree has not changed yet. 400/1600 = 25%.
    expect(pane('a')).toHaveStyle({ left: '25%' })
    expect(views.tree).toBe(committed)
    fireEvent.pointerMove(window, { clientX: 5, pointerId: 1, buttons: 1 })
    expect(pane('a')).toHaveStyle({ left: '22.5%' }) // 360px minimum
    fireEvent.pointerUp(window, { clientX: 5, pointerId: 1 })
    expect(document.querySelector('[data-split-drag-shield]')).toBeNull()
    expect((views.tree as { ratio: number }).ratio).toBeCloseTo(0.225)
    // Within 24px of the middle snaps to one half.
    fireEvent.pointerDown(divider(), { button: 0, clientX: 360, pointerId: 2 })
    fireEvent.pointerMove(window, { clientX: 815, pointerId: 2, buttons: 1 })
    fireEvent.pointerUp(window, { clientX: 815, pointerId: 2 })
    expect((views.tree as { ratio: number }).ratio).toBe(0.5)
  })

  it.each([
    ['window blur', () => fireEvent.blur(window)],
    ['a move with no button pressed', () => fireEvent.pointerMove(window, { clientX: 600, pointerId: 1, buttons: 0 })],
    ['a lost pointer capture', () => fireEvent(divider(), new Event('lostpointercapture'))],
  ])('ends a drag on %s and commits the last position', (_, end) => {
    render(<Harness />)
    act(() => views.open('a'))
    fireEvent.pointerDown(divider(), { button: 0, clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 640, pointerId: 1, buttons: 1 })
    end()
    expect(document.querySelector('[data-split-drag-shield]')).toBeNull()
    expect(document.body.style.cursor).toBe('')
    expect((views.tree as { ratio: number }).ratio).toBeCloseTo(0.4)
  })

  it('cancels a drag with Escape, restoring the committed layout', () => {
    render(<Harness />)
    act(() => views.open('a'))
    fireEvent.pointerDown(divider(), { button: 0, clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 640, pointerId: 1, buttons: 1 })
    expect(pane('a')).toHaveStyle({ left: '40%' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(pane('a')).toHaveStyle({ left: '50%' })
    expect((views.tree as { ratio: number }).ratio).toBe(0.5)
  })

  it('resizes from the keyboard and equalizes on double-click', () => {
    render(<Harness />)
    act(() => views.open('a'))
    act(() => views.openBeside('b', 'down', 'a'))
    const handle = divider()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(divider()).toHaveAttribute('aria-valuenow', '52')
    fireEvent.keyDown(divider(), { key: 'ArrowLeft', shiftKey: true })
    expect(divider()).toHaveAttribute('aria-valuenow', '42')
    fireEvent.keyDown(divider(), { key: 'Home' })
    expect(divider()).toHaveAttribute('aria-valuenow', '50')
    const inner = divider('1')
    expect(inner).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent.keyDown(inner, { key: 'ArrowDown', shiftKey: true })
    expect(divider('1')).toHaveAttribute('aria-valuenow', '60')
    fireEvent.doubleClick(divider('1'))
    expect(divider('1')).toHaveAttribute('aria-valuenow', '50')
  })

  it('stacks panes behind a tab strip when they cannot keep their minimum size', async () => {
    size = { width: 600, height: 900 }
    const user = userEvent.setup()
    render(<Harness />)
    // Opening picks the side that fits (below); right of it cannot keep 360px each.
    act(() => views.open('a'))
    expect(views.tree).toMatchObject({ direction: 'column' })
    expect(document.querySelector('[data-mission-split-layout]')).toHaveAttribute('data-split-mode', 'split')
    act(() => views.openBeside('a', 'right', PRIMARY_PANE))
    expect(document.querySelector('[data-mission-split-layout]')).toHaveAttribute('data-split-mode', 'stacked')
    const tabs = screen.getByRole('tablist')
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Mission p', 'Mission a'])
    expect(pane('a')).not.toHaveAttribute('inert')
    expect(pane(PRIMARY_PANE)).toHaveAttribute('inert')
    await user.click(within(tabs).getByRole('tab', { name: 'Mission p' }))
    expect(pane(PRIMARY_PANE)).not.toHaveAttribute('inert')
    expect(views.visiblePaneIds).toEqual([PRIMARY_PANE])
    fireEvent.keyDown(within(tabs).getByRole('tab', { name: 'Mission p' }), { key: 'ArrowRight' })
    expect(views.focusedId).toBe('a')
  })

  it('runs the layout shortcuts with two or more panes', () => {
    render(<Harness />)
    act(() => views.open('a'))
    act(() => views.open('b'))
    const target = screen.getByLabelText('draft a')
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true, shiftKey: true })
    expect(views.maximizedId).toBe('b')
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true, shiftKey: true })
    expect(views.maximizedId).toBeNull()
    fireEvent.keyDown(document.body, { key: ']', code: 'BracketRight', ctrlKey: true, altKey: true })
    expect(views.focusedId).toBeNull()
    fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true })
    expect(views.focusedId).toBe('b')
    act(() => views.setRatio([], 0.2))
    fireEvent.keyDown(document.body, { key: '=', code: 'Equal', ctrlKey: true, altKey: true })
    expect((views.tree as { ratio: number }).ratio).toBeCloseTo(1 / 3)
    // Ctrl+Alt is AltGr off macOS: ignored while typing.
    fireEvent.keyDown(target, { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true })
    expect(splitLeaves(views.tree)).toHaveLength(3)
    fireEvent.keyDown(document.body, { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true })
    expect(splitLeaves(views.tree)).toEqual([PRIMARY_PANE, 'a'])
  })

  it('offers layout actions in each pane header menu', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    act(() => views.open('a'))
    const menuOf = (id: string) => within(screen.getByTestId(`probe-${id}`)).getByRole('button', { name: 'Pane layout' })
    await user.click(menuOf('a'))
    expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeDisabled()
    await user.click(screen.getByRole('menuitem', { name: 'Move left' }))
    expect(splitLeaves(views.tree)).toEqual(['a', PRIMARY_PANE])
    await user.click(menuOf('a'))
    await user.click(screen.getByRole('menuitem', { name: /Split down/ }))
    // The newest missions not on screen.
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Split down', 'Mission d', 'Mission c', 'Mission b'])
    await user.click(screen.getByRole('menuitem', { name: 'Mission c' }))
    expect(views.tree).toMatchObject({ first: { direction: 'column', first: { paneId: 'a' }, second: { paneId: 'c' } } })
    await user.click(menuOf('c'))
    await user.click(screen.getByRole('menuitem', { name: /Swap with/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Mission p' }))
    expect(splitLeaves(views.tree)).toEqual(['a', PRIMARY_PANE, 'c'])
    await user.click(menuOf('a'))
    await user.click(screen.getByRole('menuitem', { name: /Maximize pane/ }))
    expect(views.maximizedId).toBe('a')
    await user.click(menuOf('a'))
    await user.click(screen.getByRole('menuitem', { name: /Restore layout/ }))
    expect(views.maximizedId).toBeNull()
    act(() => views.setRatio([], 0.2))
    await user.click(menuOf('a'))
    await user.click(screen.getByRole('menuitem', { name: /Equalize panes/ }))
    expect((views.tree as { ratio: number }).ratio).toBe(0.5)
    await user.click(menuOf('c'))
    await user.click(screen.getByRole('menuitem', { name: /Close pane/ }))
    expect(splitLeaves(views.tree)).toEqual(['a', PRIMARY_PANE])
  })

  it('disables a move that would leave a pane below its minimum size', async () => {
    size = { width: 1000, height: 600 }
    const user = userEvent.setup()
    render(<Harness />)
    act(() => views.open('a'))
    act(() => views.openBeside('b', 'down', 'a'))
    await user.click(within(screen.getByTestId('probe-b')).getByRole('button', { name: 'Pane layout' }))
    // Beside the primary pane would make three columns: 1080px.
    expect(screen.getByRole('menuitem', { name: 'Move left' })).toHaveAttribute('title', 'Not enough room for this layout')
    expect(screen.getByRole('menuitem', { name: 'Move left' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeEnabled()
  })
})
