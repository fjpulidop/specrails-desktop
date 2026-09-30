import express from 'express'
import request from 'supertest'
import { it, expect, vi } from 'vitest'
import { registerUsageRoutes } from './http'
import { createUsageService } from '../runtime/usage-service'
it('desktop usage routes validate targets and GET never invokes collection', async () => {
  const read = vi.fn(), context = vi.fn(), installed = vi.fn().mockResolvedValue(false)
  const service = createUsageService({ installed, readers: { claude: { read, context }, codex: { read, context } } })
  const app = express(), router = express.Router(); app.use(express.json()); registerUsageRoutes(router, service); app.use('/api', router)
  expect((await request(app).get('/api/subscription-usage')).body.scope).toBe('machine')
  expect(installed).not.toHaveBeenCalled()
  for (const body of [{ providerId: 'cursor' }, { credentialPath: '/secret' }, [], { automatic: 'true' }]) expect((await request(app).post('/api/subscription-usage/refresh').send(body)).status).toBe(400)
  expect((await request(app).post('/api/subscription-usage/refresh').send({})).status).toBe(202)
  await service.settled(); expect(read).not.toHaveBeenCalled()
})
