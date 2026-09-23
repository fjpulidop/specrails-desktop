import { useEffect, useRef } from 'react'

/**
 * Blade cursor-trail decoration. Renders a viewport-sized `<canvas>`
 * that strokes a tapered, glowing polyline through recent pointer positions
 * — a thin blade-line trail, not a field of falling glyphs.
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
 *  - The trail fades naturally when the pointer stops moving or leaves the
 *    viewport — samples age out of the ring buffer after `SAMPLE_TTL_MS`.
 */
const SAMPLE_MAX = 24
const SAMPLE_TTL_MS = 200
const HEAD_LINE_WIDTH = 3.5
const SHADOW_BLUR = 10
const BLADE_CORE_COLOR = 'hsl(210, 60%, 96%)'
const BLADE_GLOW_COLOR = 'hsl(212, 100%, 62%)'

interface Sample {
  x: number
  y: number
  t: number
}

export function BladeTrail() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvasEl = canvasRef.current
    if (!canvasEl) return
    const ctx2d = canvasEl.getContext('2d', { alpha: true })
    if (!ctx2d) return
    const canvas: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = ctx2d

    let samples: Sample[] = []
    let rafId = 0
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
    }

    function onPointerMove(e: PointerEvent) {
      const now = performance.now()
      samples.push({ x: e.clientX, y: e.clientY, t: now })
      if (samples.length > SAMPLE_MAX) samples.splice(0, samples.length - SAMPLE_MAX)
    }

    function onPointerLeaveWindow() {
      samples = []
    }

    function onVisibility() {
      visible = !document.hidden
      if (visible) {
        rafId = requestAnimationFrame(tick)
      } else {
        cancelAnimationFrame(rafId)
      }
    }

    function tick() {
      if (!visible) return
      const now = performance.now()
      while (samples.length > 0 && now - samples[0]!.t > SAMPLE_TTL_MS) samples.shift()
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)

      if (samples.length >= 2) {
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.shadowColor = BLADE_GLOW_COLOR
        for (let i = 1; i < samples.length; i++) {
          const prev = samples[i - 1]!
          const cur = samples[i]!
          const age = now - cur.t
          const life = Math.max(0, 1 - age / SAMPLE_TTL_MS)
          if (life <= 0) continue
          const headFraction = i / samples.length
          ctx.globalAlpha = life * (0.25 + 0.75 * headFraction)
          ctx.lineWidth = Math.max(0.5, HEAD_LINE_WIDTH * headFraction)
          ctx.shadowBlur = SHADOW_BLUR * headFraction
          ctx.strokeStyle = headFraction > 0.6 ? BLADE_CORE_COLOR : BLADE_GLOW_COLOR
          ctx.beginPath()
          ctx.moveTo(prev.x, prev.y)
          ctx.lineTo(cur.x, cur.y)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        ctx.shadowBlur = 0
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

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: -1 }}
    />
  )
}
