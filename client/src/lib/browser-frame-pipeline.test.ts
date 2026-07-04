import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createFramePipeline,
  diffFrameStats,
  isBrowserPerfDebugEnabled,
  startFrameStatsReporter,
  type FramePipelineStats,
} from './browser-frame-pipeline'

/** Deterministic harness: decode resolves manually, paints run on manual ticks. */
function harness() {
  const decodes: Array<{ buf: ArrayBuffer; resolve: (b: string) => void; reject: (e: Error) => void }> = []
  const drawn: string[] = []
  const released: string[] = []
  const ticks: Array<() => void> = []
  let t = 0
  const pipeline = createFramePipeline<string>({
    decode: (buf) =>
      new Promise<string>((resolve, reject) => {
        decodes.push({ buf, resolve, reject })
      }),
    draw: (bmp) => { drawn.push(bmp) },
    release: (bmp) => { released.push(bmp) },
    schedule: (cb) => ticks.push(cb) && ticks.length,
    cancel: () => { /* ticks are manual */ },
    now: () => (t += 1),
  })
  const tick = () => {
    for (const cb of ticks.splice(0)) cb()
  }
  const buf = (label: string) => {
    const b = new ArrayBuffer(1)
    ;(b as unknown as { label: string }).label = label
    return b
  }
  return { pipeline, decodes, drawn, released, tick, buf }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createFramePipeline', () => {
  it('decodes and draws a frame on the next animation frame', async () => {
    const h = harness()
    h.pipeline.push(h.buf('f1'))
    expect(h.decodes).toHaveLength(1)
    h.decodes[0].resolve('bmp1')
    await flush()
    expect(h.drawn).toHaveLength(0) // paint waits for the frame tick
    h.tick()
    expect(h.drawn).toEqual(['bmp1'])
    expect(h.released).toEqual(['bmp1']) // drawn bitmaps are released after paint
    const s = h.pipeline.stats()
    expect(s).toMatchObject({ received: 1, decoded: 1, drawn: 1, droppedStale: 0, droppedUndrawn: 0 })
  })

  it('keeps only the NEWEST frame while a decode is in flight (latest-wins)', async () => {
    const h = harness()
    h.pipeline.push(h.buf('f1')) // decoding
    h.pipeline.push(h.buf('f2')) // pending
    h.pipeline.push(h.buf('f3')) // replaces f2 → f2 dropped stale
    h.pipeline.push(h.buf('f4')) // replaces f3 → f3 dropped stale
    expect(h.decodes).toHaveLength(1)

    h.decodes[0].resolve('bmp1')
    await flush()
    // The loop moved straight on to the newest pending frame (f4), not f2/f3.
    expect(h.decodes).toHaveLength(2)
    expect((h.decodes[1].buf as unknown as { label: string }).label).toBe('f4')

    h.decodes[1].resolve('bmp4')
    await flush()
    h.tick()
    // bmp1 was superseded before its paint → released undrawn; bmp4 painted.
    expect(h.drawn).toEqual(['bmp4'])
    expect(h.released).toContain('bmp1')
    const s = h.pipeline.stats()
    expect(s).toMatchObject({ received: 4, decoded: 2, drawn: 1, droppedStale: 2, droppedUndrawn: 1 })
  })

  it('survives a failing decode and continues with the next frame', async () => {
    const h = harness()
    h.pipeline.push(h.buf('bad'))
    h.pipeline.push(h.buf('good'))
    h.decodes[0].reject(new Error('bad jpeg'))
    await flush()
    expect(h.decodes).toHaveLength(2)
    h.decodes[1].resolve('bmp-good')
    await flush()
    h.tick()
    expect(h.drawn).toEqual(['bmp-good'])
  })

  it('a draw error is contained and the bitmap still released', async () => {
    const drawnAttempts: string[] = []
    const released: string[] = []
    const ticks: Array<() => void> = []
    const pipeline = createFramePipeline<string>({
      decode: async () => 'bmp',
      draw: (b) => { drawnAttempts.push(b); throw new Error('canvas gone') },
      release: (b) => released.push(b),
      schedule: (cb) => ticks.push(cb) && ticks.length,
      cancel: () => {},
    })
    pipeline.push(new ArrayBuffer(1))
    await flush()
    for (const cb of ticks.splice(0)) cb()
    expect(drawnAttempts).toEqual(['bmp'])
    expect(released).toEqual(['bmp'])
    expect(pipeline.stats().drawn).toBe(0)
  })

  it('dispose() releases the undrawn bitmap, cancels the paint and ignores pushes', async () => {
    const h = harness()
    h.pipeline.push(h.buf('f1'))
    h.decodes[0].resolve('bmp1')
    await flush()
    h.pipeline.dispose()
    expect(h.released).toEqual(['bmp1'])
    h.tick() // cancelled paint must not draw
    expect(h.drawn).toHaveLength(0)
    h.pipeline.push(h.buf('f2'))
    expect(h.decodes).toHaveLength(1) // no new decode after dispose
    h.pipeline.dispose() // idempotent
  })

  it('a bitmap resolving after dispose is released, never drawn', async () => {
    const h = harness()
    h.pipeline.push(h.buf('f1'))
    h.pipeline.dispose()
    h.decodes[0].resolve('bmp-late')
    await flush()
    expect(h.released).toEqual(['bmp-late'])
    expect(h.drawn).toHaveLength(0)
  })
})

