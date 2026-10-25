import { describe, it, expect, beforeEach } from 'vitest'
import { createAnnouncer, DEDUPE_MS, THROTTLE_MS, MAX_PER_FLUSH, type AnnouncerClock } from '../announce'

function fakeClock() {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let seq = 0
  const clock: AnnouncerClock = {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
  }
  const advance = (ms: number) => {
    now += ms
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
  }
  return { clock, advance }
}

describe('announcer', () => {
  let heard: string[]
  let fc: ReturnType<typeof fakeClock>
  let a: ReturnType<typeof createAnnouncer>
  beforeEach(() => {
    heard = []
    fc = fakeClock()
    a = createAnnouncer(fc.clock)
    a.subscribe((t) => heard.push(t))
  })

  it('speaks the first message at once', () => {
    a.announce('Run started')
    expect(heard).toEqual(['Run started'])
  })

  it('drops the same key inside the dedupe window and repeats it after', () => {
    a.announce('Run finished', 'finished:1')
    fc.advance(THROTTLE_MS + 1)
    a.announce('Run finished', 'finished:1')
    expect(heard).toEqual(['Run finished'])
    fc.advance(DEDUPE_MS)
    a.announce('Run finished', 'finished:1')
    expect(heard).toEqual(['Run finished', 'Run finished'])
  })

  it('throttles a burst into one batch, newest messages kept', () => {
    a.announce('one', 'k1')
    for (let i = 2; i <= 6; i++) a.announce(`m${i}`, `k${i}`)
    expect(heard).toEqual(['one'])
    fc.advance(THROTTLE_MS)
    expect(heard).toHaveLength(2)
    expect(heard[1].split('. ')).toHaveLength(MAX_PER_FLUSH)
    expect(heard[1].endsWith('m6')).toBe(true)
  })

  it('ignores blank messages and stops after reset', () => {
    a.announce('   ')
    expect(heard).toEqual([])
    a.announce('a', 'k')
    a.announce('b', 'k2')
    a.reset()
    fc.advance(THROTTLE_MS * 2)
    expect(heard).toEqual(['a'])
  })
})
