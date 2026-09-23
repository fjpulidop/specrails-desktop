import { describe, it, expect, beforeEach } from 'vitest'
import { getLastEngine, setLastEngine } from '../last-engine'

const KEY_PREFIX = 'specrails-desktop:last-engine:'

describe('last-engine', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  // ---------------------------------------------------------------------------
  // getLastEngine
  // ---------------------------------------------------------------------------

  describe('getLastEngine', () => {
    it('returns fallback when projectId is null', () => {
      expect(getLastEngine(null, ['claude', 'codex'], 'claude')).toBe('claude')
    })

    it('returns fallback when projectId is undefined', () => {
      expect(getLastEngine(undefined, ['claude', 'codex'], 'claude')).toBe('claude')
    })

    it('returns fallback when nothing is stored', () => {
      expect(getLastEngine('proj-1', ['claude', 'codex'], 'codex')).toBe('codex')
    })

    it('returns stored value when present AND still installed', () => {
      window.localStorage.setItem(`${KEY_PREFIX}proj-1`, 'codex')
      expect(getLastEngine('proj-1', ['claude', 'codex'], 'claude')).toBe('codex')
    })

    it('returns fallback when stored value is not in installed list', () => {
      window.localStorage.setItem(`${KEY_PREFIX}proj-1`, 'codex')
      expect(getLastEngine('proj-1', ['claude'], 'claude')).toBe('claude')
    })

    it('is scoped per project — different project returns fallback', () => {
      window.localStorage.setItem(`${KEY_PREFIX}proj-a`, 'codex')
      // proj-b has nothing stored, should return fallback
      expect(getLastEngine('proj-b', ['claude', 'codex'], 'claude')).toBe('claude')
    })

    it('returns stored value scoped to the correct project', () => {
      window.localStorage.setItem(`${KEY_PREFIX}proj-a`, 'codex')
      window.localStorage.setItem(`${KEY_PREFIX}proj-b`, 'claude')
      expect(getLastEngine('proj-a', ['claude', 'codex'], 'claude')).toBe('codex')
      expect(getLastEngine('proj-b', ['claude', 'codex'], 'codex')).toBe('claude')
    })

    it('returns fallback when installed list is empty', () => {
      window.localStorage.setItem(`${KEY_PREFIX}proj-1`, 'claude')
      expect(getLastEngine('proj-1', [], 'claude')).toBe('claude')
    })
  })

  // ---------------------------------------------------------------------------
  // setLastEngine
  // ---------------------------------------------------------------------------

  describe('setLastEngine', () => {
    it('writes under the correct localStorage key', () => {
      setLastEngine('proj-1', 'codex')
      expect(window.localStorage.getItem(`${KEY_PREFIX}proj-1`)).toBe('codex')
    })

    it('is a no-op when projectId is null', () => {
      setLastEngine(null, 'codex')
      // Nothing should have been written
      expect(window.localStorage.length).toBe(0)
    })

    it('is a no-op when projectId is undefined', () => {
      setLastEngine(undefined, 'codex')
      expect(window.localStorage.length).toBe(0)
    })

    it('overwrites a previously stored value', () => {
      setLastEngine('proj-1', 'claude')
      setLastEngine('proj-1', 'codex')
      expect(window.localStorage.getItem(`${KEY_PREFIX}proj-1`)).toBe('codex')
    })

    it('does not affect other project keys', () => {
      setLastEngine('proj-a', 'claude')
      setLastEngine('proj-b', 'codex')
      expect(window.localStorage.getItem(`${KEY_PREFIX}proj-a`)).toBe('claude')
      expect(window.localStorage.getItem(`${KEY_PREFIX}proj-b`)).toBe('codex')
    })
  })

  // ---------------------------------------------------------------------------
  // round-trip: set then get
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('getLastEngine reads back a value written by setLastEngine', () => {
      setLastEngine('proj-1', 'codex')
      expect(getLastEngine('proj-1', ['claude', 'codex'], 'claude')).toBe('codex')
    })

    it('after storing, returns fallback when stored engine is later removed from installed', () => {
      setLastEngine('proj-1', 'codex')
      // codex no longer in installed list
      expect(getLastEngine('proj-1', ['claude'], 'claude')).toBe('claude')
    })
  })
})
