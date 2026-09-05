import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '../../../test-utils'
import { AgentThinkingHalo } from '../AgentThinkingHalo'
import { resetEffectsPrefsCache, setEffectsPrefs } from '../../../lib/effects-prefs'

describe('AgentThinkingHalo', () => {
  beforeEach(() => { localStorage.clear(); resetEffectsPrefsCache() })

  it('orbits the composer while a turn is in flight and leaves when it settles', () => {
    const { rerender } = render(<AgentThinkingHalo active />)
    expect(screen.getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    rerender(<AgentThinkingHalo active={false} />)
    expect(screen.getByTestId('agent-thinking-halo')).toHaveAttribute('data-active', 'false')
  })

  it('renders nothing at all when the effect is switched off in Settings', () => {
    render(<AgentThinkingHalo active />)
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    act(() => { setEffectsPrefs({ agentThinkingHalo: false }) })
    expect(screen.queryByTestId('agent-thinking-halo')).toBeNull()
    expect(screen.queryByTestId('builder-halo')).toBeNull()
  })
})
