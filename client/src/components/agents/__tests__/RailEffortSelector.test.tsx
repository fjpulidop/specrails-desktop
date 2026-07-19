import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { RailEffortSelector } from '../RailEffortSelector'

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
    const select = screen.getByTestId('rail-effort-selector') as HTMLSelectElement
    expect(select.value).toBe('high')
    expect(Array.from(select.options, (option) => option.value)).toEqual(['low', 'high', 'max'])
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
    fireEvent.change(screen.getByTestId('rail-effort-selector'), {
      target: { value: 'max' },
    })
    expect(onChange).toHaveBeenCalledWith('max')
  })
})
