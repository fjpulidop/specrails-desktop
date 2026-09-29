import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import LoopBuilderPage from '../LoopBuilderPage'
import { loopsApi, type LoopDefinition } from '../../lib/loops-api'

vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: ({ children }: { children: ReactNode }) => <div data-testid="canvas">{children}</div>,
    useReactFlow: () => ({ fitView: vi.fn(), screenToFlowPosition: (point: { x: number; y: number }) => point }),
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
    restoreBuiltin: vi.fn(),
    catalog: vi.fn(),
    loopConstants: vi.fn(),
    loopCommands: vi.fn(),
  },
}))
const api = vi.mocked(loopsApi)

function builtin(over: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: 'factory:implement',
    builtinId: 'factory:implement',
    builtinModified: true,
    name: 'Team Implement',
    description: null,
    status: 'draft',
    createdAt: '',
    updatedAt: '',
    graph: { nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }], edges: [], config: { maxIterations: 3, timeoutMinutes: 0 } },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.catalog.mockRejectedValue(new Error('no core'))
  api.loopConstants.mockResolvedValue([])
  api.loopCommands.mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [], status: {} }) }))
})
afterEach(() => vi.unstubAllGlobals())

function page(id: string) {
  return render(<MemoryRouter><LoopBuilderPage loopId={id} /></MemoryRouter>)
}

describe('LoopBuilderPage — editable built-ins', () => {
  it('explains the in-place semantics and restores the original after confirmation', async () => {
    api.get.mockResolvedValue(builtin())
    api.restoreBuiltin.mockResolvedValue(builtin({ name: 'Implement', builtinModified: false, status: 'published' }))
    page('factory:implement')
    expect(await screen.findByTestId('builder-builtin-note')).toHaveTextContent(/every rail/i)
    expect(screen.getByDisplayValue('Team Implement')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('builder-restore-builtin'))
    fireEvent.click(await screen.findByTestId('builder-restore-confirm'))
    await waitFor(() => expect(api.restoreBuiltin).toHaveBeenCalledWith('factory:implement'))
    await waitFor(() => expect(screen.getByDisplayValue('Implement')).toBeInTheDocument())
  })

  it('shows neither the note nor Restore original for an ordinary loop', async () => {
    api.get.mockResolvedValue(builtin({ id: 'mine', builtinId: undefined, builtinModified: undefined, name: 'Mine' }))
    page('mine')
    expect(await screen.findByDisplayValue('Mine')).toBeInTheDocument()
    expect(screen.queryByTestId('builder-builtin-note')).not.toBeInTheDocument()
    expect(screen.queryByTestId('builder-restore-builtin')).not.toBeInTheDocument()
  })
})
