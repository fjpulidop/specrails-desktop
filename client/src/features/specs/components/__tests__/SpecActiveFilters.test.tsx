import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { SpecActiveFilters, type ActiveFilterChip } from '../SpecActiveFilters'

const chip = (key: string, label: string, onRemove = vi.fn()): ActiveFilterChip => ({ key, label, onRemove })

describe('SpecActiveFilters', () => {
  it('renders one chip per entry and × calls its onRemove', () => {
    const onRemove = vi.fn()
    render(
      <SpecActiveFilters
        chips={[chip('search', 'Search: "paddle"'), chip('label-auth', 'Label: auth', onRemove)]}
        shown={4}
        total={13}
        onClearAll={() => {}}
        onOverflowClick={() => {}}
      />,
    )
    expect(screen.getByText('Search: "paddle"')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Label: auth' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('collapses more than 6 chips into +N, which opens the popover', () => {
    const onOverflowClick = vi.fn()
    const chips = Array.from({ length: 8 }, (_, i) => chip(`label-${i}`, `Label: l${i}`))
    render(<SpecActiveFilters chips={chips} shown={1} total={2} onClearAll={() => {}} onOverflowClick={onOverflowClick} />)
    expect(screen.getAllByTestId(/^specs-filter-chip-remove-/)).toHaveLength(6)
    const overflow = screen.getByTestId('specs-filter-chip-overflow')
    expect(overflow).toHaveTextContent('+2')
    fireEvent.click(overflow)
    expect(onOverflowClick).toHaveBeenCalled()
  })

  it('shows "x of y" and Clear all works', () => {
    const onClearAll = vi.fn()
    render(<SpecActiveFilters chips={[chip('epic', 'Epic: Auth')]} shown={4} total={13} onClearAll={onClearAll} onOverflowClick={() => {}} />)
    expect(screen.getByTestId('specs-result-count')).toHaveTextContent('4 of 13')
    fireEvent.click(screen.getByTestId('specs-active-filters-clear'))
    expect(onClearAll).toHaveBeenCalled()
  })
})
