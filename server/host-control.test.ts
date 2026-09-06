import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { consumeHostControlToken, createHostControlRouter } from './host-control'

const token = 'a'.repeat(64)
function fixture(onShutdown = vi.fn(), secret: string | undefined = token) {
  const app = express()
  app.use('/api/host', createHostControlRouter({ token: secret, onShutdown, pid: 456 }))
  return { app, onShutdown }
}

describe('private host shutdown', () => {
  it('consumes all case variants before child environments can inherit the capability', () => {
    const env = { SPECRAILS_HOST_CONTROL_TOKEN: token, specrails_host_control_token: token, PATH: 'kept' }
    expect(consumeHostControlToken(env)).toBe(token)
    expect(env).toEqual({ PATH: 'kept' })
    const invalid = { SPECRAILS_HOST_CONTROL_TOKEN: 'short' }
    expect(consumeHostControlToken(invalid)).toBeUndefined()
    expect(invalid).toEqual({})
  })

  it('acknowledges the owned PID and invokes graceful shutdown once across retries', async () => {
    let release!: () => void
    const onShutdown = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { app } = fixture(onShutdown)
    const first = await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', token)
    expect(first.status).toBe(202)
    expect(first.body).toEqual({ ok: true, pid: 456 })
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledOnce())
    expect((await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', token)).status).toBe(202)
    expect(onShutdown).toHaveBeenCalledOnce()
    release()
  })

  it('rejects renderer-origin and wrong-token calls without starting shutdown', async () => {
    const { app, onShutdown } = fixture()
    for (const supplied of ['', 'b'.repeat(64), 'desktop-token']) {
      expect((await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', supplied)).status).toBe(403)
    }
    expect((await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', token)
      .set('Origin', 'http://localhost:4200')).status).toBe(403)
    expect(onShutdown).not.toHaveBeenCalled()
  })

  it('is unavailable in ordinary development servers without a host capability', async () => {
    const app = express()
    const onShutdown = vi.fn()
    app.use('/api/host', createHostControlRouter({ onShutdown }))
    expect((await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', token)).status).toBe(404)
    expect(onShutdown).not.toHaveBeenCalled()
  })

  it('reports teardown failure without leaking the capability or rejecting after the ACK', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { app } = fixture(vi.fn(() => { throw new Error(token) }))
      expect((await request(app).post('/api/host/shutdown').set('X-Specrails-Host-Token', token)).status).toBe(202)
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[host-control] graceful shutdown failed'))
      expect(JSON.stringify(log.mock.calls)).not.toContain(token)
    } finally { log.mockRestore() }
  })
})
