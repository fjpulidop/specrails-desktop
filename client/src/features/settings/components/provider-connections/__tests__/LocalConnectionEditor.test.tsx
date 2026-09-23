import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../../../test-utils'
import { LocalConnectionEditor } from '../LocalConnectionEditor'

function baseProps() {
  return {
    provider: { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8080/v1' },
    persisted: true,
    onChange: vi.fn(),
    onStatus: vi.fn(),
    onValidity: vi.fn(),
    onRemove: vi.fn(),
  }
}

describe('LocalConnectionEditor — agent loop + context window', () => {
  it('defaults to Compact, switches to Free (and back to the compact default), records the context window', () => {
    const onChange = vi.fn()
    const props = baseProps()
    render(<LocalConnectionEditor {...props} onChange={onChange} />)
    expect(screen.getByRole('radio', { name: /Compact/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: /Free/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agentLoop: 'free' }))
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: '65536' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindowTokens: 65536 }))
  })
  it('renders Free as checked when persisted and clears the field back to the compact default', () => {
    const onChange = vi.fn()
    const props = baseProps()
    render(<LocalConnectionEditor {...props} provider={{ ...props.provider, agentLoop: 'free', contextWindowTokens: 20480 }} onChange={onChange} />)
    expect(screen.getByRole('radio', { name: /Free/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(/Context window/)).toHaveValue(20480)
    fireEvent.click(screen.getByRole('radio', { name: /Compact/ }))
    expect(onChange.mock.calls.at(-1)![0].agentLoop).toBeUndefined()
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: '' } })
    expect(onChange.mock.calls.at(-1)![0].contextWindowTokens).toBeUndefined()
  })
})

describe('LocalConnectionEditor — small-model preset + effort hint', () => {
  it('applies Compact + effort + 32k in one click and then reports the preset as applied', () => {
    const onChange = vi.fn()
    const props = baseProps()
    render(<LocalConnectionEditor {...props} onChange={onChange} />)
    expect(screen.getByText(/selector is hidden in the rail header/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Recommended for small models/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ supportsReasoningEffort: true, contextWindowTokens: 32768 }))
    expect(onChange.mock.calls.at(-1)![0].agentLoop).toBeUndefined()
  })
  it('keeps a larger configured window and shows the applied state', () => {
    const props = baseProps()
    render(<LocalConnectionEditor {...props} provider={{ ...props.provider, supportsReasoningEffort: true, contextWindowTokens: 65536 }} />)
    expect(screen.getByRole('button', { name: /Small-model preset applied/ })).toBeDisabled()
    expect(screen.queryByText(/selector is hidden in the rail header/)).toBeNull()
  })
})
