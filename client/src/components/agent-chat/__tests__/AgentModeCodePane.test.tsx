import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentModeCodePane } from '../AgentModeCodePane'

const mocks = vi.hoisted(() => ({ close: vi.fn() }))
vi.mock('../../../context/AgentWorkspaceContext', () => ({ useAgentWorkspace: () => ({ closeCodePane: mocks.close }) }))
vi.mock('../../../pages/CodePage', () => ({ default: (props: { initialPath: string | null; initialRepositoryId?: string; onSelectedPathChange: (path: string) => void; onRepositoryChange: (id: string) => void }) => <div>
  <span data-testid="selection">{props.initialRepositoryId ?? 'primary'}:{props.initialPath ?? 'none'}</span>
  <button onClick={() => { props.onRepositoryChange('api'); props.onSelectedPathChange('src/api.ts') }}>Choose file</button>
</div> }))

let parentWidth = 1100
let fixedWidth = 0
let resizeCallbacks: Array<() => void> = []
class PointerFixture extends MouseEvent {
  readonly pointerId: number
  constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) { super(type, options); this.pointerId = options.pointerId ?? 1 }
}
function frame(conversationId = 'c1', projectId = 'p1') {
  return <div data-testid="surface" style={{ display: 'flex' }}>
    <div data-testid="conversation" style={{ flexGrow: 1 }} />
    <div data-testid="fixed" style={{ flexShrink: 0 }} />
    <AgentModeCodePane projectId={projectId} conversationId={conversationId} />
  </div>
}
function paneWidth() { return Number.parseFloat(screen.getByTestId('agent-code-pane').style.width) }
function startDrag(x = 500) { fireEvent.pointerDown(screen.getByRole('separator'), { button: 0, clientX: x, pointerId: 7 }) }

beforeEach(() => {
  vi.clearAllMocks()
  parentWidth = 1100; fixedWidth = 0; resizeCallbacks = []
  vi.stubGlobal('PointerEvent', PointerFixture)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback) }
    observe() {} disconnect() {} unobserve() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.dataset.testid === 'surface' ? parentWidth : this.dataset.testid === 'fixed' ? fixedWidth : this.dataset.testid === 'conversation' ? 400 : 0
    return { width, height: 720, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 720, toJSON() {} }
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('AgentModeCodePane sizing', () => {
  it('uses actual surface space and adapts to shrinkage without losing the preferred width', async () => {
    render(frame())
    await screen.findByRole('button', { name: 'Choose file' })
    expect(paneWidth()).toBe(560)
    parentWidth = 700
    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(paneWidth()).toBe(350)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuemin', '350')
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuemax', '350')
    parentWidth = 1100
    act(() => window.dispatchEvent(new Event('resize')))
    expect(paneWidth()).toBe(560)
    fixedWidth = 480
    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(paneWidth()).toBe(310)
    parentWidth = 400
    act(() => window.dispatchEvent(new Event('resize')))
    expect(paneWidth()).toBe(0)
    expect(screen.getByTestId('agent-code-pane').style.maxWidth).toBe('100%')
  })

  it('has a full-height keyboard and pointer handle and releases a completed drag', async () => {
    render(frame())
    await screen.findByRole('button', { name: 'Choose file' })
    const separator = screen.getByRole('separator')
    expect(separator).toHaveClass('inset-y-0')
    expect(separator).not.toHaveClass('-translate-x-full')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(paneWidth()).toBe(680)
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(paneWidth()).toBe(420)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(paneWidth()).toBe(452)
    startDrag()
    fireEvent.pointerMove(window, { clientX: 450, pointerId: 99 })
    expect(paneWidth()).toBe(452)
    fireEvent.pointerMove(window, { clientX: 450, pointerId: 7 })
    expect(paneWidth()).toBe(502)
    fireEvent.pointerUp(window, { pointerId: 7 })
    fireEvent.pointerMove(window, { clientX: 200, pointerId: 7 })
    expect(paneWidth()).toBe(502)
  })

  it('removes drag listeners on blur, scope switches, maximize and unmount', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { rerender, unmount } = render(frame('resize-a'))
    await screen.findByRole('button', { name: 'Choose file' })
    startDrag(); fireEvent.blur(window)
    expect(remove.mock.calls.some(([type]) => type === 'pointermove')).toBe(true)
    startDrag(); rerender(frame('resize-b'))
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 7 })
    expect(paneWidth()).toBe(560)
    startDrag(); fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(paneWidth()).toBe(560)
    startDrag(); remove.mockClear(); unmount()
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel', 'blur', 'resize']))
  })

  it('retains repository and file selection per project and conversation', async () => {
    const { rerender } = render(frame('selection', 'first-project'))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose file' }))
    rerender(frame('selection', 'second-project'))
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('primary:none'))
    rerender(frame('selection', 'first-project'))
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('api:src/api.ts'))
  })
})
