import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { API_VERSION, API_VERSION_HEADER, apiVersionHeader } from './api-version'

/** Mirrors the server/index.ts mount order: header → public routes → auth → desktop → projects. */
function createApp() {
  const app = express()
  app.use('/api', apiVersionHeader)
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', apiVersion: API_VERSION }) })
  app.use('/api', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer t') { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  })
  const desktop = express.Router()
  desktop.get('/settings', (_req, res) => { res.json({ ok: true }) })
  app.use('/api', desktop)
  const projects = express.Router()
  projects.get('/:projectId/jobs', (_req, res) => { res.json({ jobs: [] }) })
  app.use('/api/projects', projects)
  app.get('/other', (_req, res) => { res.send('x') })
  return app
}

describe('X-Specrails-Api-Version', () => {
  it('stamps desktop, project-scoped, public, rejected and unknown /api routes', async () => {
    const app = createApp()
    const responses = await Promise.all([
      request(app).get('/api/health'),
      request(app).get('/api/settings').set('Authorization', 'Bearer t'),
      request(app).get('/api/projects/p1/jobs').set('Authorization', 'Bearer t'),
      request(app).get('/api/settings'),
      request(app).get('/api/nope').set('Authorization', 'Bearer t'),
    ])
    expect(responses.map(res => res.status)).toEqual([200, 200, 200, 401, 404])
    for (const res of responses) expect(res.headers[API_VERSION_HEADER.toLowerCase()]).toBe('1')
  })

  it('does not stamp non-API routes', async () => {
    const res = await request(createApp()).get('/other')
    expect(res.headers[API_VERSION_HEADER.toLowerCase()]).toBeUndefined()
  })

  it('is mounted in server/index.ts before every /api router and the auth guard', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    const header = source.indexOf("app.use('/api', apiVersionHeader)")
    expect(header).toBeGreaterThan(-1)
    for (const later of ["app.use('/api/host'", "'/api/mcp'", "app.get('/api/health'", "app.use('/api', requireAuth)", 'createDesktopRouter(registry', "app.use('/api/projects'"]) {
      const index = source.indexOf(later)
      expect(index, later).toBeGreaterThan(header)
    }
    expect(source).toContain("res.setHeader('Access-Control-Expose-Headers', API_VERSION_HEADER)")
    expect(source).toContain('apiVersion: API_VERSION')
  })
})
