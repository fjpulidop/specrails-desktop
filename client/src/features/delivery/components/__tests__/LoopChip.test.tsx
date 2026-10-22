import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoopChip, builtInLoopKey } from '../LoopChip'
import { coerceRailPrStateSnapshot } from '../../lib/pr-delivery'
import { coercePrDecisionEnvelope } from '../../../missions/lib/agent-api'

describe('LoopChip', () => {
  it.each([
    ['factory:implement', 'Implement'],
    ['factory:sdd-quick-openspec', 'SDD Quick'],
    ['factory:revision', 'SDD Quick'],
    ['factory:freestyle', 'Freestyle'],
    ['factory:flow-spec', 'Flow → Spec'],
  ])('built-in %s → localized name with an icon', (loopId, label) => {
    render(<LoopChip loopId={loopId} loopName="whatever the row stored" />)
    const chip = screen.getByTestId('loop-chip')
    expect(chip).toHaveTextContent(label)
    expect(chip).toHaveAttribute('aria-label', `Loop: ${label}`)
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(builtInLoopKey(loopId)).not.toBeNull()
  })

  it('a custom loop shows its own name (truncated, never widens the row)', () => {
    render(<LoopChip loopId="custom:nightly-hardening" loopName="Nightly hardening of the payment flows" />)
    const chip = screen.getByTestId('loop-chip')
    expect(chip).toHaveTextContent('Nightly hardening of the payment flows')
    expect(chip.className).toContain('max-w-[180px]')
    expect(chip.querySelector('.truncate')).not.toBeNull()
    expect(builtInLoopKey('custom:nightly-hardening')).toBeNull()
  })

  it('an unknown loop (no id, no name) falls back to "Loop"', () => {
    render(<LoopChip loopId={null} loopName="  " />)
    expect(screen.getByTestId('loop-chip')).toHaveTextContent('Loop')
  })

  it('rides the rail snapshot and the mission card envelope; absent on older payloads', () => {
    const base = { prDeliveryId: 'd1', railIndex: 0, decision: 'on_review', ticketIds: [8], baseBranch: 'main', projectId: 'p1', kind: 'pr_decision' }
    expect(coerceRailPrStateSnapshot({ ...base, loopId: 'factory:flow-spec', loopName: 'Flow → Spec' })).toMatchObject({ loopId: 'factory:flow-spec', loopName: 'Flow → Spec' })
    expect(coercePrDecisionEnvelope({ ...base, loopId: 'factory:implement', loopName: 'Implement' })).toMatchObject({ loopId: 'factory:implement', loopName: 'Implement' })
    expect(coerceRailPrStateSnapshot(base)).not.toHaveProperty('loopId')
  })
})
