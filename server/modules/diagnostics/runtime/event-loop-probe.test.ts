import express from 'express'
import request from 'supertest'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { createEventLoopProbe, operationTiming, type EventLoopProbe } from './event-loop-probe'

const probes: EventLoopProbe[] = []
function probe(options: Parameters<typeof createEventLoopProbe>[0] = {}) {
  const created = createEventLoopProbe({ log: () => {}, ...options })
  probes.push(created)
  return created
}
afterEach(() => { for (const p of probes.splice(0)) p.stop() })

function block(ms: number) {
  const until = performance.now() + ms
  while (performance.now() < until) { /* busy */ }
}

describe('event-loop stall probe', () => {
  it('records a late tick as a stall and ignores an on-time one', () => {
    const p = probe({ tickMs: 1000, thresholdMs: 200 })
    p.start()
    const base = performance.now()
    p.tick(base + 1000 + 50)
    expect(p.snapshot().total).toBe(0)
    p.tick(base + 2050 + 1000 + 700)
    const snapshot = p.snapshot()
    expect(snapshot.total).toBe(1)
    expect(snapshot.recent[0].durationMs).toBeGreaterThanOrEqual(690)
    expect(snapshot.longestMs).toBe(snapshot.recent[0].durationMs)
  })

  it('measures a real synchronous block and names the request that caused it', async () => {
    const p = probe({ tickMs: 50, thresholdMs: 150, quietTicksToDisarm: 1000 })
    const app = express()
    app.use(operationTiming(p))
    app.get('/api/projects/:id/slow', (_req, res) => { block(400); res.json({ ok: true }) })
    p.start()
    await request(app).get('/api/projects/0b7c1f9e-1d2a-4c3b-9a8b-112233445566/slow?x=1').expect(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    const stall = p.snapshot().recent.find(s => s.durationMs >= 150)
    expect(stall).toBeDefined()
    expect(stall?.durationMs).toBeGreaterThanOrEqual(250)
    expect(stall?.operation).toBe('GET /api/projects/:id/slow')
  })

  it('samples only while busy and disarms after quiet ticks', () => {
    const load = [0.6, 0.01, 0.01]
    const p = probe({ tickMs: 1000, busyUtilization: 0.05, quietTicksToDisarm: 2, utilization: () => load.shift() ?? 0 })
    p.start()
    expect(p.snapshot().sampling).toBe(false)
    let t = performance.now()
    p.tick(t += 1000)
    expect(p.snapshot().sampling).toBe(true)
    p.tick(t += 1000)
    expect(p.snapshot().sampling).toBe(true)
    p.tick(t += 1000)
    expect(p.snapshot().sampling).toBe(false)
  })

  it('rate-limits stall log lines and counts the ones it skipped', () => {
    const lines: string[] = []
    const p = probe({ tickMs: 1000, thresholdMs: 100, logIntervalMs: 10_000, log: line => lines.push(line) })
    p.start()
    let t = performance.now()
    for (let i = 0; i < 3; i++) { t += 1000 + 500; p.tick(t) }
    t += 20_000
    p.tick(t)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[event-loop\] stall of \d+ ms$/)
    expect(lines[1]).toContain('+2 more')
  })

  it('ignores fast requests', () => {
    const noted: string[] = []
    const middleware = operationTiming({ noteOperation: label => noted.push(label) })
    middleware({ method: 'GET', originalUrl: '/api/x' } as express.Request, {} as express.Response, () => {})
    expect(noted).toEqual([])
  })
})
