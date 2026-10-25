import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { AccessibilitySettings } from '../AccessibilitySection'
import { resetA11yPrefsCache, applyA11yPrefs, DEFAULT_A11Y_PREFS, getA11yPrefs } from '../../../../lib/a11y-prefs'
import { loadSpecsViewTier, saveSpecsViewTier, hasStoredSpecsViewTier } from '../../../specs/lib/specs-view-tier'

vi.mock('../../../../components/HelpHint', () => ({ HelpHint: () => null }))

describe('Density and Reduce motion settings', () => {
  beforeEach(() => { localStorage.clear(); resetA11yPrefsCache(); applyA11yPrefs(DEFAULT_A11Y_PREFS) })

  it('applies density to the root element at once and persists it', () => {
    render(<AccessibilitySettings />)
    expect(document.documentElement).toHaveAttribute('data-density', 'comfortable')
    fireEvent.click(screen.getByTestId('density-choice-compact'))
    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
    expect(getA11yPrefs().density).toBe('compact')
    expect(screen.getByTestId('density-choice-compact')).toBeChecked()
  })

  it('offers system / reduce / full for motion', () => {
    render(<AccessibilitySettings />)
    expect(screen.getByTestId('motion-choice-system')).toBeChecked()
    fireEvent.click(screen.getByTestId('motion-choice-reduce'))
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce')
    fireEvent.click(screen.getByTestId('motion-choice-system'))
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false)
  })

  it('both cards are registered ⌘K anchors', () => {
    render(<AccessibilitySettings />)
    expect(document.querySelector('[data-setting-id="density"]')).not.toBeNull()
    expect(document.querySelector('[data-setting-id="reduceMotion"]')).not.toBeNull()
  })
})

describe('app density as the board default', () => {
  beforeEach(() => { localStorage.clear(); resetA11yPrefsCache(); applyA11yPrefs(DEFAULT_A11Y_PREFS) })

  it('compact density makes rows the default tier, comfortable makes post-its', () => {
    expect(loadSpecsViewTier('p1')).toBe('postit')
    localStorage.setItem('specrails-desktop:a11y', JSON.stringify({ density: 'compact', motion: 'system' }))
    resetA11yPrefsCache()
    expect(loadSpecsViewTier('p1')).toBe('row')
    expect(hasStoredSpecsViewTier('p1')).toBe(false)
  })

  it('a stored tier (or an applied saved view, which stores one) overrides the app default', () => {
    localStorage.setItem('specrails-desktop:a11y', JSON.stringify({ density: 'compact', motion: 'system' }))
    resetA11yPrefsCache()
    saveSpecsViewTier('p1', 'postit')
    expect(hasStoredSpecsViewTier('p1')).toBe(true)
    expect(loadSpecsViewTier('p1')).toBe('postit')
    expect(loadSpecsViewTier('p2')).toBe('row')
  })
})
