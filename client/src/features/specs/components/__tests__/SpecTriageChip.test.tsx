import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { SpecTriageChip } from '../SpecTriageChip'
import type { LocalTicket } from '../../../../types'

const ticket = (over: Partial<LocalTicket> = {}): LocalTicket => ({
  id: 7, title: 'Spec', description: '', status: 'todo', priority: null, labels: [], assignee: null, prerequisites: [],
  metadata: {}, created_at: '', updated_at: '', created_by: 'u', source: 'manual', ...over,
})
const ready = {
  status: 'ready', size: 'M', filesLikely: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], publicInterfaces: true, dataModel: false, securitySurface: true,
  recommendedLoop: 'factory:implement', recommendedMode: 'flow', rationale: 'Touches the API and auth', confidence: 'medium',
  inputsHash: 'sha256:h', model: 'haiku', costUsd: 0.0123, computedAt: 't',
} as const

describe('SpecTriageChip', () => {
  it('shows size, recommended loop and confidence', () => {
    render(<SpecTriageChip ticket={ticket({ metadata: { triage: ready } })} />)
    expect(screen.getByTestId('triage-chip-7')).toHaveTextContent('M·Implement·medium')
  })

  it('opens a tooltip with rationale, flags, files and Recalculate', async () => {
    const onRecalculate = vi.fn(async () => ready)
    const onCardClick = vi.fn()
    render(<div onClick={onCardClick}><SpecTriageChip ticket={ticket({ metadata: { triage: ready } })} onRecalculate={onRecalculate} /></div>)
    fireEvent.focus(screen.getByTestId('triage-chip-7'))
    await waitFor(() => expect(screen.getAllByText('Touches the API and auth').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Public API').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Security').length).toBeGreaterThan(0)
    // A legacy record's mode is ignored: Flow and Implement never compete.
    expect(screen.queryByText('Flow suggested')).toBeNull()
    expect(screen.queryByText(/\bFlow\b/)).toBeNull()
    expect(screen.getAllByText('+1 more file').length).toBeGreaterThan(0)
    expect(screen.getAllByText('haiku · $0.01').length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByTestId('triage-recalculate-7')[0])
    await waitFor(() => expect(onRecalculate).toHaveBeenCalledWith(7))
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it('shows an unavailable chip without inventing a recommendation', async () => {
    render(<SpecTriageChip ticket={ticket({ metadata: { triage: { status: 'unavailable', reason: 'provider_not_detected:claude', inputsHash: 'h', computedAt: 't' } } })} />)
    expect(screen.getByTestId('triage-chip-7')).toHaveTextContent('Triage n/a')
    expect(screen.queryByText('Implement')).not.toBeInTheDocument()
  })

  it('offers a ghost Triage action for an untriaged todo spec, nothing for running or epic specs', async () => {
    const onRecalculate = vi.fn(async () => ready)
    const { rerender } = render(<SpecTriageChip ticket={ticket()} onRecalculate={onRecalculate} />)
    fireEvent.click(screen.getByTestId('triage-compute-7'))
    await waitFor(() => expect(onRecalculate).toHaveBeenCalledWith(7))
    rerender(<SpecTriageChip ticket={ticket({ status: 'in_progress' })} />)
    expect(screen.queryByTestId('triage-compute-7')).not.toBeInTheDocument()
    rerender(<SpecTriageChip ticket={ticket({ is_epic: true, metadata: { triage: ready } })} />)
    expect(screen.queryByTestId('triage-chip-7')).not.toBeInTheDocument()
  })
})
