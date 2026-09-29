import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RailLoopSelector } from '../RailLoopSelector'
import { loopsApi } from '../../../loops/lib/loops-api'

vi.mock('../../../loops/lib/loops-api', () => ({
  loopsApi: { list: vi.fn() },
}))
const api = loopsApi as unknown as { list: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue([])
})

describe('RailLoopSelector (unified rail Loop picker)', () => {
  it('always offers the built-in factory loops', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled={false} />)
    const sel = screen.getByTestId('rail-loop-selector')
    expect(within(sel).getByRole('option', { name: 'Implement' })).toBeInTheDocument()
    expect(within(sel).getByRole('option', { name: 'Freestyle' })).toBeInTheDocument()
    // The removed Batch mode is never offered.
    expect(within(sel).queryByRole('option', { name: 'Batch' })).not.toBeInTheDocument()
  })

  it('hides the provider-owned Freestyle built-in when the capability is unavailable', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} freestyleAvailable={false} loopsEnabled={false} />)
    const sel = screen.getByTestId('rail-loop-selector')
    expect(within(sel).queryByRole('option', { name: 'Freestyle' })).not.toBeInTheDocument()
  })

  it('shows the Freestyle built-in when available', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} freestyleAvailable loopsEnabled={false} />)
    expect(within(screen.getByTestId('rail-loop-selector')).getByRole('option', { name: 'Freestyle' })).toBeInTheDocument()
  })

  // A spec-driven graph (references {{spec.*}}) — rail-eligible.
  const specGraph = { nodes: [{ id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 0 }, data: { prompt: 'Implement {{spec.title}}' } }], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } }
  // A standalone graph (no spec/ticket tokens) — NOT rail-eligible.
  const standaloneGraph = { nodes: [{ id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 0 }, data: { prompt: 'Lint the whole repo until clean' } }], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } }

  it('lists published spec-driven custom loops when the Loops section is enabled', async () => {
    api.list.mockResolvedValue([
      { id: 'c1', name: 'My Loop', status: 'published', graph: specGraph, description: null, createdAt: '', updatedAt: '' },
      { id: 'd1', name: 'Draft One', status: 'draft', graph: specGraph, description: null, createdAt: '', updatedAt: '' },
    ])
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'My Loop' })).toBeInTheDocument())
    // Drafts are not selectable.
    expect(screen.queryByRole('option', { name: 'Draft One' })).not.toBeInTheDocument()
  })

  it('does NOT offer standalone (spec-less) loops — those run from the Loops page', async () => {
    api.list.mockResolvedValue([
      { id: 'c1', name: 'Spec Loop', status: 'published', graph: specGraph, description: null, createdAt: '', updatedAt: '' },
      { id: 'c2', name: 'Standalone Loop', status: 'published', graph: standaloneGraph, description: null, createdAt: '', updatedAt: '' },
    ])
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Spec Loop' })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: 'Standalone Loop' })).not.toBeInTheDocument()
  })

  it('does not fetch custom loops when the Loops section is disabled', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled={false} />)
    expect(api.list).not.toHaveBeenCalled()
  })

  it('fires onChange with the chosen loop id', () => {
    const onChange = vi.fn()
    render(<RailLoopSelector value="factory:implement" onChange={onChange} loopsEnabled={false} />)
    fireEvent.change(screen.getByTestId('rail-loop-selector'), { target: { value: 'factory:freestyle' } })
    expect(onChange).toHaveBeenCalledWith('factory:freestyle')
  })
})

describe('RailLoopSelector with editable built-in rows', () => {
  const builtinGraph = { nodes: [{ id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 0 }, data: { prompt: '{{cmd:implement}}' } }], edges: [], config: { maxIterations: 12, timeoutMinutes: 0 } }

  it('never lists a built-in row twice (built-in group only) and shows a renamed built-in by its row name', async () => {
    api.list.mockResolvedValue([
      { id: 'factory:implement', builtinId: 'factory:implement', builtinModified: true, name: 'Team Implement', status: 'published', graph: builtinGraph, description: null, createdAt: '', updatedAt: '' },
      { id: 'factory:sdd-quick-openspec', builtinId: 'factory:sdd-quick-openspec', builtinModified: false, name: 'SDD Quick (OpenSpec)', status: 'published', graph: builtinGraph, description: null, createdAt: '', updatedAt: '' },
      { id: 'c1', name: 'My Loop', status: 'published', graph: builtinGraph, description: null, createdAt: '', updatedAt: '' },
    ])
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Team Implement' })).toBeInTheDocument())
    const sel = screen.getByTestId('rail-loop-selector')
    const values = within(sel).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(values.filter((value) => value === 'factory:implement')).toHaveLength(1)
    expect(values.filter((value) => value === 'factory:sdd-quick-openspec')).toHaveLength(1)
    expect(within(sel).getByRole('option', { name: 'My Loop' })).toBeInTheDocument()
    expect(within(sel).queryByRole('option', { name: 'Implement' })).not.toBeInTheDocument()
  })
})
