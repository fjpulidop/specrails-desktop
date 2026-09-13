import { describe, expect, it } from 'vitest'
import { render, screen, within } from '../../../test-utils'
import { AgentRuntimeMetrics } from '../AgentRuntimeMetrics'
import type { EfficiencyTotals } from '../../../lib/runtime-efficiency'

const total: EfficiencyTotals = { attempts: 2, measuredAttempts: 2, durationMs: 12000, agentDurationMs: 8000, providerCalls: 3, toolCalls: 7, inputTokens: 100, outputTokens: 10, costUsd: null, uncachedInputTokens: null, cacheReadInputTokens: 80, cacheWriteInputTokens: null }
describe('AgentRuntimeMetrics', () => {
  it('displays reported measurements, failed/repeated attempts and unknown billing distinctly', () => {
    render(<AgentRuntimeMetrics metrics={{ schemaVersion: 1, total, phases: [{ ...total, stepId: 'developer', providers: ['local'], models: ['model'] }] }} />)
    expect(screen.getByText('Usage and time')).toBeInTheDocument()
    expect(screen.getByText('Reported cost', { selector: 'dt' }).nextElementSibling).toHaveTextContent('Unavailable')
    expect(screen.getByText('Cache reads').nextElementSibling).toHaveTextContent('80')
    expect(screen.getByText('Agent time').nextElementSibling).toHaveTextContent('8s')
    const row = screen.getByText('local · model').closest('tr')!
    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(within(row).getByText('3')).toBeInTheDocument()
  })
  it('explains partial measurements and preserves genuine zero cost', () => {
    render(<AgentRuntimeMetrics metrics={{ schemaVersion: 1, total: { ...total, measuredAttempts: 0, providerCalls: null, agentDurationMs: null, costUsd: 0 }, phases: [] }} />)
    expect(screen.getByText('Some attempts have no detailed measurements.')).toBeInTheDocument()
    expect(screen.getByText('Reported cost', { selector: 'dt' }).nextElementSibling).toHaveTextContent('$0.00')
    expect(screen.getByText('Agent time').nextElementSibling).toHaveTextContent('Unavailable')
  })
})
