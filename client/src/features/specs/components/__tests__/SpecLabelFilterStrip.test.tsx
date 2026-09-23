import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { SpecLabelFilterStrip, hashLabelToTone } from '../SpecLabelFilterStrip'
import type { LocalTicket } from '../../../../types'

function ticket(id: number, labels: string[]): LocalTicket {
  return {
    id,
    title: `t${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    labels,
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'tester',
    source: 'manual',
  }
}

describe('SpecLabelFilterStrip', () => {
  it('returns null when no tickets carry labels', () => {
    const { container } = render(
      <SpecLabelFilterStrip tickets={[ticket(1, [])]} active={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('aggregates counts from active tickets only', () => {
    const tickets = [
      ticket(1, ['auth', 'api']),
      ticket(2, ['auth']),
      ticket(3, ['ui']),
    ]
    render(<SpecLabelFilterStrip tickets={tickets} active={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent)
    expect(labels[0]).toContain('auth')
    expect(labels[0]).toContain('2')
    expect(labels[1]).toContain('api')
    expect(labels[2]).toContain('ui')
  })

  it('orders by count desc with alpha tie-break', () => {
    const tickets = [
      ticket(1, ['zeta']),
      ticket(2, ['alpha']),
      ticket(3, ['mango']),
    ]
    render(<SpecLabelFilterStrip tickets={tickets} active={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toHaveTextContent(/^alpha/)
    expect(buttons[1]).toHaveTextContent(/^mango/)
    expect(buttons[2]).toHaveTextContent(/^zeta/)
  })

  it('renders pill text as "label ·N"', () => {
    render(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth']), ticket(2, ['auth'])]}
        active={new Set()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: /^auth/ })
    expect(button.textContent).toMatch(/auth\s*·\s*2/)
  })

  it('hash determinism: same label always maps to same tone', () => {
    const a = hashLabelToTone('auth')
    const b = hashLabelToTone('auth')
    const c = hashLabelToTone('AUTH')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('hash output is one of the six accent tones', () => {
    const allowed = new Set([
      'accent-primary',
      'accent-info',
      'accent-success',
      'accent-secondary',
      'accent-warning',
      'accent-highlight',
    ])
    for (const l of ['auth', 'api', 'ui', 'perf', 'docs', 'infra', 'tests', 'a', 'b', '']) {
      expect(allowed.has(hashLabelToTone(l))).toBe(true)
    }
  })

  it('aria-pressed reflects active set membership', () => {
    render(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth']), ticket(2, ['api'])]}
        active={new Set(['auth'])}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /^auth/, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^api/, pressed: false })).toBeInTheDocument()
  })

  it('clicking a pill calls onToggle once with the label', () => {
    const onToggle = vi.fn()
    render(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth'])]}
        active={new Set()}
        onToggle={onToggle}
        onClear={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^auth/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('auth')
  })

  it('clear chip renders only when active set is non-empty and triggers onClear', () => {
    const onClear = vi.fn()
    const { rerender } = render(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth'])]}
        active={new Set()}
        onToggle={vi.fn()}
        onClear={onClear}
      />,
    )
    expect(screen.queryByTestId('spec-label-filter-clear')).toBeNull()

    rerender(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth']), ticket(2, ['api'])]}
        active={new Set(['auth', 'api'])}
        onToggle={vi.fn()}
        onClear={onClear}
      />,
    )
    const clear = screen.getByTestId('spec-label-filter-clear')
    expect(clear.textContent).toMatch(/2/)
    expect(clear.textContent).toMatch(/clear/)
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('does not emit dracula-* tokens or hex inline styles', () => {
    const { container } = render(
      <SpecLabelFilterStrip
        tickets={[ticket(1, ['auth']), ticket(2, ['api']), ticket(3, ['ui'])]}
        active={new Set(['auth'])}
        onToggle={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const html = container.innerHTML
    expect(html).not.toMatch(/dracula-/)
    expect(html).not.toMatch(/style="[^"]*#[0-9a-fA-F]/)
  })
})
