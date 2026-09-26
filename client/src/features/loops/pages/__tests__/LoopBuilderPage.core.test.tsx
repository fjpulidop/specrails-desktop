import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { Connection, Edge, Node } from '@xyflow/react'
import LoopBuilderPage from '../LoopBuilderPage'
import { loopsApi } from '../../lib/loops-api'
import type { LoopNodeData } from '../../lib/loop-graph-rf'
const canvas = vi.hoisted(() => ({
  props: {} as {
    nodes: Node<LoopNodeData>[]
    edges: Edge[]
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
