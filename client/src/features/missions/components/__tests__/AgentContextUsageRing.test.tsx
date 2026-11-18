import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AgentContextUsage } from '../../lib/agent-api'
import { AgentContextUsageRing, contextUsageLevel, formatCompactTokens } from '../AgentContextUsageRing'

const snapshot = (overrides: Partial<AgentContextUsage> = {}): AgentContextUsage => ({
  provider: 'claude', model: 'claude-sonnet-4-5', usedTokens: 18_600, windowTokens: 200_000, percent: 9,
  source: 'response', measuredAt: '2026-11-18T10:00:00.000Z', ...overrides,
})

describe('AgentContextUsageRing', () => {
  it('is hidden without a snapshot, a window or a known usage', () => {
    const { container, rerender } = render(<AgentContextUsageRing usage={null} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<AgentContextUsageRing usage={snapshot({ windowTokens: null, percent: null })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<AgentContextUsageRing usage={snapshot({ usedTokens: null, percent: null, compacted: true })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('labels the ring with the percent and is keyboard focusable', () => {
    render(<AgentContextUsageRing usage={snapshot()} />)
    const ring = screen.getByRole('button', { name: 'Context used: 9%' })
    expect(ring.tagName).toBe('BUTTON')
    expect(ring).toHaveAttribute('data-level', 'normal')
    fireEvent.focus(ring)
    expect(screen.getByTestId('agent-context-usage-popover')).toBeInTheDocument()
  })

  it('switches to warning at 75% and destructive at 90%, clamping only the drawing', () => {
    const { rerender } = render(<AgentContextUsageRing usage={snapshot({ percent: 74 })} />)
    expect(screen.getByTestId('agent-context-usage')).toHaveAttribute('data-level', 'normal')
    rerender(<AgentContextUsageRing usage={snapshot({ percent: 75 })} />)
    expect(screen.getByTestId('agent-context-usage')).toHaveAttribute('data-level', 'warning')
    expect(screen.getByTestId('agent-context-usage')).toHaveClass('text-accent-warning')
    rerender(<AgentContextUsageRing usage={snapshot({ percent: 90 })} />)
    expect(screen.getByTestId('agent-context-usage')).toHaveClass('text-destructive')
    rerender(<AgentContextUsageRing usage={snapshot({ percent: 112 })} />)
    expect(screen.getByRole('button', { name: 'Context used: 112%' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-context-usage-arc').getAttribute('stroke-dashoffset')).toBe('0')
  })

  it('opens the popover with tokens, model, source and no note below the warning threshold', () => {
    render(<AgentContextUsageRing usage={snapshot()} />)
    fireEvent.click(screen.getByTestId('agent-context-usage'))
    const panel = screen.getByTestId('agent-context-usage-panel')
    expect(screen.getByTestId('agent-context-usage-tokens')).toHaveTextContent('18.6k / 200k')
    expect(panel).toHaveTextContent('Context')
    expect(panel).toHaveTextContent('9%')
    expect(panel).toHaveTextContent('claude-sonnet-4-5')
    expect(panel).toHaveTextContent('Measured from the last response')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '9')
    expect(screen.queryByTestId('agent-context-usage-note')).toBeNull()
  })

  it('shows the Codex source and the compaction note when the context is high', () => {
    render(<AgentContextUsageRing usage={snapshot({ provider: 'codex', model: 'gpt-5-codex', usedTokens: 860_000, windowTokens: 1_000_000, percent: 86, source: 'session-file' })} />)
    fireEvent.click(screen.getByTestId('agent-context-usage'))
    expect(screen.getByTestId('agent-context-usage-tokens')).toHaveTextContent('860k / 1M')
    expect(screen.getByTestId('agent-context-usage-panel')).toHaveTextContent('Read from the Codex session')
    expect(screen.getByTestId('agent-context-usage-note')).toHaveTextContent(/compacts the context automatically/)
  })

  it('names Claude Code when the value was read from its session transcript', () => {
    render(<AgentContextUsageRing usage={snapshot({ source: 'session-file' })} />)
    fireEvent.click(screen.getByTestId('agent-context-usage'))
    expect(screen.getByTestId('agent-context-usage-panel')).toHaveTextContent('Read from the Claude Code session')
  })
})

describe('context usage helpers', () => {
  it('formats tokens compactly and maps thresholds', () => {
    expect(formatCompactTokens(950)).toBe('950')
    expect(formatCompactTokens(18_612)).toBe('18.6k')
    expect(formatCompactTokens(200_000)).toBe('200k')
    expect(formatCompactTokens(1_000_000)).toBe('1M')
    expect(formatCompactTokens(1_250_000)).toBe('1.3M')
    expect(contextUsageLevel(10)).toBe('normal')
    expect(contextUsageLevel(80)).toBe('warning')
    expect(contextUsageLevel(95)).toBe('danger')
  })
})
