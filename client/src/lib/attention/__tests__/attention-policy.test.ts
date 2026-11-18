import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTENTION_PREFS, decideAttention, legacyPrefsPatch, readAttentionPrefs, type AttentionPrefs, type AttentionSituation } from '../attention-policy'

const prefs = (over: Partial<AttentionPrefs> = {}): AttentionPrefs => ({ ...structuredClone(DEFAULT_ATTENTION_PREFS), ...over })
const away: AttentionSituation = { category: 'review', projectId: 'p1', windowFocused: false, placeOnScreen: false }

describe('decideAttention', () => {
  it('away from the app → an OS notification', () => {
    expect(decideAttention(away, prefs())).toBe('notify')
  })

  it('focused, elsewhere in the app → an in-app toast', () => {
    expect(decideAttention({ ...away, windowFocused: true }, prefs())).toBe('toast')
  })

  it('focused, a finished job never interrupts (only the away notification)', () => {
    expect(decideAttention({ ...away, category: 'done', windowFocused: true }, prefs())).toBe('skip')
    expect(decideAttention({ ...away, category: 'done' }, prefs())).toBe('notify')
  })

  it('focused on the item\'s own place → nothing', () => {
    expect(decideAttention({ ...away, windowFocused: true, placeOnScreen: true }, prefs())).toBe('skip')
  })

  it('a persistent alert (a stuck run) interrupts even a focused window on its own place', () => {
    expect(decideAttention({ ...away, category: 'failed', windowFocused: true, placeOnScreen: true, persistent: true }, prefs())).toBe('notify')
  })

  it('off, category off or project muted → nothing, persistent or not', () => {
    expect(decideAttention(away, prefs({ enabled: false }))).toBe('skip')
    const noReviews = prefs()
    noReviews.categories.review = false
    expect(decideAttention(away, noReviews)).toBe('skip')
    expect(decideAttention({ ...away, persistent: true }, prefs({ mutedProjects: ['p1'] }))).toBe('skip')
    expect(decideAttention({ ...away, projectId: null }, prefs({ mutedProjects: ['p1'] }))).toBe('notify')
  })
})

describe('readAttentionPrefs', () => {
  it('fills what the wire leaves out with the defaults and drops junk', () => {
    expect(readAttentionPrefs(null)).toEqual(DEFAULT_ATTENTION_PREFS)
    expect(readAttentionPrefs({ enabled: false, categories: { done: false, review: 'x' }, mutedProjects: ['p1', 3, ''] })).toEqual({
      ...DEFAULT_ATTENTION_PREFS,
      enabled: false,
      categories: { ...DEFAULT_ATTENTION_PREFS.categories, done: false },
      mutedProjects: ['p1'],
    })
  })
})

describe('legacyPrefsPatch (one-time migration of the old job-notification prefs)', () => {
  it('maps the old filter onto categories and keeps an explicit off', () => {
    expect(legacyPrefsPatch(JSON.stringify({ enabled: true, filter: 'completed' }))).toEqual({ categories: { failed: false, budget: false } })
    expect(legacyPrefsPatch(JSON.stringify({ enabled: true, filter: 'failed' }))).toEqual({ categories: { done: false } })
    expect(legacyPrefsPatch(JSON.stringify({ enabled: false, filter: 'all' }))).toEqual({ enabled: false })
  })

  it('nothing to migrate for the defaults, nothing stored, or junk', () => {
    expect(legacyPrefsPatch(JSON.stringify({ enabled: true, filter: 'all' }))).toBeNull()
    expect(legacyPrefsPatch(null)).toBeNull()
    expect(legacyPrefsPatch('not json')).toBeNull()
  })
})
