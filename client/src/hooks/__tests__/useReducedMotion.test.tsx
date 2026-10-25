import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '../../test-utils'
import { useReducedMotion, resolveReducedMotion } from '../useReducedMotion'
import { setA11yPrefs, resetA11yPrefsCache, applyA11yPrefs, prefersReducedMotion, DEFAULT_A11Y_PREFS, A11Y_PREFS_KEY } from '../../lib/a11y-prefs'
import { LiveDot } from '../../components/ui/live-dot'

const realMatchMedia = window.matchMedia
function osReduce(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  })
}

function Probe() {
  return <output data-testid="reduced">{String(useReducedMotion())}</output>
}

describe('reduce motion override', () => {
  beforeEach(() => { localStorage.clear(); resetA11yPrefsCache(); applyA11yPrefs(DEFAULT_A11Y_PREFS) })
  afterEach(() => { Object.defineProperty(window, 'matchMedia', { writable: true, value: realMatchMedia }); localStorage.clear(); resetA11yPrefsCache(); applyA11yPrefs(DEFAULT_A11Y_PREFS) })

  it('resolves the override against the OS value', () => {
    expect(resolveReducedMotion('system', true)).toBe(true)
    expect(resolveReducedMotion('system', false)).toBe(false)
    expect(resolveReducedMotion('reduce', false)).toBe(true)
    expect(resolveReducedMotion('full', true)).toBe(false)
  })

  it('follows the OS in system mode', () => {
    osReduce(true)
    render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('true')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('forces reduce even when the OS allows motion, and sets the root attribute', () => {
    osReduce(false)
    render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
    act(() => { setA11yPrefs({ motion: 'reduce' }) })
    expect(screen.getByTestId('reduced')).toHaveTextContent('true')
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce')
    expect(prefersReducedMotion()).toBe(true)
  })

  it('forces full motion over an OS reduce request', () => {
    osReduce(true)
    act(() => { setA11yPrefs({ motion: 'full' }) })
    render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
    expect(document.documentElement).toHaveAttribute('data-motion', 'full')
  })

  it('persists the choice and tolerates a corrupt store', () => {
    setA11yPrefs({ motion: 'reduce', density: 'compact' })
    expect(JSON.parse(localStorage.getItem(A11Y_PREFS_KEY)!)).toEqual({ motion: 'reduce', density: 'compact' })
    localStorage.setItem(A11Y_PREFS_KEY, '{not json')
    resetA11yPrefsCache()
    osReduce(false)
    render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
  })

  it('JS motion components honour it: the LiveDot ring is dropped', () => {
    osReduce(false)
    const { container, rerender } = render(<LiveDot />)
    expect(container.querySelector('[data-live-ring]')).not.toBeNull()
    act(() => { setA11yPrefs({ motion: 'reduce' }) })
    rerender(<LiveDot />)
    expect(container.querySelector('[data-live-ring]')).toBeNull()
  })
})
