import { useEffect, useRef } from 'react'

/**
 * Code Rain decoration. Renders a viewport-sized `<canvas>` that paints
 * falling katakana glyphs whose alpha falls off with distance from recent
 * cursor positions, so the rain is only revealed in the cursor's wake.
 *
 * This component is *theme-specific* and is dispatched by
 * `ThemeEffectLayer` — it makes no theme decisions itself and never
 * branches on a theme identifier. To add an effect for a different theme,
 * create a sibling component and add it to the dispatcher's registry.
 *
 * Behaviour:
 *  - Position: fixed full-viewport, `z-index: -1` (behind app content).
 *  - `pointer-events: none` — never captures clicks.
 *  - Respects `prefers-reduced-motion`: when set, the component renders
 *    nothing at all (no canvas, no animation loop).
 *  - Pauses the animation loop while the document is hidden.
 *  - The current pointer position keeps a stable reveal spot — the rain
 *    keeps falling there for as long as the cursor stays inside the window.
 *  - Cursor echoes fade over `ECHO_TTL_MS` — only the trail behind a
 *    moving pointer dissipates; the stationary spot does not.
 */
const GLYPHS =
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEF'
const FONT_SIZE = 16
const COL_WIDTH = FONT_SIZE
const ROW_HEIGHT = FONT_SIZE * 1.1
const REVEAL_RADIUS = 180
const REVEAL_FALLOFF = 340
/** Rows-per-frame at 60fps. Slowed from the original draft per UX tuning —
 *  feels more like ambient drizzle than a downpour. */
const FALL_SPEED_MIN = 0.07
const FALL_SPEED_MAX = 0.22
const TAIL_LENGTH = 18
/** How long (ms) a recent cursor position keeps brightening glyphs. Older
 *  echoes fade linearly to zero so the trail dissipates after the user stops
 *  moving the pointer. */
const ECHO_TTL_MS = 600
/** Cap on stored echoes — pointermove fires fast, so we coalesce same-pixel
 *  samples and trim aggressively to bound the inner loop in tick(). */
const ECHO_MAX = 48
/** How often a column's glyphs randomly re-roll. Higher numbers feel calmer. */
const GLYPH_SWAP_MIN_MS = 160
const GLYPH_SWAP_VAR_MS = 360

interface Column {
  head: number
  speed: number
  glyphs: string[]
  nextSwapAt: number
}

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? ' '
}

function makeColumn(rowCount: number): Column {
  return {
    head: -Math.random() * Math.max(rowCount, 12),
    speed: FALL_SPEED_MIN + Math.random() * (FALL_SPEED_MAX - FALL_SPEED_MIN),
    glyphs: Array.from({ length: TAIL_LENGTH }, () => randomGlyph()),
    nextSwapAt: 0,
  }
}

