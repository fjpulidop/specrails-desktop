import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { RailModelSelector } from '../RailModelSelector'

const openSelect = (trigger: HTMLElement) =>
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('RailModelSelector', () => {
  it('renders the three model options and defaults to sonnet', () => {
    render(<RailModelSelector value={null} onChange={vi.fn()} />)
    const trigger = screen.getByTestId('rail-model-selector')
    expect(trigger).toHaveTextContent('Claude Sonnet 5.5')
    openSelect(trigger)
    expect(screen.getByRole('option', { name: 'Claude Haiku 5.5' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Claude Sonnet 5.5' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('option', { name: 'Claude Opus 5.5' })).toBeInTheDocument()
  })

  it('reflects the selected value', () => {
    render(<RailModelSelector value="opus" onChange={vi.fn()} />)
    expect(screen.getByTestId('rail-model-selector')).toHaveTextContent('Claude Opus 5.5')
  })

  it('calls onChange with the chosen model', () => {
    const onChange = vi.fn()
    render(<RailModelSelector value="sonnet" onChange={onChange} />)
    openSelect(screen.getByTestId('rail-model-selector'))
    fireEvent.click(screen.getByRole('option', { name: 'Claude Haiku 5.5' }))
    expect(onChange).toHaveBeenCalledWith('haiku')
  })

  it('uses Kimi models and defaults to K3 on a Kimi Freestyle rail', () => {
    render(<RailModelSelector provider="kimi" value={null} onChange={vi.fn()} />)
    const input = screen.getByTestId('rail-model-selector') as HTMLInputElement
    expect(input.value).toBe('k3')
    const datalist = document.getElementById(input.getAttribute('list') ?? '')
    expect(Array.from(datalist?.querySelectorAll('option') ?? [], (option) => option.value))
      .toEqual(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])
  })

  it('commits a safe Kimi alias exactly and rejects flag-like input', () => {
    const onChange = vi.fn()
    render(
      <RailModelSelector
        provider="kimi"
        value="moonshot-team/private-coder:v1"
        onChange={onChange}
      />,
    )
    const input = screen.getByTestId('rail-model-selector')
    expect(input).toHaveValue('moonshot-team/private-coder:v1')

    fireEvent.change(input, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('Moonshot-Team/Private_Coder:v2')

    fireEvent.change(input, { target: { value: '--yolo' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('moonshot-team/private-coder:v1')
  })
})