describe('diffFrameStats', () => {
  const zero: FramePipelineStats = { received: 0, decoded: 0, drawn: 0, droppedStale: 0, droppedUndrawn: 0, decodeMsTotal: 0, drawMsTotal: 0 }

  it('computes fps and per-frame averages from deltas', () => {
    const cur: FramePipelineStats = { received: 60, decoded: 50, drawn: 40, droppedStale: 10, droppedUndrawn: 10, decodeMsTotal: 100, drawMsTotal: 80 }
    const d = diffFrameStats(zero, cur, 2000)
    expect(d).toEqual({ fpsReceived: 30, fpsDrawn: 20, droppedStale: 10, droppedUndrawn: 10, avgDecodeMs: 2, avgDrawMs: 2 })
  })

  it('avoids division by zero when nothing was decoded/drawn', () => {
    const d = diffFrameStats(zero, zero, 0)
    expect(d).toEqual({ fpsReceived: 0, fpsDrawn: 0, droppedStale: 0, droppedUndrawn: 0, avgDecodeMs: 0, avgDrawMs: 0 })
  })
})

describe('perf debug flag + reporter', () => {
  afterEach(() => {
    localStorage.removeItem('specrails-desktop:browser-capture-debug')
    vi.useRealTimers()
  })

  it('isBrowserPerfDebugEnabled reads the localStorage opt-in', () => {
    expect(isBrowserPerfDebugEnabled()).toBe(false)
    localStorage.setItem('specrails-desktop:browser-capture-debug', '1')
    expect(isBrowserPerfDebugEnabled()).toBe(true)
  })

  it('startFrameStatsReporter logs deltas per interval and stops cleanly', () => {
    vi.useFakeTimers()
    let received = 0
    const stats = (): FramePipelineStats => ({ received, decoded: 0, drawn: 0, droppedStale: 0, droppedUndrawn: 0, decodeMsTotal: 0, drawMsTotal: 0 })
    const logs: Array<{ fpsReceived: number }> = []
    const stop = startFrameStatsReporter(stats, (r) => logs.push(r), 1000, () => Date.now())

    received = 30
    vi.advanceTimersByTime(1000)
    expect(logs).toHaveLength(1)
    expect(logs[0].fpsReceived).toBeCloseTo(30, 0)

    stop()
    vi.advanceTimersByTime(3000)
    expect(logs).toHaveLength(1)
  })
})
