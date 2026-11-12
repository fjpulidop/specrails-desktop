export function formatElapsed(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) : 0
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
