import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../../test-utils'
import { RailEffortSelector } from '../RailEffortSelector'

const openSelect = (trigger: HTMLElement) =>
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('RailEffortSelector', () => {
  it('renders Kimi low/high/max and replaces an invalid inherited medium', () => {
    render(
      <RailEffortSelector
        provider="kimi"
        model="k3"
        value="medium"
        onChange={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('rail-effort-selector')
    expect(trigger).toHaveTextContent('high')
    openSelect(trigger)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['low', 'high', 'max'])
  })

  it('emits Kimi max unchanged', () => {
    const onChange = vi.fn()
    render(
      <RailEffortSelector
        provider="kimi"
        model="kimi-code/k3"
        value="low"
        onChange={onChange}
      />,
    )
    openSelect(screen.getByTestId('rail-effort-selector'))
    fireEvent.click(screen.getByRole('option', { name: 'max' }))
    expect(onChange).toHaveBeenCalledWith('max')
  })
})
