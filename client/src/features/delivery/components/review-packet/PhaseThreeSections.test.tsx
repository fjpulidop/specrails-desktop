import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RequirementsDemonstrated } from './RequirementsDemonstrated'
import { PacketBaseline } from './PacketBaseline'
import { NeedsHumanEyes } from './NeedsHumanEyes'
import type { PacketBaseline as Baseline, PacketRequirementsDemonstrated } from '../../../../types'

const section = (over: Partial<PacketRequirementsDemonstrated> = {}): PacketRequirementsDemonstrated => ({
  demonstrated: 2, total: 3, touched: 1, touchedDemonstrated: 0, withoutReceipt: false,
  demonstratedList: [{ ticketId: 1, id: 'search/a', name: 'A', tests: [{ file: 'src/a.test.ts', line: 4 }] }, { ticketId: 1, id: 'search/b', name: 'B', tests: [] }],
  undemonstratedList: [{ ticketId: 1, id: 'search/c', name: 'C', reason: 'no-test', touched: true }],
  untaggedList: [{ ticketId: 1, tag: 'search/old', file: 'src/old.test.ts', line: 1 }],
  ...over,
})

describe('RequirementsDemonstrated', () => {
  it('lists touched gaps first, demonstrated tests and untagged tags', () => {
    render(<RequirementsDemonstrated section={section()} multiTicket={false} />)
    expect(screen.getByTestId('packet-requirements-touched')).toBeTruthy()
    expect(screen.getByTestId('packet-requirements-undemonstrated').textContent).toContain('search/c')
    expect(screen.getByText('src/a.test.ts:4')).toBeTruthy()
    expect(screen.getByTestId('packet-requirements-untagged')).toBeTruthy()
  })

  it('collapses long lists and expands on demand', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ticketId: 2, id: `cap/r${i}`, name: `R${i}`, tests: [] }))
    render(<RequirementsDemonstrated section={section({ demonstratedList: many, undemonstratedList: [], untaggedList: [], touched: 0, withoutReceipt: true })} multiTicket />)
    expect(screen.getByTestId('packet-requirements-demonstrated').querySelectorAll('li')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('packet-requirements-demonstrated').querySelectorAll('li')).toHaveLength(12)
    expect(screen.queryByTestId('packet-requirements-touched')).toBeNull()
  })
})

const baseline = (over: Partial<Baseline> = {}): Baseline => ({
  ticketId: 1, status: 'passed', change: 'c', recordedAt: null, uncovered: ['src/search.ts'], covered: 0, tests: ['src/search.char.test.ts'],
  receiptId: 'r', reason: null, capabilities: [{ capability: 'search', requirements: 2, demonstrated: 2 }], cost: { invocations: 3, costUsd: 0.42, inputTokens: null, outputTokens: null },
  ...over,
})

describe('PacketBaseline', () => {
  it('shows the module, the as-built spec and the baseline cost apart', () => {
    render(<PacketBaseline entries={[baseline()]} multiTicket={false} />)
    expect(screen.getByTestId('packet-baseline-passed')).toBeTruthy()
    expect(screen.getByText('src/search.ts')).toBeTruthy()
    expect(screen.getByTestId('packet-baseline-cost').textContent).toContain('$0.42')
  })

  it('makes a blocked baseline and an unknown cost explicit', () => {
    render(<PacketBaseline entries={[baseline({ status: 'failed', reason: 'search.char.test.ts failed on base', cost: null })]} multiTicket />)
    expect(screen.getByTestId('packet-baseline-reason').textContent).toContain('failed on base')
    expect(screen.getByTestId('packet-baseline-cost').textContent).not.toContain('$')
  })
})

describe('NeedsHumanEyes', () => {
  it('lists the human-only rules with their source', () => {
    render(<NeedsHumanEyes rules={[{ text: 'Copy reviewed by design', source: 'AGENTS.md:9' }, { text: 'No dark patterns', source: null }]} />)
    expect(screen.getByTestId('packet-human-eyes').querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByText('AGENTS.md:9')).toBeTruthy()
  })
})
