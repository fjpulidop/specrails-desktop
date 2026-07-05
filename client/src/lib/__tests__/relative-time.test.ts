import { describe, it, expect } from 'vitest'
import { parseTimestampMs, toDate, compactRelativeTime } from '../relative-time'

describe('parseTimestampMs — naive SQLite datetime is UTC, not local', () => {
  const EPOCH_UTC = Date.UTC(2026, 6, 5, 10, 30, 0) // 2026-07-05 10:30:00 UTC

  it('parses a SQLite naive datetime (no zone) as UTC', () => {
    // The classic bug: Date.parse of a naive string uses LOCAL time. Ours pins UTC.
    expect(parseTimestampMs('2026-07-05 10:30:00')).toBe(EPOCH_UTC)
  })

  it('parses an ISO string with Z the same', () => {
    expect(parseTimestampMs('2026-07-05T10:30:00.000Z')).toBe(EPOCH_UTC)
    expect(parseTimestampMs('2026-07-05T10:30:00Z')).toBe(EPOCH_UTC)
  })

  it('honours an explicit offset', () => {
    expect(parseTimestampMs('2026-07-05T12:30:00+02:00')).toBe(EPOCH_UTC)
  })

  it('the naive form and the Z form yield an IDENTICAL instant (no tz drift)', () => {
    expect(parseTimestampMs('2026-07-05 10:30:00')).toBe(parseTimestampMs('2026-07-05T10:30:00Z'))
  })

  it('returns NaN / null for junk', () => {
    expect(Number.isNaN(parseTimestampMs('not-a-date'))).toBe(true)
    expect(toDate('nope')).toBeNull()
  })

  it('compactRelativeTime treats a naive-UTC server timestamp correctly (now, not tz-shifted)', () => {
    const now = Date.UTC(2026, 6, 5, 10, 30, 30) // 30s after the naive stamp
    // A stamp 30s ago must read "now" regardless of the machine's timezone —
    // this is what regressed the mission counter after a refresh.
    expect(compactRelativeTime('2026-07-05 10:30:00', now)).toBe('now')
    expect(compactRelativeTime('2026-07-05 10:25:30', now)).toBe('5m')
  })
})
