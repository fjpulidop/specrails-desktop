import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NonGoalsSection, parseNonGoalLines } from '../NonGoalsSection'

describe('NonGoalsSection', () => {
  it('parses one item per line without list markers or duplicates', () => {
    expect(parseNonGoalLines('- Mobile\r\n\n2. Exports\n* Mobile ')).toEqual(['Mobile', 'Exports'])
  })

  it('shows the list, edits it and reports the cleaned value', () => {
    const onChange = vi.fn()
    render(<NonGoalsSection value={['Mobile']} onChange={onChange} />)
    expect(screen.getByText('Mobile')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Mobile\n- Exports' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith(['Mobile', 'Exports'])
  })

  it('offers to add non-goals when there are none', () => {
    const onChange = vi.fn()
    render(<NonGoalsSection value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'PDF export' } })
    fireEvent.click(screen.getByRole('button'))
    expect(onChange).toHaveBeenCalledWith(['PDF export'])
  })
})
