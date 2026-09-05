import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { DEFAULT_EFFECTS_PREFS, EFFECTS_PREFS_KEY, getEffectsPrefs, resetEffectsPrefsCache, setEffectsPrefs, useEffectsPrefs } from '../effects-prefs'

describe('effects-prefs', () => {
  beforeEach(() => { localStorage.clear(); resetEffectsPrefsCache() })

  it('defaults the thinking halo ON, persists a change, and tolerates junk storage', () => {
    expect(getEffectsPrefs()).toEqual(DEFAULT_EFFECTS_PREFS)
    setEffectsPrefs({ agentThinkingHalo: false })
    expect(JSON.parse(localStorage.getItem(EFFECTS_PREFS_KEY)!)).toEqual({ agentThinkingHalo: false })
    resetEffectsPrefsCache()
    expect(getEffectsPrefs().agentThinkingHalo).toBe(false)
    localStorage.setItem(EFFECTS_PREFS_KEY, '{not json')
    resetEffectsPrefsCache()
    expect(getEffectsPrefs()).toEqual(DEFAULT_EFFECTS_PREFS)
    localStorage.setItem(EFFECTS_PREFS_KEY, JSON.stringify({ agentThinkingHalo: 'yes' }))
    resetEffectsPrefsCache()
    expect(getEffectsPrefs().agentThinkingHalo).toBe(true)
  })

  it('the hook re-renders every subscriber when a switch flips', () => {
    const { result } = renderHook(() => useEffectsPrefs())
    expect(result.current.agentThinkingHalo).toBe(true)
    act(() => { setEffectsPrefs({ agentThinkingHalo: false }) })
    expect(result.current.agentThinkingHalo).toBe(false)
    act(() => { setEffectsPrefs({ agentThinkingHalo: true }) })
    expect(result.current.agentThinkingHalo).toBe(true)
  })
})
