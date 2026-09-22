import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMobileCodeRouter, relativeCodePath } from './mobile-code'

function appFor(json: unknown, status = 200) {
  const upstream = vi.fn(async () => ({ status, json }))
  const app = express().use(createMobileCodeRouter(upstream))
  return { app, upstream }
}
const base = '/projects/p1/repositories/r1/code'
describe('mobile code explorer', () => {
  it('returns only relative tree entries and strips internal metadata', async () => {
    const { app, upstream } = appFor({ entries: [{ path: 'src/main.ts', kind: 'file', sizeBytes: 42, secret: 'no' }, { path: '/Users/private/file' }, { path: '../private' }], nextCursor: 'next' })
    const result = await request(app).get(`${base}/tree?filter=secrets&limit=99999`)
    expect(result.body.entries).toEqual([{ relativePath: 'src/main.ts', kind: 'file', sizeBytes: 42 }])
    expect(upstream).toHaveBeenCalledWith('GET', '/api/projects/p1/repositories/r1/code/tree?filter=all&limit=200')
  })
  it('preserves exact source text but excludes unrelated metadata', async () => {
    const content = 'const url = "/api/projects/list"; // /Users/example/path\n'
    const { app, upstream } = appFor({ path: 'main.ts', content, fileHash: 'a'.repeat(64), cwd: '/private', token: 'secret', startLine: 201, nextLine: 401 })
    const result = await request(app).get(`${base}/file?path=main.ts&startLine=201&endLine=99999`)
    expect(result.body.content).toBe(content)
    expect(result.body.cwd).toBeUndefined()
    expect(result.body.token).toBeUndefined()
    expect(upstream.mock.calls[0][1]).toContain('endLine=400')
  })
  it.each(['../secret', '/etc/passwd', 'C:\\private', 'src/../secret', 'src//secret', 'src/./secret'])('rejects traversal and nonrelative paths: %s', async path => {
    const { app, upstream } = appFor({})
    expect((await request(app).get(`${base}/file`).query({ path })).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
    expect(relativeCodePath(path)).toBe(false)
  })
  it('preserves upstream denied-file status and sanitizes its errors', async () => {
    const { app } = appFor({ error: 'Denied /private/secret', path: '/private/secret' }, 403)
    const result = await request(app).get(`${base}/file?path=.env`)
    expect(result.status).toBe(403)
    expect(JSON.stringify(result.body)).not.toContain('/private')
  })
  it('rejects unexpected source paths and invalid paging hashes', async () => {
    const { app } = appFor({ path: 'other.ts', content: 'wrong file' })
    expect((await request(app).get(`${base}/file?path=main.ts`)).status).toBe(502)
    expect((await request(app).get(`${base}/file?path=main.ts&expectedHash=bad`)).status).toBe(400)
    expect((await request(app).get(`${base}/file?path=main.ts&startLine=-1`)).status).toBe(400)
  })
  it('does not expose edit or generation endpoints', async () => {
    const { app, upstream } = appFor({})
    expect((await request(app).post(`${base}/file`)).status).toBe(404)
    expect((await request(app).get(`${base}/file/story`)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})
