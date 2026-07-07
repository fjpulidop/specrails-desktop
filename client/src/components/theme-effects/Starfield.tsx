import { useEffect, useRef } from 'react'

interface Star {
  x: number
  y: number
  radius: number
  alpha: number
  drift: number
}

const STAR_DENSITY = 0.00012
const MIN_STARS = 36
const MAX_STARS = 140
const DRIFT_MIN = 1.5
const DRIFT_MAX = 6

function makeStar(width: number, height: number): Star {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    radius: 0.35 + Math.random() * 1.25,
    alpha: 0.22 + Math.random() * 0.5,
    drift: DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN),
  }
}

function getCanvasSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  const width = rect.width || canvas.parentElement?.clientWidth || window.innerWidth
  const height = rect.height || canvas.parentElement?.clientHeight || window.innerHeight
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
}

export function Starfield() {
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

    let stars: Star[] = []
    let width = 0
    let height = 0
    let currentDpr = 0
    let rafId = 0
    let lastTime = 0
    let visible = !document.hidden

    function resize() {
      const size = getCanvasSize(canvas)
      const dpr = window.devicePixelRatio || 1
      // Nothing changed → skip (avoids resetting stars on every observer tick).
      if (size.width === width && size.height === height && dpr === currentDpr) return
      const dimsChanged = size.width !== width || size.height !== height
      width = size.width
      height = size.height
      currentDpr = dpr
      // Backing store must match the DISPLAYED CSS size 1:1, or the browser
      // upscales the canvas and stars render as fat, blurry dots. Round (not
      // floor) keeps it closest to the real container size.
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (dimsChanged || stars.length === 0) {
        const count = Math.min(MAX_STARS, Math.max(MIN_STARS, Math.floor(width * height * STAR_DENSITY)))
        stars = Array.from({ length: count }, () => makeStar(width, height))
      }
    }

    function draw(deltaSeconds: number) {
      ctx.clearRect(0, 0, width, height)
      for (const star of stars) {
        star.x += star.drift * deltaSeconds
        if (star.x > width + star.radius) {
          star.x = -star.radius
          star.y = Math.random() * height
        }
        ctx.globalAlpha = star.alpha
        ctx.fillStyle = 'hsl(213 100% 92%)'
        ctx.beginPath()
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    function tick(time: number) {
      if (!visible) return
      const deltaSeconds = lastTime === 0 ? 0.016 : Math.min(0.05, (time - lastTime) / 1000)
      lastTime = time
      draw(deltaSeconds)
      rafId = requestAnimationFrame(tick)
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

    // Re-arm a DPR listener each time it changes (matchMedia fires once per
    // threshold), so moving the window between monitors or zooming rebuilds the
    // backing store at the new pixel density instead of stretching.
    let dprMql: MediaQueryList | null = null
    function onDprChange() {
      if (dprMql) dprMql.removeEventListener('change', onDprChange)
      resize()
      watchDpr()
    }
    function watchDpr() {
      const dpr = window.devicePixelRatio || 1
      dprMql = window.matchMedia(`(resolution: ${dpr}dppx)`)
      dprMql.addEventListener('change', onDprChange)
    }

    resize()
    // The canvas lives in a bounded, position:relative container whose size
    // changes without a window resize (layout settling after mount, sidebar
    // toggles, panels). Observe the parent so the backing store always tracks
    // the real displayed size — the fix for "fat dots" in production.
    let ro: ResizeObserver | null = null
    const observed = canvas.parentElement
    if (typeof ResizeObserver !== 'undefined' && observed) {
      ro = new ResizeObserver(() => resize())
      ro.observe(observed)
    }
    window.addEventListener('resize', resize)
    watchDpr()
    document.addEventListener('visibilitychange', onVisibility)
    if (visible) rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      if (ro) ro.disconnect()
      if (dprMql) dprMql.removeEventListener('change', onDprChange)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: -1 }}
    />
  )
}
