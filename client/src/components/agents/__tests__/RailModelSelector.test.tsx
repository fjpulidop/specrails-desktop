import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../test-utils'
import { RailModelSelector } from '../RailModelSelector'

describe('RailModelSelector', () => {
  it('renders the three model options and defaults to sonnet', () => {
    render(<RailModelSelector value={null} onChange={vi.fn()} />)
    const select = screen.getByTestId('rail-model-selector') as HTMLSelectElement
    expect(select.value).toBe('sonnet')
    expect(screen.getByText('Claude Haiku')).toBeInTheDocument()
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument()
    expect(screen.getByText('Claude Opus')).toBeInTheDocument()
  })

  it('reflects the selected value', () => {
    render(<RailModelSelector value="opus" onChange={vi.fn()} />)
    expect((screen.getByTestId('rail-model-selector') as HTMLSelectElement).value).toBe('opus')
  })

  it('calls onChange with the chosen model', () => {
    const onChange = vi.fn()
    render(<RailModelSelector value="sonnet" onChange={onChange} />)
    fireEvent.change(screen.getByTestId('rail-model-selector'), { target: { value: 'haiku' } })
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
