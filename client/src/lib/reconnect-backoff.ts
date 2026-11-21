/**
 * Reconnect schedule for the app's shared WebSocket: exponential steps, then a
 * 30 s cap, each shortened by a random jitter of up to 20 %. Without jitter
 * every window (main, surface, loop and mission windows each own a socket)
 * reconnects in lockstep after a server freeze or restart. Jitter only ever
 * shortens a step, so no reconnect waits longer than the plain schedule.
 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
export const RECONNECT_BACKOFF_CAP_MS = 30000
export const RECONNECT_JITTER_RATIO = 0.2

/** Delay before reconnect attempt `attempt` (0-based). `random` returns [0, 1). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = RECONNECT_BACKOFF_MS[attempt] ?? RECONNECT_BACKOFF_CAP_MS
  const r = Math.min(Math.max(random(), 0), 1)
  return Math.round(base * (1 - RECONNECT_JITTER_RATIO * r))
}
