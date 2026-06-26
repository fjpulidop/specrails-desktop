import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RailLoopSelector } from '../RailLoopSelector'
import { loopsApi } from '../../../lib/loops-api'

vi.mock('../../../lib/loops-api', () => ({
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
    expect(within(sel).getByRole('option', { name: 'Batch' })).toBeInTheDocument()
  })

  it('hides the Claude-only Ultracode built-in when ultracode is unavailable', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} ultracodeAvailable={false} loopsEnabled={false} />)
    const sel = screen.getByTestId('rail-loop-selector')
    expect(within(sel).queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()
  })

  it('shows the Ultracode built-in when available', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} ultracodeAvailable loopsEnabled={false} />)
    expect(within(screen.getByTestId('rail-loop-selector')).getByRole('option', { name: 'Ultra' })).toBeInTheDocument()
  })

  it('lists published custom loops when the Loops section is enabled', async () => {
    api.list.mockResolvedValue([
      { id: 'c1', name: 'My Loop', status: 'published', graph: { nodes: [], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } }, description: null, createdAt: '', updatedAt: '' },
      { id: 'd1', name: 'Draft One', status: 'draft', graph: { nodes: [], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } }, description: null, createdAt: '', updatedAt: '' },
    ])
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled />)
    await waitFor(() => expect(screen.getByRole('option', { name: 'My Loop' })).toBeInTheDocument())
    // Drafts are not selectable.
    expect(screen.queryByRole('option', { name: 'Draft One' })).not.toBeInTheDocument()
  })

  it('does not fetch custom loops when the Loops section is disabled', () => {
    render(<RailLoopSelector value={null} onChange={() => {}} loopsEnabled={false} />)
    expect(api.list).not.toHaveBeenCalled()
  })

  it('fires onChange with the chosen loop id', () => {
    const onChange = vi.fn()
    render(<RailLoopSelector value="factory:implement" onChange={onChange} loopsEnabled={false} />)
    fireEvent.change(screen.getByTestId('rail-loop-selector'), { target: { value: 'factory:batch' } })
    expect(onChange).toHaveBeenCalledWith('factory:batch')
  })
})
