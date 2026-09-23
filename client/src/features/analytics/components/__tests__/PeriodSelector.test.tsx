import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../../../test-utils'
import React from 'react'

// PeriodSelector has no recharts dependency — no mock needed

import { PeriodSelector } from '../PeriodSelector'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const noop = vi.fn()

// ─── Render without crash ──────────────────────────────────────────────────────

describe('PeriodSelector — render', () => {
  it('renders without crashing', () => {
    render(<PeriodSelector period="7d" from="" to="" onChange={noop} />)
  })

  it('renders all 5 preset buttons', () => {
    render(<PeriodSelector period="7d" from="" to="" onChange={noop} />)
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument()
  })
})

// ─── Active button styling ─────────────────────────────────────────────────────

describe('PeriodSelector — active button class', () => {
  it('applies active class to the current period button (7d)', () => {
    render(<PeriodSelector period="7d" from="" to="" onChange={noop} />)
    const btn = screen.getByRole('button', { name: '7d' })
    expect(btn.className).toMatch(/bg-primary/)
  })

  it('applies active class to the current period button (30d)', () => {
    render(<PeriodSelector period="30d" from="" to="" onChange={noop} />)
    const btn = screen.getByRole('button', { name: '30d' })
    expect(btn.className).toMatch(/bg-primary/)
  })

  it('applies active class to the "All" button when period is "all"', () => {
    render(<PeriodSelector period="all" from="" to="" onChange={noop} />)
    const btn = screen.getByRole('button', { name: 'All' })
    expect(btn.className).toMatch(/bg-primary/)
  })

  it('applies active class to "Custom" button when period is "custom"', () => {
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={noop} />)
    const btn = screen.getByRole('button', { name: 'Custom' })
    expect(btn.className).toMatch(/bg-primary/)
  })

  it('does not apply active class to inactive buttons', () => {
    render(<PeriodSelector period="7d" from="" to="" onChange={noop} />)
    const inactiveBtn = screen.getByRole('button', { name: '30d' })
    expect(inactiveBtn.className).not.toMatch(/bg-primary/)
  })
})

// ─── Preset click handlers ─────────────────────────────────────────────────────

describe('PeriodSelector — preset click calls onChange', () => {
  it('calls onChange("7d") when "7d" button is clicked', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="30d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    expect(onChange).toHaveBeenCalledWith('7d')
  })

  it('calls onChange("30d") when "30d" button is clicked', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    expect(onChange).toHaveBeenCalledWith('30d')
  })

  it('calls onChange("90d") when "90d" button is clicked', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    expect(onChange).toHaveBeenCalledWith('90d')
  })

  it('calls onChange("all") when "All" button is clicked', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('calls onChange("custom", from, to) when "Custom" button is clicked', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    expect(onChange).toHaveBeenCalledWith('custom', '2024-01-01', '2024-01-31')
  })

  it('calls onChange with existing from/to when Custom clicked with empty strings', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    expect(onChange).toHaveBeenCalledWith('custom', '', '')
  })

  it('onChange is called exactly once per button click', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="7d" from="" to="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

// ─── Custom date inputs visibility ────────────────────────────────────────────

describe('PeriodSelector — custom date inputs', () => {
  it('shows date inputs when period is "custom"', () => {
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={noop} />)
    expect(screen.getByLabelText('Start date')).toBeInTheDocument()
    expect(screen.getByLabelText('End date')).toBeInTheDocument()
  })

  it('does not show date inputs when period is "7d"', () => {
    render(<PeriodSelector period="7d" from="" to="" onChange={noop} />)
    expect(screen.queryByLabelText('Start date')).toBeNull()
    expect(screen.queryByLabelText('End date')).toBeNull()
  })

  it('does not show date inputs when period is "30d"', () => {
    render(<PeriodSelector period="30d" from="" to="" onChange={noop} />)
    expect(screen.queryByLabelText('Start date')).toBeNull()
    expect(screen.queryByLabelText('End date')).toBeNull()
  })

  it('does not show date inputs when period is "90d"', () => {
    render(<PeriodSelector period="90d" from="" to="" onChange={noop} />)
    expect(screen.queryByLabelText('Start date')).toBeNull()
  })

  it('does not show date inputs when period is "all"', () => {
    render(<PeriodSelector period="all" from="" to="" onChange={noop} />)
    expect(screen.queryByLabelText('Start date')).toBeNull()
  })

  it('shows "to" separator label when period is custom', () => {
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={noop} />)
    expect(screen.getByText('to')).toBeInTheDocument()
  })

  it('populates start date input with from value', () => {
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={noop} />)
    const startInput = screen.getByLabelText('Start date') as HTMLInputElement
    expect(startInput.value).toBe('2024-01-01')
  })

  it('populates end date input with to value', () => {
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={noop} />)
    const endInput = screen.getByLabelText('End date') as HTMLInputElement
    expect(endInput.value).toBe('2024-01-31')
  })
})

// ─── Date change handlers ─────────────────────────────────────────────────────

describe('PeriodSelector — date change handlers', () => {
  it('calls onChange("custom", newFrom, to) when start date changes', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    const startInput = screen.getByLabelText('Start date')
    fireEvent.change(startInput, { target: { value: '2024-01-05' } })
    expect(onChange).toHaveBeenCalledWith('custom', '2024-01-05', '2024-01-31')
  })

  it('calls onChange("custom", from, newTo) when end date changes', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    const endInput = screen.getByLabelText('End date')
    fireEvent.change(endInput, { target: { value: '2024-02-28' } })
    expect(onChange).toHaveBeenCalledWith('custom', '2024-01-01', '2024-02-28')
  })

  it('calls onChange when start date cleared to empty string', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    const startInput = screen.getByLabelText('Start date')
    fireEvent.change(startInput, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('custom', '', '2024-01-31')
  })

  it('calls onChange when end date cleared to empty string', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    const endInput = screen.getByLabelText('End date')
    fireEvent.change(endInput, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('custom', '2024-01-01', '')
  })

  it('calls onChange exactly once per date change event', () => {
    const onChange = vi.fn()
    render(<PeriodSelector period="custom" from="2024-01-01" to="2024-01-31" onChange={onChange} />)
    const startInput = screen.getByLabelText('Start date')
    fireEvent.change(startInput, { target: { value: '2024-03-01' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
