import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '../../test-utils'
import { FreestyleLaunchDialog } from '../FreestyleLaunchDialog'

const base = {
  open: true,
  railLabel: 'Rail 1',
  specCount: 2,
  model: 'opus',
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

describe('FreestyleLaunchDialog', () => {
  it('renders the warning content with rail context', () => {
    render(<FreestyleLaunchDialog {...base} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Launch in Freestyle mode')).toBeInTheDocument()
    expect(screen.getByText(/Rail 1 · 2 specs · opus/)).toBeInTheDocument()
    expect(screen.getByText(/No OpenSpec pipeline/)).toBeInTheDocument()
    expect(screen.getByText(/Variable cost/)).toBeInTheDocument()
  })

  it('singularises the spec count', () => {
    render(<FreestyleLaunchDialog {...base} specCount={1} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/Rail 1 · 1 spec ·/)).toBeInTheDocument()
  })

  it('calls onConfirm when Continue is clicked', () => {
    const onConfirm = vi.fn()
    render(<FreestyleLaunchDialog {...base} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Continue'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<FreestyleLaunchDialog {...base} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('confirms on Cmd/Ctrl+Enter', () => {
    const onConfirm = vi.fn()
    render(<FreestyleLaunchDialog {...base} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not bind the shortcut when closed', () => {
    const onConfirm = vi.fn()
    render(<FreestyleLaunchDialog {...base} open={false} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
