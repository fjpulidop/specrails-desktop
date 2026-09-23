import { describe, it, expect, beforeEach } from 'vitest'
import { formatElapsed, readPendingSpecs, savePendingSpec, removePendingSpec } from '../pending-specs'
import type { PendingSpec } from '../pending-specs'

const makeSpec = (overrides: Partial<PendingSpec> = {}): PendingSpec => ({
  id: 'spec-1',
  knownTicketIds: [1, 2],
  projectId: 'proj-1',
  projectName: 'Test Project',
  startTime: Date.now() - 5000,
  truncated: 'Add dark mode',
  ...overrides,
})

describe('formatElapsed', () => {
  it('formats seconds under 1 minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(5000)).toBe('5s')
    expect(formatElapsed(59000)).toBe('59s')
  })

  it('formats minutes and seconds when >= 60s', () => {
    expect(formatElapsed(60000)).toBe('1:00')
    expect(formatElapsed(90000)).toBe('1:30')
    expect(formatElapsed(3600000)).toBe('60:00')
  })

  it('pads seconds with leading zero', () => {
    expect(formatElapsed(61000)).toBe('1:01')
    expect(formatElapsed(605000)).toBe('10:05')
  })
})

describe('pending-specs localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('readPendingSpecs', () => {
    it('returns empty array when nothing stored', () => {
      expect(readPendingSpecs()).toEqual([])
    })

    it('returns empty array on parse error', () => {
      localStorage.setItem('specrails-desktop:pending-specs', 'not-json{{{')
      expect(readPendingSpecs()).toEqual([])
    })

    it('returns stored specs', () => {
      const spec = makeSpec()
      localStorage.setItem('specrails-desktop:pending-specs', JSON.stringify([spec]))
      expect(readPendingSpecs()).toEqual([spec])
    })
  })

  describe('savePendingSpec', () => {
    it('saves a new spec', () => {
      const spec = makeSpec()
      savePendingSpec(spec)
      expect(readPendingSpecs()).toEqual([spec])
    })

    it('deduplicates by id (replaces existing)', () => {
      const spec = makeSpec()
      savePendingSpec(spec)
      const updated = { ...spec, truncated: 'Updated text' }
      savePendingSpec(updated)
      const list = readPendingSpecs()
      expect(list).toHaveLength(1)
      expect(list[0].truncated).toBe('Updated text')
    })

    it('stores multiple distinct specs', () => {
      savePendingSpec(makeSpec({ id: 'a' }))
      savePendingSpec(makeSpec({ id: 'b' }))
      expect(readPendingSpecs()).toHaveLength(2)
    })
  })

  describe('removePendingSpec', () => {
    it('removes spec by id', () => {
      savePendingSpec(makeSpec({ id: 'keep' }))
      savePendingSpec(makeSpec({ id: 'remove' }))
      removePendingSpec('remove')
      const list = readPendingSpecs()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('keep')
    })

    it('is a no-op when id does not exist', () => {
      savePendingSpec(makeSpec())
      removePendingSpec('nonexistent')
      expect(readPendingSpecs()).toHaveLength(1)
    })
  })
})
