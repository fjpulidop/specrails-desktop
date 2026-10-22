import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopRiskLine } from '../TopRiskLine'
import { coerceRailPrStateSnapshot, coerceRiskSummary } from '../../lib/pr-delivery'
import { coercePrDecisionEnvelope } from '../../../missions/lib/agent-api'

const summary = {
  highCount: 1, mediumCount: 2, lowCount: 0, diagnostic: false,
  top: { severity: 'high' as const, area: 'data', whatToLookAt: 'Migration drops a default', ref: 'server/db/migrations.ts:1600' },
}

describe('TopRiskLine', () => {
  it('shows the severity chip, the top risk and how many more there are', () => {
    render(<TopRiskLine summary={summary} />)
    expect(screen.getByTestId('top-risk-line')).toHaveTextContent('Top risk')
    expect(screen.getByTestId('brief-severity')).toHaveTextContent('High')
    expect(screen.getByText('Migration drops a default')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.getByTestId('top-risk-line')).toHaveAttribute('title', 'server/db/migrations.ts:1600')
  })

  it('renders nothing without a listed risk', () => {
    const { container } = render(<TopRiskLine summary={{ ...summary, top: null }} />)
    expect(container).toBeEmptyDOMElement()
    expect(render(<TopRiskLine summary={undefined} />).container).toBeEmptyDOMElement()
  })
})

describe('risk summary wire coercion', () => {
  it('reads a well-formed summary and rejects malformed tops', () => {
    expect(coerceRiskSummary(summary)).toEqual(summary)
    expect(coerceRiskSummary({ highCount: -1, top: { severity: 'critical', whatToLookAt: 'x' } })).toEqual({ highCount: 0, mediumCount: 0, lowCount: 0, top: null, diagnostic: false })
    expect(coerceRiskSummary(null)).toBeNull()
  })

  it('travels on snapshots and mission card envelopes only when present', () => {
    const base = { prDeliveryId: 'd1', railIndex: 0, decision: 'on_review' }
    expect(coerceRailPrStateSnapshot({ ...base, riskSummary: summary })?.riskSummary).toEqual(summary)
    expect(coerceRailPrStateSnapshot(base)).not.toHaveProperty('riskSummary')
    const envelope = { kind: 'pr_decision', projectId: 'p1', baseBranch: 'main', ...base }
    expect(coercePrDecisionEnvelope({ ...envelope, riskSummary: summary })?.riskSummary).toEqual(summary)
    expect(coercePrDecisionEnvelope(envelope)).not.toHaveProperty('riskSummary')
  })
})
