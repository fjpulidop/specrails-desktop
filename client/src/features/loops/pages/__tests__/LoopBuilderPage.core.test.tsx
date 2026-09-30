import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { Connection, Edge, Node } from '@xyflow/react'
import LoopBuilderPage from '../LoopBuilderPage'
import { openLoopWindow } from '../../lib/loop-windows'
vi.mock('../../lib/loop-windows', () => ({ isLoopWindowRoute: () => false, openLoopWindow: vi.fn().mockResolvedValue(undefined) }))
import { loopsApi } from '../../lib/loops-api'
import type { LoopNodeData } from '../../lib/loop-graph-rf'
const canvas = vi.hoisted(() => ({
  props: {} as {
    nodes: Node<LoopNodeData>[]
    edges: Edge[]
    onPaneClick: () => void
    onNodeClick: (event: unknown, node: Node<LoopNodeData>) => void
    onConnect: (connection: Connection) => void
    isValidConnection: (connection: Connection) => boolean
  },
}))
vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: (props: typeof canvas.props & { children: ReactNode }) => {
      canvas.props = props
      return <div data-testid="canvas">{props.children}</div>
    },
    useReactFlow: () => ({
      fitView: vi.fn(),
      screenToFlowPosition: (point: { x: number; y: number }) => point,
    }),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
})
vi.mock('../../lib/loops-api', async (original) => ({
  ...(await original<typeof import('../../lib/loops-api')>()),
  loopsApi: {
    get: vi.fn(),
    update: vi.fn(),
    publish: vi.fn(),
    catalog: vi.fn(),
    loopConstants: vi.fn(),
    loopCommands: vi.fn(),
  },
}))
const api = vi.mocked(loopsApi)
beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue({
    id: 'demo',
    name: 'Demo',
    description: null,
    status: 'draft',
    createdAt: '',
    updatedAt: '',
    graph: {
      nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }],
      edges: [],
      config: { maxIterations: 3, timeoutMinutes: 30 },
    },
  })
  api.catalog.mockResolvedValue({
    nodeKindsVersion: 1,
    builtins: [],
    nodeKinds: [
      {
        kind: 'condition',
        paramsSchema: {
          type: 'object',
          required: ['expr'],
          additionalProperties: false,
          properties: { expr: { type: 'string' } },
        },
        outcomes: ['true', 'false'],
        effect: 'read',
        requiresAI: false,
      },
      {
        kind: 'end',
        paramsSchema: {
          type: 'object',
          required: ['outcome'],
          additionalProperties: false,
          properties: { outcome: { enum: ['success', 'failure'] } },
        },
        outcomes: [],
        effect: 'read',
        requiresAI: false,
      },
    ],
  })
  api.loopConstants.mockResolvedValue([])
  api.loopCommands.mockResolvedValue([])
  api.update.mockImplementation(async (_id, patch) => ({ ...(await api.get('demo')), ...patch }))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [], status: {} }) }),
  )
})
afterEach(() => vi.unstubAllGlobals())
function page() {
  return render(
    <MemoryRouter>
      <LoopBuilderPage loopId="demo" />
    </MemoryRouter>,
  )
}
describe('Core canvas authoring', () => {
  it('places a dragged catalog piece at the canvas coordinates', async () => {
    page()
    await screen.findByRole('button', { name: 'Condition' })
    const event = new Event('drop', { bubbles: true })
    Object.defineProperties(event, {
      dataTransfer: { value: { getData: () => 'condition' } },
      clientX: { value: 80 },
      clientY: { value: 120 },
    })
    act(() => screen.getByTestId('canvas').dispatchEvent(event))
    await waitFor(() => expect(canvas.props.nodes).toHaveLength(2))
    expect(canvas.props.nodes[1].position).toEqual({ x: 80, y: 120 })
  })
  it('adds a piece through the keyboard-accessible palette and validates outcome connections', async () => {
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Condition' }))
    await waitFor(() => expect(canvas.props.nodes).toHaveLength(2))
    const node = canvas.props.nodes[1]
    expect(node.data).toMatchObject({ kind: 'core', coreKind: 'condition', params: { expr: '' } })
    const connection = { source: node.id, target: node.id, sourceHandle: 'true', targetHandle: null }
    expect(canvas.props.isValidConnection(connection)).toBe(true)
    act(() => canvas.props.onConnect(connection))
    expect(canvas.props.isValidConnection(connection)).toBe(false)
    expect(canvas.props.isValidConnection({ ...connection, sourceHandle: 'invalid' })).toBe(false)
    expect(canvas.props.isValidConnection({ ...connection, target: 'start' })).toBe(false)
  })
  it('creates a component canvas and preserves it when saving the root graph', async () => {
    page()
    await screen.findByRole('button', { name: 'Condition' })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    fireEvent.change(screen.getByLabelText('Component name'), { target: { value: 'review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    await waitFor(() => expect(canvas.props.nodes.some((node) => node.data.coreKind === 'end')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Demo' }))
    await waitFor(() => expect(canvas.props.nodes.map((node) => node.id)).toEqual(['start']))
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(api.update).toHaveBeenCalled())
    expect(api.update.mock.calls[0][1].graph?.components?.review).toMatchObject({
      inputs: [],
      outputs: ['next', 'failed'],
      nodes: expect.arrayContaining([
        expect.objectContaining({ type: 'core', data: { kind: 'end', params: { outcome: 'success' } } }),
      ]),
    })
  })
})


