import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createDiagnostics } from './runtime'
import { createLogRing } from '../runtime/log-ring'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const TOKEN = 'f'.repeat(16) + '0123456789abcdef'

function setup(hostLogDir: string | null) {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE desktop_settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO desktop_settings (key, value) VALUES (?, ?)').run('external_mcp', JSON.stringify({ env: { OPENAI_API_KEY: 'sk-live' } }))
  db.prepare('INSERT INTO desktop_settings (key, value) VALUES (?, ?)').run('ui_language', 'es')
  const ring = createLogRing()
  ring.push('err', `request with X-Desktop-Token: ${TOKEN}\n`)
  const diagnostics = createDiagnostics({
    logRing: ring,
    probe: { snapshot: () => ({ thresholdMs: 200, sampling: false, sinceMs: 0, total: 1, longestMs: 900, recent: [{ atMs: 1, durationMs: 900, operation: 'GET /api/x', utilization: 1 }] }) },
    knownSecrets: () => [TOKEN],
    versions: async () => ({ app: '3.5.0', core: '4.2.0', api: 3, contractSchema: '1' }),
    desktopDb: () => db,
    projectCount: () => 4,
    hostLogDir,
  })
  const app = express()
  app.use(express.json())
  app.use('/api/diagnostics', diagnostics.router)
  return app
}

describe('diagnostics routes', () => {
  it('previews a redacted report and returns exactly those files as a ZIP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-diag-http-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'sidecar.log'), `t [OUT] hi\nt [ERR] crash token=${TOKEN}\n`)
    fs.writeFileSync(path.join(dir, 'desktop.log'), 't [sidecar] started pid 9\n')
    const app = setup(dir)
    const preview = await request(app).post('/api/diagnostics/report').expect(200)
    const files = preview.body.files as Array<{ name: string; content: string; bytes: number; description: string }>
    expect(files.map(f => f.name)).toEqual(['README.txt', 'system.json', 'settings.json', 'server.log', 'sidecar-stderr.log', 'desktop.log', 'crashes.json', 'stalls.json'])
    expect(JSON.stringify(files)).not.toContain(TOKEN)
    expect(JSON.stringify(files)).not.toContain('sk-live')
    expect(preview.body.fileName).toMatch(/^specrails-report-\d{8}-\d{6}\.zip$/)

    const zip = await request(app).get(`/api/diagnostics/report/${preview.body.id}/zip`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => done(null, Buffer.concat(chunks)))
    }).expect(200)
    expect(zip.headers['content-type']).toBe('application/zip')
    expect(zip.headers['content-disposition']).toContain(preview.body.fileName)
    const body = zip.body as Buffer
    expect(body.readUInt32LE(0)).toBe(0x04034b50)
    expect(body.readUInt16LE(body.length - 22 + 10)).toBe(files.length)
    for (const file of files) expect(body.includes(Buffer.from(file.content, 'utf8')), file.name).toBe(true)
    expect(body.includes(Buffer.from(TOKEN))).toBe(false)
  })

  it('answers 404 for an unknown or expired preview', async () => {
    await request(setup(null)).get('/api/diagnostics/report/nope/zip').expect(404)
  })

  it('lists and acknowledges crashes from the host folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-diag-http-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'crashes'))
    fs.writeFileSync(path.join(dir, 'crashes', 'crash-0000000001000-5.json'), JSON.stringify({ version: 1, id: '1000-5', atMs: 1000, pid: 5, exitCode: null, signal: 9, uptimeMs: 10, wasReady: true, outcome: 'restarted', recentRestarts: 1, maxRestarts: 3, windowSecs: 60, stderrTail: [`secret ${TOKEN}`] }))
    const app = setup(dir)
    const listed = await request(app).get('/api/diagnostics/crashes').expect(200)
    expect(listed.body).toMatchObject({ available: true, notices: [{ id: '1000-5', signal: 9, outcome: 'restarted' }] })
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN)
    await request(app).post('/api/diagnostics/crashes/ack').send({ throughMs: 1000 }).expect(200, { acknowledgedThroughMs: 1000 })
    expect((await request(app).get('/api/diagnostics/crashes')).body.notices).toEqual([])
  })

  it('reports the stall snapshot', async () => {
    const res = await request(setup(null)).get('/api/diagnostics/stalls').expect(200)
    expect(res.body).toMatchObject({ total: 1, longestMs: 900 })
  })
})
