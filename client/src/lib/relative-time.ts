import { format } from 'date-fns'
import { getDateFnsLocale } from './i18n'

/**
 * Parse a timestamp that may be ISO-8601 (with `Z`/offset) OR a SQLite NAIVE
 * UTC datetime (`YYYY-MM-DD HH:MM:SS`, exactly what `datetime('now')` emits).
 * Naive strings are treated as **UTC** — parsing them as local time is the
 * classic off-by-timezone bug that made the mission counter drift after a
 * refresh (the server stores UTC; `Date.parse('YYYY-MM-DD HH:MM:SS')` assumes
 * local). Returns NaN when unparseable.
 */
export function parseTimestampMs(raw: string): number {
  if (!raw) return Number.NaN
  const s = raw.trim()
  // Explicit zone (trailing Z, or ±HH:MM / ±HHMM) → trust it as-is.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s)
  // Naive → normalise the space separator to `T` and pin it to UTC.
  return Date.parse(`${s.replace(' ', 'T')}Z`)
}

/** Safe Date from a possibly-naive-UTC server timestamp (null when invalid). */
export function toDate(raw: string): Date | null {
  const ms = parseTimestampMs(raw)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * Compact "time since" — the Cursor / Antigravity mission-list style: a single
 * tight unit (`now`, `5m`, `3h`, `1d`, `2w`, `3mo`, `1y`). Months use `mo` (not
 * `m`) so they never read as minutes. Pure function of the current time.
 */
export function compactRelativeTime(iso: string, now: number = Date.now()): string {
  const t = parseTimestampMs(iso)
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.floor((now - t) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${Math.max(1, mins)}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/** Absolute, locale-formatted date+time for a hover tooltip (consultable). */
export function absoluteTime(iso: string): string {
  const d = toDate(iso)
  if (!d) return ''
  return format(d, 'PPpp', { locale: getDateFnsLocale() })
}
