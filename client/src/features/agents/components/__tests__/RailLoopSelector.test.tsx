import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RailLoopSelector } from '../RailLoopSelector'
import { loopsApi } from '../../../loops/lib/loops-api'

vi.mock('../../../loops/lib/loops-api', () => ({
  loopsApi: { list: vi.fn() },
}))
const api = loopsApi as unknown as { list: ReturnType<typeof vi.fn> }
const openSelect = (trigger: HTMLElement) =>
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue([])
})

describe('RailLoopSelector (unified rail Loop picker)', () => {
  it('always offers Implement, the only built-in loop', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled={false} />)
    const sel = screen.getByTestId('rail-loop-selector')
    // No pick yet: the trigger shows the placeholder, which is not a selectable option.
    expect(sel).toHaveTextContent('Pick a loop')
    expect(sel).toHaveAttribute('data-placeholder')
    openSelect(sel)
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'Implement' })).toBeInTheDocument()
    // Freestyle, SDD Quick and the removed Batch mode are never offered by the app.
    for (const name of ['Freestyle', 'SDD Quick (OpenSpec)', 'Batch']) expect(within(listbox).queryByRole('option', { name })).not.toBeInTheDocument()
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['Implement'])
    expect(within(listbox).getByText('Built-in')).toBeInTheDocument()
  })

  it('says in one line what the picked loop does', () => {
    render(<RailLoopSelector value="factory:implement" onChange={() => {}} loopsEnabled={false} />)
    expect(screen.getByTestId('rail-loop-description')).toHaveTextContent('Plans, builds and reviews each spec')
  })

  it('lists a Freestyle copy the user added from the gallery under the custom loops, like any other loop', async () => {
    api.list.mockResolvedValue([
      { id: 'u-free', name: 'Freestyle', status: 'published', graph: { nodes: [{ id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 0 }, data: { prompt: '{{cmd:freestyle}}' } }], edges: [], config: { maxIterations: 12, timeoutMinutes: 0 } }, description: null, createdAt: '', updatedAt: '' },
    ])
    const onChange = vi.fn()
    render(<RailLoopSelector value={null} onChange={onChange} loopsEnabled />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    openSelect(screen.getByTestId('rail-loop-selector'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Freestyle' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('option', { name: 'Freestyle' }))
    expect(onChange).toHaveBeenCalledWith('u-free')
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
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    openSelect(screen.getByTestId('rail-loop-selector'))
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
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    openSelect(screen.getByTestId('rail-loop-selector'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Spec Loop' })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: 'Standalone Loop' })).not.toBeInTheDocument()
  })

  it('does not fetch custom loops when the Loops section is disabled', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled={false} />)
    expect(api.list).not.toHaveBeenCalled()
  })

  it('fires onChange with the chosen loop id', () => {
    const onChange = vi.fn()
    render(<RailLoopSelector value={null} onChange={onChange} loopsEnabled={false} />)
    openSelect(screen.getByTestId('rail-loop-selector'))
    fireEvent.click(screen.getByRole('option', { name: 'Implement' }))
    expect(onChange).toHaveBeenCalledWith('factory:implement')
  })
})

describe('RailLoopSelector with editable built-in rows', () => {
  const builtinGraph = { nodes: [{ id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 0 }, data: { prompt: '{{cmd:implement}}' } }], edges: [], config: { maxIterations: 12, timeoutMinutes: 0 } }

  it('never lists a built-in row twice (built-in group only) and shows a renamed built-in by its row name', async () => {
    api.list.mockResolvedValue([
      { id: 'factory:implement', builtinId: 'factory:implement', builtinModified: true, name: 'Team Implement', status: 'published', graph: builtinGraph, description: null, createdAt: '', updatedAt: '' },
      { id: 'c1', name: 'My Loop', status: 'published', graph: builtinGraph, description: null, createdAt: '', updatedAt: '' },
    ])
    const onChange = vi.fn()
    render(<RailLoopSelector value={null} onChange={onChange} loopsEnabled />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    openSelect(screen.getByTestId('rail-loop-selector'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Team Implement' })).toBeInTheDocument())
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(['Team Implement', 'My Loop'])
    expect(within(listbox).queryByRole('option', { name: 'Implement' })).not.toBeInTheDocument()
    fireEvent.click(within(listbox).getByRole('option', { name: 'Team Implement' }))
    expect(onChange).toHaveBeenCalledWith('factory:implement')
  })
})
