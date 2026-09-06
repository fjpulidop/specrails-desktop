import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { resolveWebDevPorts } from './dev-ports'
import { apiNotFound } from './api-not-found'

async function listen(server: Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
}

describe('development API routing', () => {
  it('targets the IPv4 API when another frontend occupies the same port on IPv6', async () => {
    let apiRequests = 0
    let otherRequests = 0
    const api = createServer((_req, res) => { apiRequests++; res.setHeader('Content-Type', 'application/json'); res.end('{"accepted":true,"queued":false}') })
    const otherFrontend = createServer((_req, res) => { otherRequests++; res.setHeader('Content-Type', 'text/html'); res.end('<!DOCTYPE html><title>Other frontend</title>') })
    try {
      const port = await listen(api, '127.0.0.1')
      await listen(otherFrontend, '::1', port)
      const ports = resolveWebDevPorts({ SPECRAILS_PORT: String(port), SPECRAILS_DEV_CLIENT_PORT: String(port === 4201 ? 4202 : 4201) })
      const response = await fetch(`${ports.serverOrigin}/api/agent/conversations/fixture/send`, { method: 'POST', body: '{}' })
      expect(await response.json()).toEqual({ accepted: true, queued: false })
      expect(apiRequests).toBe(1)
      expect(otherRequests).toBe(0)
      // Prove that the very same numeric port hosts a different service on ::1.
      expect(await (await fetch(`http://[::1]:${port}/api/agent/conversations`)).text()).toContain('<!DOCTYPE html>')
      expect(otherRequests).toBe(1)
    } finally { await Promise.all([close(api), close(otherFrontend)]) }
  })

  it('keeps unknown API and hook routes JSON without replacing real routes or SPA pages', async () => {
    const app = express()
    app.get('/api/health', (_req, res) => res.json({ ok: true }))
    app.use(['/api', '/hooks'], apiNotFound)
    app.get('/mission', (_req, res) => res.type('html').send('<!DOCTYPE html>'))
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true })
    for (const response of await Promise.all([request(app).get('/api/missing'), request(app).post('/api/agent/unavailable/send'), request(app).post('/hooks/missing')])) {
      expect(response.status).toBe(404)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.body).toEqual({ error: 'api_route_not_found' })
    }
    expect((await request(app).get('/mission')).text).toContain('<!DOCTYPE html>')
  })
})
