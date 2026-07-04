// Latest-frame-wins decode + draw pipeline for the embedded-browser screencast.
//
// JPEG frames arrive over the dedicated /ws/browser socket faster than a busy
// main thread can decode + paint them. The old client path dropped whichever
// frame arrived while a decode was in flight — i.e. it dropped the NEWEST frame
// and kept showing the older one, so under load the canvas fell progressively
// behind reality (perceived sluggishness). This pipeline inverts that policy:
//
//  - only the newest undecoded frame is kept (intermediates are dropped);
//  - decodes run back-to-back (createImageBitmap is off-main-thread);
//  - paints are coalesced onto animation frames, drawing only the newest
//    decoded bitmap (an undrawn bitmap superseded before its rAF is released).
//
// Every dependency (decode, draw, scheduler, clock) is injected so the drop /
// coalescing logic is fully unit-testable under jsdom (which can't decode JPEG).

export interface FramePipelineStats {
  /** Frames pushed into the pipeline. */
  received: number
  /** Frames successfully decoded. */
  decoded: number
  /** Bitmaps painted onto the canvas. */
  drawn: number
  /** Frames replaced by a newer one before their decode started. */
  droppedStale: number
  /** Decoded bitmaps replaced by a newer one before they were drawn. */
  droppedUndrawn: number
  /** Cumulative decode time (ms) across `decoded` frames. */
  decodeMsTotal: number
  /** Cumulative draw time (ms) across `drawn` frames. */
  drawMsTotal: number
}

export interface FramePipeline {
  /** Feed a binary frame (a complete JPEG). Never throws. */
  push(buf: ArrayBuffer): void
  /** Cumulative counters since creation (snapshot copy). */
  stats(): FramePipelineStats
  /** Cancel scheduled work and release any undrawn bitmap. */
  dispose(): void
}

export interface FramePipelineOptions<TBitmap> {
  /** Decode a frame (createImageBitmap in production). */
  decode: (buf: ArrayBuffer) => Promise<TBitmap>
  /** Paint a decoded frame (canvas drawImage in production). */
  draw: (bitmap: TBitmap) => void
  /** Free a bitmap that will never be drawn (bitmap.close in production). */
  release?: (bitmap: TBitmap) => void
  /** Paint scheduler — defaults to requestAnimationFrame. */
  schedule?: (cb: () => void) => number
  cancel?: (id: number) => void
  /** Clock for the decode/draw timings — defaults to performance.now. */
  now?: () => number
}

export function createFramePipeline<TBitmap>(opts: FramePipelineOptions<TBitmap>): FramePipeline {
  const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancel = opts.cancel ?? ((id: number) => cancelAnimationFrame(id))
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const release = opts.release ?? (() => {})

  const stats: FramePipelineStats = {
    received: 0,
    decoded: 0,
    drawn: 0,
    droppedStale: 0,
    droppedUndrawn: 0,
    decodeMsTotal: 0,
    drawMsTotal: 0,
  }

  let disposed = false
  let decoding = false
  /** Newest frame not yet picked up by the decode loop. */
  let pendingBuf: ArrayBuffer | null = null
  /** Newest decoded bitmap awaiting its animation-frame paint. */
  let latestBitmap: TBitmap | null = null
  let scheduledId: number | null = null

  const paint = () => {
    scheduledId = null
    const bitmap = latestBitmap
    latestBitmap = null
    if (bitmap == null || disposed) {
      if (bitmap != null) safeRelease(bitmap)
      return
    }
    const t0 = now()
    try {
      opts.draw(bitmap)
      stats.drawn++
      stats.drawMsTotal += now() - t0
    } catch {
      /* a bad draw must never break the stream */
    } finally {
      safeRelease(bitmap)
    }
  }

  const safeRelease = (bitmap: TBitmap) => {
    try { release(bitmap) } catch { /* ignore */ }
  }

  const schedulePaint = () => {
    if (scheduledId == null && !disposed) scheduledId = schedule(paint)
  }

  const decodeLoop = (buf: ArrayBuffer) => {
    decoding = true
    const t0 = now()
    opts.decode(buf).then(
      (bitmap) => {
        if (disposed) {
          safeRelease(bitmap)
          return
        }
        stats.decoded++
        stats.decodeMsTotal += now() - t0
        if (latestBitmap != null) {
          // A prior decoded frame was never drawn — superseded, release it.
          stats.droppedUndrawn++
          safeRelease(latestBitmap)
        }
        latestBitmap = bitmap
        schedulePaint()
        continueLoop()
      },
      () => {
        // Bad frame — drop it and move on to whatever is pending.
        continueLoop()
      },
    )
  }

  const continueLoop = () => {
    if (disposed) { decoding = false; return }
    const next = pendingBuf
    pendingBuf = null
    if (next != null) decodeLoop(next)
    else decoding = false
  }

  return {
    push(buf: ArrayBuffer) {
      if (disposed) return
      stats.received++
      if (decoding) {
        // Newest-wins: replace (don't queue behind) any frame still waiting.
        if (pendingBuf != null) stats.droppedStale++
        pendingBuf = buf
        return
      }
      decodeLoop(buf)
    },
    stats() {
      return { ...stats }
    },
    dispose() {
      if (disposed) return
      disposed = true
      pendingBuf = null
      if (scheduledId != null) {
        try { cancel(scheduledId) } catch { /* ignore */ }
        scheduledId = null
      }
      if (latestBitmap != null) {
        safeRelease(latestBitmap)
        latestBitmap = null
      }
    },
  }
}

// ─── Dev-only perf probe ──────────────────────────────────────────────────────

const DEBUG_KEY = 'specrails-desktop:browser-capture-debug'

/** True when the user opted into the screencast perf probe by setting
 *  `localStorage['specrails-desktop:browser-capture-debug'] = '1'`. */
export function isBrowserPerfDebugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

export interface FrameStatsReport {
  fpsReceived: number
  fpsDrawn: number
  droppedStale: number
  droppedUndrawn: number
  avgDecodeMs: number
  avgDrawMs: number
}

/** Compute the per-interval delta report between two cumulative snapshots. */
export function diffFrameStats(prev: FramePipelineStats, cur: FramePipelineStats, elapsedMs: number): FrameStatsReport {
  const dt = Math.max(1, elapsedMs)
  const decodedDelta = cur.decoded - prev.decoded
  const drawnDelta = cur.drawn - prev.drawn
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    fpsReceived: round1(((cur.received - prev.received) * 1000) / dt),
    fpsDrawn: round1((drawnDelta * 1000) / dt),
    droppedStale: cur.droppedStale - prev.droppedStale,
    droppedUndrawn: cur.droppedUndrawn - prev.droppedUndrawn,
    avgDecodeMs: decodedDelta > 0 ? round1((cur.decodeMsTotal - prev.decodeMsTotal) / decodedDelta) : 0,
    avgDrawMs: drawnDelta > 0 ? round1((cur.drawMsTotal - prev.drawMsTotal) / drawnDelta) : 0,
  }
}

/** Periodically log the frame-pipeline deltas (console.table by default).
 *  Returns a stop function. Only ever started when the debug flag is on. */
export function startFrameStatsReporter(
  stats: () => FramePipelineStats,
  log: (report: FrameStatsReport) => void = (report) => console.table([report]),
  intervalMs = 2000,
  now: () => number = () => Date.now(),
): () => void {
  let prev = stats()
  let prevAt = now()
  const id = setInterval(() => {
    const cur = stats()
    const at = now()
    log(diffFrameStats(prev, cur, at - prevAt))
    prev = cur
    prevAt = at
  }, intervalMs)
  return () => clearInterval(id)
}
