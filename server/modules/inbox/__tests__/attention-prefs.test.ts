import { describe, expect, it } from 'vitest'
import {
  AttentionPrefsValidationError, MAX_MUTED_PROJECTS, applyAttentionPrefsPatch, defaultAttentionPrefs, readAttentionPrefs,
} from '../attention-prefs'

describe('attention prefs (pure)', () => {
  it('defaults: enabled, every category on, sound off, Dock badge on, nothing muted', () => {
    expect(readAttentionPrefs(undefined)).toEqual({
      enabled: true,
      categories: { question: true, review: true, failed: true, budget: true, done: true },
      sound: false,
      dockBadge: true,
      mutedProjects: [],
    })
  })

  it('reads a stored record field by field; corrupt values fall back to the defaults', () => {
    expect(readAttentionPrefs('not json')).toEqual(defaultAttentionPrefs())
    expect(readAttentionPrefs('[1,2]')).toEqual(defaultAttentionPrefs())
    const prefs = readAttentionPrefs(JSON.stringify({
      enabled: false, sound: 'yes', categories: { done: false, review: 1, bogus: true }, mutedProjects: ['p1', 'p1', 3, ''],
    }))
    expect(prefs.enabled).toBe(false)
    expect(prefs.sound).toBe(false)
    expect(prefs.categories).toEqual({ question: true, review: true, failed: true, budget: true, done: false })
    expect(prefs.mutedProjects).toEqual(['p1'])
  })

  it('patches partially: categories merge, mutedProjects replaces (deduplicated)', () => {
    const next = applyAttentionPrefsPatch(defaultAttentionPrefs(), { sound: true, categories: { done: false }, mutedProjects: ['a', 'b', 'a'] })
    expect(next).toMatchObject({ enabled: true, sound: true, dockBadge: true, mutedProjects: ['a', 'b'] })
    expect(next.categories.done).toBe(false)
    expect(next.categories.review).toBe(true)
  })

  it('does not mutate the current record', () => {
    const current = defaultAttentionPrefs()
    applyAttentionPrefsPatch(current, { categories: { failed: false }, mutedProjects: ['x'] })
    expect(current).toEqual(defaultAttentionPrefs())
  })

  it.each([
    [null, 'body'],
    [[], 'body'],
    [{ enabled: 'no' }, 'enabled'],
    [{ dockBadge: 1 }, 'dockBadge'],
    [{ volume: 3 }, 'volume'],
    [{ categories: [] }, 'categories'],
    [{ categories: { bogus: true } }, 'categories.bogus'],
    [{ categories: { done: 'off' } }, 'categories.done'],
    [{ mutedProjects: 'p1' }, 'mutedProjects'],
    [{ mutedProjects: [''] }, 'mutedProjects'],
    [{ mutedProjects: ['x'.repeat(201)] }, 'mutedProjects'],
    [{ mutedProjects: Array.from({ length: MAX_MUTED_PROJECTS + 1 }, (_, i) => `p${i}`) }, 'mutedProjects'],
  ])('rejects %j (field %s)', (body, field) => {
    let error: unknown
    try { applyAttentionPrefsPatch(defaultAttentionPrefs(), body) } catch (err) { error = err }
    expect(error).toBeInstanceOf(AttentionPrefsValidationError)
    expect((error as AttentionPrefsValidationError).field).toBe(field)
  })
})
