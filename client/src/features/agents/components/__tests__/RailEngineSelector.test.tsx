import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { render } from '../../../../test-utils'
import { RailEngineSelector } from '../RailEngineSelector'

const openSelect = (trigger: HTMLElement) =>
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('RailEngineSelector', () => {
  it('renders nothing when providers is empty', () => {
    const { container } = render(
      <RailEngineSelector value={null} providers={[]} onChange={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when providers has exactly one entry', () => {
    const { container } = render(
      <RailEngineSelector value={null} providers={['claude']} onChange={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a picker with one option per provider when providers.length > 1', () => {
    render(
      <RailEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    const trigger = screen.getByTestId('rail-engine-selector')
    expect(trigger).toHaveAttribute('role', 'combobox')
    expect(trigger).toHaveAttribute('data-size', 'sm')

    openSelect(trigger)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Claude')
    expect(options[0]).toHaveAttribute('data-state', 'checked')
    expect(options[1]).toHaveTextContent('Codex')
    expect(screen.queryByRole('option', { name: 'Roles' })).not.toBeInTheDocument()
  })

  it('shows the primary provider for a saved historical roles selection', () => {
    const onChange = vi.fn()
    render(<RailEngineSelector value="roles" providers={['claude', 'codex']} onChange={onChange} />)
    const trigger = screen.getByTestId('rail-engine-selector')
    expect(trigger).toHaveTextContent('Claude')
    expect(trigger).toHaveAccessibleName('AI provider for all roles in this launch: architect, developer and reviewer')
    expect(trigger.parentElement).toHaveAttribute('title', 'AI provider for all roles in this launch: architect, developer and reviewer')
    openSelect(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }))
    expect(onChange).toHaveBeenCalledWith('codex')
  })

  it('defaults select value to providers[0] when value is null', () => {
    render(
      <RailEngineSelector
        value={null}
        providers={['codex', 'claude']}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('rail-engine-selector')).toHaveTextContent('Codex')
  })

  it('defaults select value to providers[0] when value is undefined', () => {
    render(
      <RailEngineSelector
        value={undefined}
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('rail-engine-selector')).toHaveTextContent('Claude')
  })

  it('reflects explicit value prop on the select', () => {
    render(
      <RailEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('rail-engine-selector')).toHaveTextContent('Codex')
  })

  it('calls onChange with the new value when the select changes', () => {
    const onChange = vi.fn()
    render(
      <RailEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={onChange}
      />,
    )

    openSelect(screen.getByTestId('rail-engine-selector'))
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('codex')
  })

  it('calls onChange with claude when switching back from codex', () => {
    const onChange = vi.fn()
    render(
      <RailEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={onChange}
      />,
    )

    openSelect(screen.getByTestId('rail-engine-selector'))
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))

    expect(onChange).toHaveBeenCalledWith('claude')
  })

  it('suffixes a local engine id with the local-engine tag and keeps CLI labels bare', () => {
    render(<RailEngineSelector value="lan-box" providers={['claude', 'lan-box']} onChange={vi.fn()} />)
    openSelect(screen.getByTestId('rail-engine-selector'))
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Claude', 'lan-box · Local engine'])
  })
})
