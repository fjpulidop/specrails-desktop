import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  markSpecGenInFlight,
  unmarkSpecGenInFlight,
  isSpecGenInFlight,
} from '../spec-gen-suppression'

describe('spec-gen-suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('isSpecGenInFlight returns false for null/undefined/empty project', () => {
    expect(isSpecGenInFlight(null)).toBe(false)
    expect(isSpecGenInFlight(undefined)).toBe(false)
    expect(isSpecGenInFlight('')).toBe(false)
  })

  it('mark + isSpecGenInFlight reflects active state', () => {
    expect(isSpecGenInFlight('p-mark')).toBe(false)
    markSpecGenInFlight('p-mark')
    expect(isSpecGenInFlight('p-mark')).toBe(true)
    unmarkSpecGenInFlight('p-mark')
    vi.advanceTimersByTime(2000)
    expect(isSpecGenInFlight('p-mark')).toBe(false)
  })

  it('refcounts concurrent marks; only clears after all unmarks plus grace', () => {
    const id = 'p-refcount'
    markSpecGenInFlight(id)
    markSpecGenInFlight(id)
    expect(isSpecGenInFlight(id)).toBe(true)

    unmarkSpecGenInFlight(id)
    vi.advanceTimersByTime(2000)
    expect(isSpecGenInFlight(id)).toBe(true)

    unmarkSpecGenInFlight(id)
    expect(isSpecGenInFlight(id)).toBe(true)
    vi.advanceTimersByTime(1999)
    expect(isSpecGenInFlight(id)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isSpecGenInFlight(id)).toBe(false)
  })

  it('unmark on never-marked project is a no-op', () => {
    unmarkSpecGenInFlight('ghost')
    vi.advanceTimersByTime(2000)
    expect(isSpecGenInFlight('ghost')).toBe(false)
  })

  it('isolates state across project ids', () => {
    markSpecGenInFlight('iso-a')
    markSpecGenInFlight('iso-b')
    expect(isSpecGenInFlight('iso-a')).toBe(true)
    expect(isSpecGenInFlight('iso-b')).toBe(true)
    unmarkSpecGenInFlight('iso-a')
    vi.advanceTimersByTime(2000)
    expect(isSpecGenInFlight('iso-a')).toBe(false)
    expect(isSpecGenInFlight('iso-b')).toBe(true)
    unmarkSpecGenInFlight('iso-b')
    vi.advanceTimersByTime(2000)
    expect(isSpecGenInFlight('iso-b')).toBe(false)
  })
})
