import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '../../../../test-utils'
import { AccessibilitySettings } from '../AccessibilitySection'
import { resetA11yPrefsCache, applyA11yPrefs, DEFAULT_A11Y_PREFS, getA11yPrefs } from '../../../../lib/a11y-prefs'
import { loadSpecsViewTier, saveSpecsViewTier, hasStoredSpecsViewTier, SPECS_VIEW_TIER_RESET_EVENT } from '../../../specs/lib/specs-view-tier'

vi.mock('../../../../components/HelpHint', () => ({ HelpHint: () => null }))
const desktop = vi.hoisted(() => ({ activeProjectId: 'p1' as string | null }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: desktop.activeProjectId }) }))

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

  it('offers to make the board follow the density again when the project chose its own tier', () => {
    desktop.activeProjectId = 'p1'
    render(<AccessibilitySettings />)
    expect(screen.queryByTestId('density-reset-board')).toBeNull()
    cleanup()
    saveSpecsViewTier('p1', 'row')
    const seen: string[] = []
    const onReset = (e: Event) => seen.push((e as CustomEvent<{ projectId: string }>).detail.projectId)
    window.addEventListener(SPECS_VIEW_TIER_RESET_EVENT, onReset)
    render(<AccessibilitySettings />)
    fireEvent.click(screen.getByText('Use this for the board too'))
    window.removeEventListener(SPECS_VIEW_TIER_RESET_EVENT, onReset)
    expect(hasStoredSpecsViewTier('p1')).toBe(false)
    expect(seen).toEqual(['p1'])
    expect(screen.queryByTestId('density-reset-board')).toBeNull()
    expect(screen.getByTestId('density-reset-board-done')).toBeInTheDocument()
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
