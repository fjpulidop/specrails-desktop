import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { SettingsValidationError, type ProjectSettingsService } from '..'
import { registerEnvPassthroughStatusHttp, registerProjectSettingsHttp } from '../adapters/http'

afterEach(() => vi.restoreAllMocks())
describe('project settings HTTP error mapping', () => {
  it.each([
    [new SettingsValidationError('invalid setting'), 400, 'invalid setting'],
    [new Error('private storage detail'), 500, 'Failed to update settings'],
  ])('maps %s without exposing storage internals', async (error, status, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    app.use(express.json())
    const service: ProjectSettingsService = {
      getSettings: () => { throw new Error('not used') },
      updateSettings: () => { throw error },
    }
    registerProjectSettingsHttp(app, () => service)
    const response = await request(app).patch('/project/settings').send({})
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: message })
  })
})

describe('project settings HTTP observer', () => {
  it('reports committed changes with the previous settings, never failed ones', async () => {
    const app = express()
    app.use(express.json())
    let current = { allowSubagents: false } as unknown as ReturnType<ProjectSettingsService['getSettings']>
    const service: ProjectSettingsService = {
      getSettings: () => current,
      updateSettings: (input) => {
        if ((input as { allowSubagents?: unknown }).allowSubagents === 'bad') throw new SettingsValidationError('bad')
        current = { ...current, ...(input as object) }
        return current
      },
    }
    const observed: Array<[unknown, unknown]> = []
    registerProjectSettingsHttp(app, () => service, (_req, settings, previous) => observed.push([previous.allowSubagents, settings.allowSubagents]))
    expect((await request(app).patch('/p1/settings').send({ allowSubagents: true })).status).toBe(200)
    expect((await request(app).patch('/p1/settings').send({ allowSubagents: 'bad' })).status).toBe(400)
    expect(observed).toEqual([[false, true]])
  })

  it('keeps the response when an observer throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    app.use(express.json())
    const settings = { allowSubagents: true } as unknown as ReturnType<ProjectSettingsService['getSettings']>
    registerProjectSettingsHttp(app, () => ({ getSettings: () => settings, updateSettings: () => settings }), () => { throw new Error('observer down') })
    const response = await request(app).patch('/p1/settings').send({})
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
  })
})


describe('env passthrough status HTTP', () => {
  it('serves the status and the recheck from the bound port', async () => {
    const app = express()
    const calls: string[] = []
    registerEnvPassthroughStatusHttp(app, {
      read: async (req) => { calls.push(`read:${req.params.projectId}`); return { names: [{ name: 'NODE_AUTH_TOKEN', status: 'probe-timeout' }] } },
      recheck: async (req) => { calls.push(`recheck:${req.params.projectId}`); return { names: [{ name: 'NODE_AUTH_TOKEN', status: 'recovered' }] } },
    })
    const status = await request(app).get('/p1/env-passthrough/status')
    expect(status.body).toEqual({ names: [{ name: 'NODE_AUTH_TOKEN', status: 'probe-timeout' }] })
    const recheck = await request(app).post('/p1/env-passthrough/recheck')
    expect(recheck.body.names[0].status).toBe('recovered')
    expect(calls).toEqual(['read:p1', 'recheck:p1'])
  })

  it('maps port failures to a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    registerEnvPassthroughStatusHttp(app, {
      read: async () => { throw new Error('private detail') },
      recheck: async () => { throw new Error('private detail') },
    })
    const status = await request(app).get('/p1/env-passthrough/status')
    expect(status.status).toBe(500)
    expect(status.body).toEqual({ error: 'Failed to read environment status' })
    const recheck = await request(app).post('/p1/env-passthrough/recheck')
    expect(recheck.status).toBe(500)
    expect(recheck.body).toEqual({ error: 'Failed to recheck environment' })
  })
})