it('saves an explicitly untimed workflow instead of clamping it to one minute', async () => {
  page()
  await screen.findByRole('button', { name: 'Condition' })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Timeout (min)' }), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: /Save/ }))
  await waitFor(() => expect(api.update).toHaveBeenCalled())
  expect(api.update.mock.calls[0][1].graph?.config.timeoutMinutes).toBe(0)
})

it('keeps general settings closed until explicitly requested and returns to the node inspector on selection', async () => {
  page()
  const settings = await screen.findByRole('button', { name: 'Advanced settings' })
  expect(screen.queryByRole('heading', { name: 'Loop agents' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Component name')).not.toBeInTheDocument()
  fireEvent.click(settings)
  expect(screen.getByRole('heading', { name: 'Workflow policy' })).toBeInTheDocument()
  expect(settings).toHaveAttribute('aria-pressed', 'true')
  act(() => canvas.props.onNodeClick({}, canvas.props.nodes[0]))
  expect(screen.queryByRole('heading', { name: 'Loop agents' })).not.toBeInTheDocument()
  expect(settings).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(settings)
  act(() => canvas.props.onPaneClick())
  expect(screen.queryByRole('heading', { name: 'Loop agents' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Component name')).not.toBeInTheDocument()
})

it('adds independent configurable agent steps to a custom loop and saves their definitions', async () => {
  const catalog = await api.catalog()
  api.catalog.mockResolvedValue({ ...catalog, nodeKinds: [...catalog.nodeKinds, { kind: 'role-turn', paramsSchema: { type: 'object', required: ['roleId', 'prompt'], properties: { roleId: { type: 'string' }, prompt: { type: 'string' } } }, outcomes: ['next', 'failed'], effect: 'write', requiresAI: true }] })
  page()
  await screen.findByRole('button', { name: 'Advanced settings' })
  fireEvent.click(screen.getByRole('button', { name: 'Agent step' }))
  const first = canvas.props.nodes.find(node => node.data.coreKind === 'role-turn')!
  const roleId = String(first.data.params?.roleId)
  expect(screen.queryByLabelText('phase')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Role instructions'), { target: { value: 'Implement accessibility checks' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'my-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Agent step' }))
  const second = canvas.props.nodes.filter(node => node.data.coreKind === 'role-turn').at(-1)!
  expect(second.data.params?.roleId).not.toBe(roleId)
  expect(screen.getByLabelText('Role instructions')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('Role instructions'), { target: { value: 'Run a separate audit' } })
  fireEvent.click(screen.getByRole('button', { name: /Save/ }))
  await waitFor(() => expect(api.update).toHaveBeenCalled())
  const roles = api.update.mock.calls[0][1].graph?.config.agents?.roles
  expect(roles?.[roleId]).toMatchObject({ model: 'my-model', prompt: 'Implement accessibility checks' })
  expect(roles?.[String(second.data.params?.roleId)]).toMatchObject({ prompt: 'Run a separate audit' })
})


describe('board editor window handoff', () => {
  it('saves the current draft before opening its window and leaving the embedded editor', async () => {
    const exit = vi.fn()
    render(<MemoryRouter><LoopBuilderPage loopId="demo" onExit={exit} /></MemoryRouter>)
    await screen.findByDisplayValue('Demo')
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Edited draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open in window' }))
    await waitFor(() => expect(exit).toHaveBeenCalledOnce())
    expect(api.update).toHaveBeenCalledWith('demo', expect.objectContaining({ name: 'Edited draft' }))
    expect(openLoopWindow).toHaveBeenCalledWith(null, 'demo')
    expect(api.update.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(openLoopWindow).mock.invocationCallOrder.at(-1)!)
  })
  it('keeps the editor when saving fails', async () => {
    api.update.mockRejectedValueOnce(new Error('Loop is running'))
    const exit = vi.fn()
    render(<MemoryRouter><LoopBuilderPage loopId="demo" onExit={exit} /></MemoryRouter>)
    await screen.findByDisplayValue('Demo')
    fireEvent.click(screen.getByRole('button', { name: 'Open in window' }))
    await waitFor(() => expect(api.update).toHaveBeenCalled())
    expect(openLoopWindow).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})


it('saves and dismisses the mission modal only after opening the editor window', async () => {
  const exit = vi.fn()
  const dismiss = vi.fn()
  render(<MemoryRouter><LoopBuilderPage loopId="demo" onExit={exit} onWindowOpened={dismiss} /></MemoryRouter>)
  await screen.findByDisplayValue('Demo')
  fireEvent.click(screen.getByRole('button', { name: 'Open in window' }))
  await waitFor(() => expect(dismiss).toHaveBeenCalledOnce())
  expect(exit).not.toHaveBeenCalled()
  expect(api.update.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(openLoopWindow).mock.invocationCallOrder.at(-1)!)
})
