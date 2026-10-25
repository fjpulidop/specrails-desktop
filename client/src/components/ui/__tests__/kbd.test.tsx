import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Kbd } from '../kbd'

describe('Kbd', () => {
  it('is the one key chip: caption role, control radius, hairline border, no monospace', () => {
    render(<Kbd>⌘K</Kbd>)
    const chip = screen.getByText('⌘K')
    expect(chip.tagName).toBe('KBD')
    expect(chip.className).toContain('rounded-control')
    expect(chip.className).toContain('border-border/50')
    expect(chip.className).toContain('bg-muted/30')
    expect(chip.className).toContain('px-1.5')
    expect(chip.className).toContain('text-caption')
    expect(chip.className).not.toContain('font-mono')
    expect(chip.className).not.toMatch(/text-\[\d+px\]/)
  })

  it('accepts extra classes and attributes', () => {
    render(<Kbd aria-hidden="true" className="ml-1">esc</Kbd>)
    const chip = screen.getByText('esc', { ignore: '' })
    expect(chip).toHaveAttribute('aria-hidden', 'true')
    expect(chip.className).toContain('ml-1')
  })
})
