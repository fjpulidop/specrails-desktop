import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../test-utils'
import { InvocationsTable } from '../InvocationsTable'
import type { InvocationRow } from '../../../types/spending'

function row(overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    id: 'r1', project_id: 'p1', surface: 'job', surface_ref_id: null, ticket_id: null,
    conversation_id: null, model: 'sonnet', status: 'success',
    started_at: '2026-05-06T10:00:00Z', finished_at: null,
    duration_ms: 1000, duration_api_ms: null,
    tokens_in: 10, tokens_out: 5, tokens_cache_read: 0, tokens_cache_create: 0,
    total_cost_usd: 0.1, num_turns: 1, session_id: null,
    created_at: '2026-05-06T10:00:00Z', ticket_title: null,
    ...overrides,
  }
}

describe('InvocationsTable', () => {
  it('shows empty state when no rows', () => {
    render(
      <InvocationsTable rows={[]} loading={false} truncated={false} totalAvailable={0}
        tableFilters={{}} onTableFiltersChange={() => {}} />
    )
    expect(screen.getByText(/No invocations match/i)).toBeInTheDocument()
  })

  it('renders one row per invocation', () => {
    render(
      <InvocationsTable
        rows={[row({ id: 'a' }), row({ id: 'b', surface: 'explore-spec', ticket_id: 7, ticket_title: 'auth' })]}
        loading={false} truncated={false} totalAvailable={2}
        tableFilters={{}} onTableFiltersChange={() => {}}
      />
    )
    expect(screen.getByText(/auth/)).toBeInTheDocument()
  })

  it('applies status filter via select', () => {
    const onChange = vi.fn()
    render(
      <InvocationsTable rows={[row()]} loading={false} truncated={false} totalAvailable={1}
        tableFilters={{}} onTableFiltersChange={onChange} />
    )
    const select = screen.getByLabelText('Status filter') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'failed' } })
    expect(onChange).toHaveBeenCalledWith({ status: 'failed' })
  })

  it('shows truncation note when truncated', () => {
    render(
      <InvocationsTable rows={[row()]} loading={false} truncated totalAvailable={50000}
        tableFilters={{}} onTableFiltersChange={() => {}} />
    )
    expect(screen.getByText(/Showing first 1 of 50,000/)).toBeInTheDocument()
  })

  it('shows truncation note when totalAvailable exceeds shown rows even if truncated flag is false (BUG-ANALYTICS-19)', () => {
    render(
      <InvocationsTable rows={[row({ id: 'a' }), row({ id: 'b' })]} loading={false}
        truncated={false} totalAvailable={150}
        tableFilters={{}} onTableFiltersChange={() => {}} />
    )
    expect(screen.getByText(/Showing first 2 of 150/)).toBeInTheDocument()
  })

  it('does not show a truncation note when all rows are shown', () => {
    render(
      <InvocationsTable rows={[row()]} loading={false} truncated={false} totalAvailable={1}
        tableFilters={{}} onTableFiltersChange={() => {}} />
    )
    expect(screen.queryByText(/Showing first/)).not.toBeInTheDocument()
  })

  it('hides the Provider column for a single-provider (claude) project (BUG-ANALYTICS-11)', () => {
    render(
      <InvocationsTable
        rows={[row({ id: 'a', provider: 'claude' }), row({ id: 'b', provider: null })]}
        loading={false} truncated={false} totalAvailable={2}
        tableFilters={{}} onTableFiltersChange={() => {}}
      />
    )
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    // No "Provider" header column is rendered
    expect(screen.queryByRole('columnheader', { name: /provider/i })).not.toBeInTheDocument()
  })

  it('renders a Provider column with per-row labels in a multi-provider project (BUG-ANALYTICS-11)', () => {
    render(
      <InvocationsTable
        rows={[
          row({ id: 'a', provider: 'claude' }),
          row({ id: 'b', provider: 'codex', total_cost_usd: 0.05, total_cost_usd_estimated: 1 }),
        ]}
        loading={false} truncated={false} totalAvailable={2}
        tableFilters={{}} onTableFiltersChange={() => {}}
      />
    )
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('labels Contract Layer invocations distinctly from the source ticket', () => {
    render(
      <InvocationsTable
        rows={[row({
          id: 'contract-1',
          surface: 'explore-spec',
          surface_ref_id: 'contract-refine:conv-1',
          conversation_id: 'conv-1',
          ticket_id: 48,
          ticket_title: 'Stage select screen',
        })]}
        loading={false}
        truncated={false}
        totalAvailable={1}
        tableFilters={{}}
        onTableFiltersChange={() => {}}
      />
    )

    expect(screen.getByText('Contract Layer')).toBeInTheDocument()
    expect(screen.getByText(/#48/)).toBeInTheDocument()
    expect(screen.getByText(/Contract Layer refinement/)).toBeInTheDocument()
    expect(screen.queryByText(/Stage select screen/)).not.toBeInTheDocument()
  })

  it('does not treat ordinary backfilled Explore rows as Contract Layer', () => {
    render(
      <InvocationsTable
        rows={[row({
          id: 'explore-1',
          surface: 'explore-spec',
          surface_ref_id: 'conv-1',
          conversation_id: 'conv-1',
          ticket_id: 48,
          ticket_title: 'Stage select screen',
        })]}
        loading={false}
        truncated={false}
        totalAvailable={1}
        tableFilters={{}}
        onTableFiltersChange={() => {}}
      />
    )

    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText(/#48 Stage select screen/)).toBeInTheDocument()
    expect(screen.queryByText('Contract Layer')).not.toBeInTheDocument()
  })

  it('labels legacy model-less Contract Layer rows and infers the model from the Explore row', () => {
    render(
      <InvocationsTable
        rows={[
          row({
            id: 'explore-1',
            surface: 'explore-spec',
            surface_ref_id: 'conv-1',
            conversation_id: 'conv-1',
            ticket_id: 48,
            ticket_title: 'Stage select screen',
            model: 'opus',
          }),
          row({
            id: 'legacy-contract-1',
            surface: 'explore-spec',
            surface_ref_id: 'conv-1',
            conversation_id: 'conv-1',
            ticket_id: 48,
            ticket_title: 'Stage select screen',
            model: null,
          }),
        ]}
        loading={false}
        truncated={false}
        totalAvailable={2}
        tableFilters={{}}
        onTableFiltersChange={() => {}}
      />
    )

    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('Contract Layer')).toBeInTheDocument()
    expect(screen.getByText(/#48 Stage select screen/)).toBeInTheDocument()
    expect(screen.getByText(/Contract Layer refinement/)).toBeInTheDocument()
    expect(screen.getAllByText('opus')).toHaveLength(2)
    expect(screen.getByText('inferred')).toBeInTheDocument()
  })
})
