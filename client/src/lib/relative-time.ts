import { format } from 'date-fns'
import { getDateFnsLocale } from './i18n'

/**
 * Compact "time since" — the Cursor / Antigravity mission-list style: a single
 * tight unit (`now`, `5m`, `3h`, `1d`, `2w`, `3mo`, `1y`). Months use `mo` (not
 * `m`) so they never read as minutes. Pure function of the current time.
 */
export function compactRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
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
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return format(d, 'PPpp', { locale: getDateFnsLocale() })
}
