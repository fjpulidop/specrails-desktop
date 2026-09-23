/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { EmptyTerminalPlaceholder } from '../EmptyTerminalPlaceholder'

describe('EmptyTerminalPlaceholder', () => {
  it('renders placeholder copy', () => {
    const { getByText } = render(<EmptyTerminalPlaceholder onCreate={() => {}} />)
    expect(getByText(/no terminals yet/i)).toBeDefined()
  })

  it('calls onCreate when "New terminal" clicked', () => {
    const onCreate = vi.fn()
    const { getByRole } = render(<EmptyTerminalPlaceholder onCreate={onCreate} />)
    fireEvent.click(getByRole('button', { name: /new terminal/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
