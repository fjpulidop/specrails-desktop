/**
 * Reset times as people read them: a local clock time ("15:00", "Thu 09:00"
 * when not today) and a countdown ("in 3h 54m"). The countdown re-renders at
 * the next minute/hour boundary its label changes on, never every second.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatResetTime(iso: string, language: string, now = Date.now()): string {
  const at = new Date(iso)
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(at)
  if (sameDay) return time
  const day = new Intl.DateTimeFormat(language, Math.abs(at.getTime() - now) < 6 * DAY ? { weekday: 'short' } : { month: 'short', day: 'numeric' }).format(at)
  return `${day} ${time}`
}

/** "47m", "3h 54m", "2d 5h"; null once passed. */
export function formatResetIn(iso: string, now = Date.now()): string | null {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.max(1, Math.floor(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** Delay until the countdown label of any of `resets` changes (+1 ms), or null. */
export function nextCountdownTick(resets: readonly (string | null)[], now = Date.now()): number | null {
  let next: number | null = null
  for (const iso of resets) {
    const at = iso ? Date.parse(iso) : NaN
    if (!Number.isFinite(at) || at <= now) continue
    const remaining = at - now
    const unit = remaining >= DAY ? HOUR : MINUTE
    const delay = (remaining % unit) + 1
    next = next === null ? delay : Math.min(next, delay)
  }
  return next
}
