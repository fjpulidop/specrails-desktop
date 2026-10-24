import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '../../../../test-utils'
import { SpecStatusFilter } from '../SpecStatusFilter'

const counts = { draft: 0, todo: 2, in_progress: 1, on_review: 0, done: 3, cancelled: 4 }

describe('SpecStatusFilter', () => {
  it('is a labelled radiogroup with one checked radio', () => {
    render(<SpecStatusFilter value="todo" onChange={() => {}} counts={counts} />)
    const group = screen.getByRole('radiogroup', { name: 'Filter by status' })
    expect(within(group).getAllByRole('radio')).toHaveLength(8)
    expect(screen.getByTestId('specs-status-chip-todo')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('specs-status-chip-todo')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('specs-status-chip-done')).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys select the next/previous segment (wrapping) and Home/End jump', () => {
    const onChange = vi.fn()
    render(<SpecStatusFilter value="todo" onChange={onChange} counts={counts} />)
    const todo = screen.getByTestId('specs-status-chip-todo')
    fireEvent.keyDown(todo, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('in_progress')
    fireEvent.keyDown(todo, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('draft')
    fireEvent.keyDown(todo, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('cancelled')
    fireEvent.keyDown(todo, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('active')
    // Wraps from the first segment to the last.
    fireEvent.keyDown(screen.getByTestId('specs-status-chip-active'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('cancelled')
  })

  it('keeps zero counts visible, with no opacity tricks', () => {
    render(<SpecStatusFilter value="active" onChange={() => {}} counts={counts} />)
    const draft = screen.getByTestId('specs-status-chip-draft')
    expect(screen.getByTestId('specs-status-count-draft')).toHaveTextContent('0')
    expect(draft.className).not.toMatch(/opacity-/)
    expect(screen.getByTestId('specs-status-count-draft').className).not.toMatch(/opacity-/)
  })

  it('does not announce the status twice (the dot is decorative)', () => {
    render(<SpecStatusFilter value="active" onChange={() => {}} counts={counts} />)
    expect(screen.getByRole('radio', { name: /^Done\s*3$/ })).toBeInTheDocument()
  })

  it('full tier renders every segment', () => {
    render(<SpecStatusFilter value="active" onChange={() => {}} counts={counts} forceTier="full" />)
    expect(screen.getByTestId('specs-status-filter')).toHaveAttribute('data-tier', 'full')
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(screen.queryByTestId('specs-status-more')).toBeNull()
  })

  it('compact tier shows Active, All, Done and a More menu with the rest', () => {
    const onChange = vi.fn()
    render(<SpecStatusFilter value="active" onChange={onChange} counts={counts} forceTier="compact" />)
    expect(screen.getAllByRole('radio').map((r) => r.dataset.value)).toEqual(['active', 'all', 'done'])
    const more = screen.getByTestId('specs-status-more')
    expect(more).toHaveTextContent('More')
    fireEvent.click(more)
    expect(screen.getByTestId('specs-status-option-cancelled')).toHaveTextContent('4')
    expect(screen.queryByTestId('specs-status-option-done')).toBeNull()
    fireEvent.click(screen.getByTestId('specs-status-option-in_progress'))
    expect(onChange).toHaveBeenCalledWith('in_progress')
  })

  it('compact tier renders a menu-held selection as the selected trigger', () => {
    render(<SpecStatusFilter value="cancelled" onChange={() => {}} counts={counts} forceTier="compact" />)
    const more = screen.getByTestId('specs-status-more')
    expect(more).toHaveTextContent('Cancelled')
    expect(more).toHaveAccessibleName('Status: Cancelled. Choose another status')
  })

  it('menu tier shows a single trigger that lists all 8 values once opened', () => {
    render(<SpecStatusFilter value="done" onChange={() => {}} counts={counts} forceTier="menu" />)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    const trigger = screen.getByTestId('specs-status-more')
    expect(trigger).toHaveTextContent('Done')
    fireEvent.click(trigger)
    expect(screen.getAllByTestId(/^specs-status-option-/)).toHaveLength(8)
    expect(screen.getByTestId('specs-status-option-done')).toHaveAttribute('aria-current', 'true')
  })

  it('renders a dash for every count while loading', () => {
    render(<SpecStatusFilter value="active" onChange={() => {}} counts={counts} loading />)
    expect(screen.getByTestId('specs-status-count-all')).toHaveTextContent('–')
    expect(screen.getByTestId('specs-status-count-done')).toHaveTextContent('–')
  })
})
