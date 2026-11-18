/**
 * Today on this machine (the person's clock): local midnight to the next one,
 * as UTC ISO instants, for `started_at >= from AND started_at < to` filters.
 * Spend caps, analytics and every "today" KPI share this basis; a UTC
 * `toISOString().slice(0, 10)` day disagreed with them for everyone off UTC.
 */
export function localDayWindow(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}
