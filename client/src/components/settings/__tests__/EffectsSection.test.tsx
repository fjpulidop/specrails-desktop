import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { EffectsSection } from '../EffectsSection'
import { getEffectsPrefs, resetEffectsPrefsCache } from '../../../lib/effects-prefs'

describe('EffectsSection', () => {
  beforeEach(() => { localStorage.clear(); resetEffectsPrefsCache() })

  it('shows the thinking-halo switch ON by default with a live preview, and persists a flip', async () => {
    render(<EffectsSection />)
    expect(screen.getByText('Effects')).toBeInTheDocument()
    const toggle = screen.getByTestId('effects-thinking-halo-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('effects-thinking-halo-preview')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(getEffectsPrefs().agentThinkingHalo).toBe(false)
    expect(screen.getByTestId('effects-thinking-halo-preview')).toHaveAttribute('data-active', 'false')
  })
})
