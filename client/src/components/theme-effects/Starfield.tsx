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
    let width = 1
    let height = 1
    let rafId = 0
    let lastTime = 0
    let visible = !document.hidden

    function resize() {
      const size = getCanvasSize(canvas)
      width = size.width
      height = size.height
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(MAX_STARS, Math.max(MIN_STARS, Math.floor(width * height * STAR_DENSITY)))
      stars = Array.from({ length: count }, () => makeStar(width, height))
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

    resize()
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibility)
    if (visible) rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
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
