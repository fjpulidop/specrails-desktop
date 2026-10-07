import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { createSessionHostsRouter, type SessionHostsControl } from '../adapters/http'

function app(control: SessionHostsControl) {
  const server = express()
  server.use('/api/agent/session-hosts', createSessionHostsRouter(control))
  return server
}

describe('session hosts HTTP adapter', () => {
  it('lists scopes and retries a degraded one', async () => {
    let status = 'degraded'
    const control: SessionHostsControl = {
      hosts: () => [{ scope: 'acme', status: status as never, detail: status === 'degraded' ? 'locked' : null, code: status === 'degraded' ? 'journal_locked' : null }],
      retry: vi.fn(async () => { status = 'ready' }),
    }
    expect((await request(app(control)).get('/api/agent/session-hosts')).body).toEqual({ hosts: [{ scope: 'acme', status: 'degraded', detail: 'locked', code: 'journal_locked' }] })
    const retried = await request(app(control)).post('/api/agent/session-hosts/acme/retry')
    expect(retried.status).toBe(200)
    expect(retried.body.host).toMatchObject({ scope: 'acme', status: 'ready', code: null })
    expect(control.retry).toHaveBeenCalledWith('acme')
  })

  it('reports why a retry did not help and validates the scope', async () => {
    const control: SessionHostsControl = {
      hosts: () => [{ scope: 'acme', status: 'degraded', detail: 'still locked', code: 'journal_locked' }],
      retry: vi.fn(async () => { throw new Error('Another session host owns this scope') }),
    }
    const failed = await request(app(control)).post('/api/agent/session-hosts/acme/retry')
    expect(failed.status).toBe(502)
    expect(failed.body).toMatchObject({ error: 'Another session host owns this scope', host: { code: 'journal_locked' } })
    expect((await request(app(control)).post('/api/agent/session-hosts/..%2Fetc/retry')).status).toBe(400)
  })
})
