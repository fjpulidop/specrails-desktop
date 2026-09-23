import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { SettingsValidationError, type ProjectSettingsService } from '..'
import { registerProjectSettingsHttp } from '../adapters/http'

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
