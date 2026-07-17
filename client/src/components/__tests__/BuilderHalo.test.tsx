import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '../../test-utils'
import { BuilderHalo } from '../project-builder/BuilderHalo'

// useReducedMotion is mocked per-test: jsdom has no matchMedia-driven updates.
const reducedMotionMock = vi.hoisted(() => ({ value: false }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useReducedMotion: () => reducedMotionMock.value }
})

afterEach(() => {
  reducedMotionMock.value = false
})

describe('BuilderHalo', () => {
  it('renders nothing while inactive', () => {
    render(<BuilderHalo active={false} />)
    expect(screen.queryByTestId('builder-halo')).not.toBeInTheDocument()
  })

  it('renders the orbiting ring while active', () => {
    const { container } = render(<BuilderHalo active />)
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    // The spin class is present on the ring layer (CSS keyframes, no JS loop).
    expect(container.querySelector('[class*="builder-halo-spin"]')).not.toBeNull()
  })

  it('reduced motion renders a static glow (no spin animation)', () => {
    reducedMotionMock.value = true
    const { container } = render(<BuilderHalo active />)
    const halo = screen.getByTestId('builder-halo')
    expect(halo).toHaveAttribute('data-reduced-motion', 'true')
    expect(container.querySelector('[class*="builder-halo-spin"]')).toBeNull()
  })
})
