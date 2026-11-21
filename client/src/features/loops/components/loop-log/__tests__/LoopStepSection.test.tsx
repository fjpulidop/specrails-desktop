import { describe, it, expect, vi } from 'vitest'
import { render } from '../../../../../test-utils'
import { LoopStepSection } from '../LoopStepSection'
import type { LoopStepSegment, SegmentStatus } from '../loop-log-model'

function seg(end: LoopStepSegment['end']): LoopStepSegment {
  return { key: 's1', meta: { index: 1, kind: 'prompt', title: 'Implement', nodeId: 'ai1' }, lines: [], lastActivity: null, end }
}

function renderSection(status: SegmentStatus, end: LoopStepSegment['end'] = null) {
  return render(
    <LoopStepSection segment={seg(end)} status={status} collapsed filter="" onToggle={vi.fn()} onCopy={vi.fn()} setRef={vi.fn()} />,
  )
}

describe('LoopStepSection run state', () => {
  it('a running step is working: info border and the pulsing info lamp', () => {
    const { container } = renderSection('running')
    const section = container.querySelector('[data-testid="loop-step-section"]')!
    expect(section).toHaveAttribute('data-run-state', 'working')
    expect(section.className).toContain('border-accent-info/40')
    expect(section.className).not.toContain('border-accent-primary')
    expect(section.querySelector('[data-run-state="working"] [data-live-ring]')).toBeInTheDocument()
  })

  it('a failed step shows the destructive failed glyph', () => {
    const { container } = renderSection('failed', { index: 1, nodeId: 'ai1', status: 'failed', exitCode: 2, durationMs: 10 })
    const section = container.querySelector('[data-testid="loop-step-section"]')!
    expect(section).toHaveAttribute('data-run-state', 'failed')
    expect(section.querySelector('span[data-run-state="failed"].text-destructive')).toBeInTheDocument()
  })

  it('a provider-limit failure is blocked (warning), not a destructive failure', () => {
    const { container, getByTestId } = renderSection('failed', { index: 1, nodeId: 'ai1', status: 'failed', exitCode: 1, durationMs: 10, reason: 'provider_limit' })
    const section = container.querySelector('[data-testid="loop-step-section"]')!
    expect(section).toHaveAttribute('data-run-state', 'blocked')
    expect(getByTestId('loop-step-provider-limit').className).toContain('text-accent-warning')
    expect(section.querySelector('span[data-run-state="blocked"].text-accent-warning')).toBeInTheDocument()
    expect(section.querySelector('span[data-run-state="failed"]')).toBeNull()
  })

  it('a stalled step is paused', () => {
    const { container } = renderSection('stalled', { index: 1, nodeId: 'ai1', status: 'stalled', exitCode: null, durationMs: 10, reason: 'idle_timeout', idleMs: 120_000 })
    const section = container.querySelector('[data-testid="loop-step-section"]')!
    expect(section).toHaveAttribute('data-run-state', 'paused')
    expect(section.className).toContain('border-accent-warning/40')
    expect(section.querySelector('span[data-run-state="paused"]')).toBeInTheDocument()
  })

  it('a legacy step without an outcome shows no state glyph', () => {
    const { container } = renderSection('unknown')
    const section = container.querySelector('[data-testid="loop-step-section"]')!
    expect(section.querySelector('span[data-run-state]')).toBeNull()
  })
})
