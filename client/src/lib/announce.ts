// The single app-level screen-reader announcer (BB4). Anything that wants to say
// something politely calls `announce()`; the one `<LiveAnnouncer/>` region
// (components/LiveAnnouncer.tsx) speaks it. Two guards keep a busy app calm:
//  - dedupe: the same key within DEDUPE_MS is dropped (a state change that arrives
//    over two WebSocket paths is said once);
//  - throttle: messages are batched and flushed at most every THROTTLE_MS, and a
//    burst is capped at MAX_PER_FLUSH (the newest win).
// Sonner toasts (undo, errors) already live in their own polite region, so they
// are not routed through here: announcing them too would read them twice.

export const DEDUPE_MS = 4000
export const THROTTLE_MS = 1000
export const MAX_PER_FLUSH = 3

type Listener = (text: string) => void

export interface AnnouncerClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

const realClock: AnnouncerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface Announcer {
  announce: (text: string, key?: string) => void
  subscribe: (listener: Listener) => () => void
  reset: () => void
}

export function createAnnouncer(clock: AnnouncerClock = realClock): Announcer {
  const listeners = new Set<Listener>()
  const seen = new Map<string, number>()
  let queue: string[] = []
  let timer: unknown = null
  let lastFlush = -Infinity

  function flush(): void {
    timer = null
    if (queue.length === 0) return
    const batch = queue.slice(-MAX_PER_FLUSH)
    queue = []
    lastFlush = clock.now()
    const text = batch.join('. ')
    for (const l of listeners) l(text)
  }

  return {
    announce(text, key = text) {
      const trimmed = text.trim()
      if (!trimmed) return
      const now = clock.now()
      for (const [k, at] of seen) if (now - at >= DEDUPE_MS) seen.delete(k)
      if (seen.has(key)) return
      seen.set(key, now)
      queue.push(trimmed)
      if (timer !== null) return
      const wait = Math.max(0, THROTTLE_MS - (now - lastFlush))
      if (wait === 0) flush()
      else timer = clock.setTimer(flush, wait)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset() {
      if (timer !== null) clock.clearTimer(timer)
      timer = null
      queue = []
      seen.clear()
      lastFlush = -Infinity
    },
  }
}

/** The app singleton. */
export const announcer = createAnnouncer()
export const announce = announcer.announce
