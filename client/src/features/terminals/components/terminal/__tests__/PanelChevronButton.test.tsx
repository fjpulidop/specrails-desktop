/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PanelChevronButton } from '../PanelChevronButton'

describe('PanelChevronButton', () => {
  it('renders with collapse label when open', () => {
    const { getByLabelText } = render(<PanelChevronButton isOpen onClick={() => {}} />)
    expect(getByLabelText('Collapse terminal panel')).toBeDefined()
  })

  it('renders with expand label when closed', () => {
    const { getByLabelText } = render(<PanelChevronButton isOpen={false} onClick={() => {}} />)
    expect(getByLabelText('Expand terminal panel')).toBeDefined()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    const { getByRole } = render(<PanelChevronButton isOpen onClick={onClick} />)
    fireEvent.click(getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('aria-expanded reflects isOpen', () => {
    const { getByRole, rerender } = render(<PanelChevronButton isOpen onClick={() => {}} />)
    expect(getByRole('button').getAttribute('aria-expanded')).toBe('true')
    rerender(<PanelChevronButton isOpen={false} onClick={() => {}} />)
    expect(getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})