export function CodeRainEffect() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvasEl = canvasRef.current
    if (!canvasEl) return
    const ctx2d = canvasEl.getContext('2d', { alpha: true })
    if (!ctx2d) return
    // Alias to non-null bindings so the inner closures (resize / tick) satisfy
    // strictNullChecks without repeated `!` assertions.
    const canvas: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = ctx2d

    let columns: Column[] = []
    // `current` is the cursor's live position — kept around indefinitely so
    // the reveal spot persists when the pointer stops moving. `echoes` is
    // the timestamped trail left behind by motion; only echoes age out.
    let current: { x: number; y: number } | null = null
    let echoes: { x: number; y: number; t: number }[] = []
    let rafId = 0
    let lastTime = 0
    let visible = !document.hidden

    function resize() {
      const dpr = window.devicePixelRatio || 1
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${FONT_SIZE}px "DM Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace`
      ctx.textBaseline = 'top'
      const colCount = Math.ceil(w / COL_WIDTH)
      const rowCount = Math.ceil(h / ROW_HEIGHT)
      // Preserve existing columns where possible so a resize doesn't reset
      // the animation. Append / truncate as needed.
      if (columns.length === 0) {
        columns = Array.from({ length: colCount }, () => makeColumn(rowCount))
      } else if (columns.length < colCount) {
        const extras = Array.from({ length: colCount - columns.length }, () => makeColumn(rowCount))
        columns = columns.concat(extras)
      } else if (columns.length > colCount) {
        columns = columns.slice(0, colCount)
      }
    }

    function onPointerMove(e: PointerEvent) {
      const now = performance.now()
      // Push the previous live position into the trail so it can fade out
      // while we move on. Skip when the delta is sub-pixel — coalescing
      // avoids burning through ECHO_MAX in one fast flick.
      if (current && (Math.abs(current.x - e.clientX) >= 2 || Math.abs(current.y - e.clientY) >= 2)) {
        echoes.push({ x: current.x, y: current.y, t: now })
        if (echoes.length > ECHO_MAX) echoes.splice(0, echoes.length - ECHO_MAX)
      }
      current = { x: e.clientX, y: e.clientY }
    }

    function onPointerLeaveWindow() {
      // Pointer left the viewport — let the trail fade naturally and stop
      // the persistent reveal at the last known location.
      current = null
    }

    function onVisibility() {
      visible = !document.hidden
      if (visible) {
        lastTime = 0
        rafId = requestAnimationFrame(tick)
      } else {
        cancelAnimationFrame(rafId)
      }
    }

    function tick(time: number) {
      if (!visible) return
      const dt = lastTime === 0 ? 1 : Math.min(2.5, (time - lastTime) / 16.67)
      lastTime = time
      const now = performance.now()
      // Drop expired echoes before the inner loop reads them.
      while (echoes.length > 0 && now - echoes[0]!.t > ECHO_TTL_MS) echoes.shift()
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)
      const rowCount = Math.ceil(h / ROW_HEIGHT)
      const hasReveal = current !== null || echoes.length > 0
      for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci]!
        col.head += col.speed * dt
        if (col.head - TAIL_LENGTH > rowCount + 4) {
          col.head = -Math.random() * 12
          col.speed = FALL_SPEED_MIN + Math.random() * (FALL_SPEED_MAX - FALL_SPEED_MIN)
        }
        if (time > col.nextSwapAt) {
          col.glyphs[Math.floor(Math.random() * TAIL_LENGTH)] = randomGlyph()
          col.nextSwapAt = time + GLYPH_SWAP_MIN_MS + Math.random() * GLYPH_SWAP_VAR_MS
        }
        if (!hasReveal) continue
        const colX = ci * COL_WIDTH + COL_WIDTH / 2
        // Quick reject: if neither the live cursor nor any echo is within
        // REVEAL_FALLOFF horizontally, the whole column draws nothing.
        let nearestDx = current !== null ? Math.abs(colX - current.x) : Infinity
        for (const e of echoes) {
          const d = Math.abs(colX - e.x)
          if (d < nearestDx) nearestDx = d
          if (nearestDx === 0) break
        }
        if (nearestDx > REVEAL_FALLOFF) continue
        for (let gi = 0; gi < TAIL_LENGTH; gi++) {
          const row = col.head - gi
          if (row < -1 || row > rowCount + 2) continue
          const glyphY = row * ROW_HEIGHT
          // Reveal alpha = max( spatial-only at live cursor, max-over-echoes
          // of spatial × temporal ). The live cursor never fades, so the
          // rain keeps falling under a stationary pointer; only the trail
          // behind a moving pointer dissipates.
          let revealAlpha = 0
          if (current !== null) {
            const dx = colX - current.x
            const dy = glyphY - current.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist <= REVEAL_FALLOFF) {
              const spatial =
                dist < REVEAL_RADIUS
                  ? 1
                  : 1 - (dist - REVEAL_RADIUS) / (REVEAL_FALLOFF - REVEAL_RADIUS)
              if (spatial > revealAlpha) revealAlpha = spatial
            }
          }
          if (revealAlpha < 0.999) {
            for (const e of echoes) {
              const dx = colX - e.x
              const dy = glyphY - e.y
              const dist = Math.sqrt(dx * dx + dy * dy)
              if (dist > REVEAL_FALLOFF) continue
              const spatial =
                dist < REVEAL_RADIUS
                  ? 1
                  : 1 - (dist - REVEAL_RADIUS) / (REVEAL_FALLOFF - REVEAL_RADIUS)
              const age = now - e.t
              const temporal = age > ECHO_TTL_MS ? 0 : 1 - age / ECHO_TTL_MS
              const a = spatial * temporal
              if (a > revealAlpha) revealAlpha = a
              if (revealAlpha >= 0.999) break
            }
          }
          if (revealAlpha < 0.02) continue
          const tailAlpha = 1 - gi / TAIL_LENGTH
          const alpha = revealAlpha * tailAlpha * 0.85
          if (alpha < 0.02) continue
          // Head glyph reads almost-white; tail fades through phosphor green.
          ctx.fillStyle =
            gi === 0
              ? `hsla(150, 100%, 92%, ${alpha.toFixed(3)})`
              : `hsla(144, 100%, 55%, ${alpha.toFixed(3)})`
          ctx.fillText(col.glyphs[gi]!, ci * COL_WIDTH, glyphY)
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointerMove)
    document.addEventListener('mouseleave', onPointerLeaveWindow)
    document.addEventListener('visibilitychange', onVisibility)
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('mouseleave', onPointerLeaveWindow)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // z-index: -1 inside #root's stacking context (see globals.css) lays the
  // canvas behind all app content but above the body background. The code-rain
  // theme also turns `.bg-background` transparent so opaque app wrappers
  // don't mask the canvas — only true panels (cards, rails) with their own
  // `bg-card` paint sit above the rain. pointer-events: none lets clicks
  // pass through to whatever is underneath.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: -1 }}
    />
  )
}
