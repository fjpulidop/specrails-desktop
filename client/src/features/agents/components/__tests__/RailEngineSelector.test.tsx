import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { render } from '../../../../test-utils'
import { RailEngineSelector } from '../RailEngineSelector'

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

  it('renders a select with one option per provider when providers.length > 1', () => {
    render(
      <RailEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    const select = screen.getByTestId('rail-engine-selector')
    expect(select.tagName).toBe('SELECT')

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveValue('claude')
    expect(options[0]).toHaveTextContent('Claude')
    expect(options[1]).toHaveValue('codex')
    expect(options[1]).toHaveTextContent('Codex')
    // The hybrid per-role engine always trails the provider list in its own group.
    expect(options[2]).toHaveValue('roles')
    expect(options[2]).toHaveTextContent('Roles')
    expect(options[2].closest('optgroup')).not.toBeNull()
  })

  it('selects the roles sentinel and reports it through onChange', () => {
    const onChange = vi.fn()
    render(<RailEngineSelector value="roles" providers={['claude', 'codex']} onChange={onChange} />)
    const select = screen.getByTestId('rail-engine-selector') as HTMLSelectElement
    expect(select.value).toBe('roles')
    expect(select).toHaveAccessibleName('AI provider for all roles in this launch: architect, developer and reviewer')
    expect(select.parentElement).toHaveAttribute('title', expect.stringContaining('per role'))
    fireEvent.change(select, { target: { value: 'claude' } })
    expect(onChange).toHaveBeenCalledWith('claude')
    fireEvent.change(select, { target: { value: 'roles' } })
    expect(onChange).toHaveBeenCalledWith('roles')
  })

  it('defaults select value to providers[0] when value is null', () => {
    render(
      <RailEngineSelector
        value={null}
        providers={['codex', 'claude']}
        onChange={vi.fn()}
      />,
    )

    const select = screen.getByTestId('rail-engine-selector') as HTMLSelectElement
    expect(select.value).toBe('codex')
  })

  it('defaults select value to providers[0] when value is undefined', () => {
    render(
      <RailEngineSelector
        value={undefined}
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    const select = screen.getByTestId('rail-engine-selector') as HTMLSelectElement
    expect(select.value).toBe('claude')
  })

  it('reflects explicit value prop on the select', () => {
    render(
      <RailEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )

    const select = screen.getByTestId('rail-engine-selector') as HTMLSelectElement
    expect(select.value).toBe('codex')
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

    const select = screen.getByTestId('rail-engine-selector')
    fireEvent.change(select, { target: { value: 'codex' } })

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

    const select = screen.getByTestId('rail-engine-selector')
    fireEvent.change(select, { target: { value: 'claude' } })

    expect(onChange).toHaveBeenCalledWith('claude')
  })

  it('suffixes a local engine id with the local-engine tag and keeps CLI labels bare', () => {
    render(<RailEngineSelector value="lan-box" providers={['claude', 'lan-box']} onChange={vi.fn()} />)
    const options = Array.from((screen.getByTestId('rail-engine-selector') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toEqual(['Claude', 'lan-box · Local engine', 'Roles'])
  })
})
