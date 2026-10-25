import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '../../../test-utils'
import { useState } from 'react'
import { DateInput } from '../date-input'

function Harness() {
  const [value, setValue] = useState('')
  return <DateInput aria-label="From" value={value} onChange={(e) => setValue(e.target.value)} />
}

describe('DateInput', () => {
  it('is a native date field in the shared control skin, tagged with the UI language', () => {
    render(<Harness />)
    const input = screen.getByLabelText('From')
    expect(input).toHaveAttribute('type', 'date')
    expect(input).toHaveAttribute('lang', 'en')
    expect(input).toHaveClass('h-7', 'rounded-control', 'border-border', 'bg-input', 'text-caption')
  })

  it('keeps the local YYYY-MM-DD value contract', () => {
    render(<Harness />)
    const input = screen.getByLabelText('From') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2026-10-25' } })
    expect(input.value).toBe('2026-10-25')
  })
})
