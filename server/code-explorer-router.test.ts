import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, execFileSync } from 'child_process'
import { initDb, type DbInstance } from './db'
import { createCodeExplorerRouter, rankFindMatches } from './code-explorer-router'
import {
  writeSummary,
  CURRENT_PROMPT_VERSION,
  computeFileHash,
  summaryFilePath,
} from './file-summary-manager'

async function storeSummary(rel: string, fileHash: string): Promise<void> {
  writeSummary(projectPath, rel, {
    schemaVersion: 1,
    path: rel,
    fileHash,
    summary: 'A summary.',
    language: 'en',
    generatedAt: '2026-05-22T00:00:00.000Z',
    generatedBy: { model: 'claude-haiku-4-5', promptVersion: CURRENT_PROMPT_VERSION },
    triggeredBy: { kind: 'user', id: 'manual', ticketId: null },
  })
}

let projectPath: string
let db: DbInstance
let app: express.Express
let enqueueSpy: ReturnType<typeof vi.fn>
let attachWatcherSpy: ReturnType<typeof vi.fn>

function mountApp(provider = 'claude'): void {
  app = express()
  app.use(express.json())
  enqueueSpy = vi.fn(async () => 'enqueued' as const)
  attachWatcherSpy = vi.fn()
  const router = createCodeExplorerRouter({
    db,
    projectPath,
    projectId: 'proj-test',
    broadcast: vi.fn(),
    fileSummaryManager: {
      enqueue: enqueueSpy as never,
      attachWatcher: attachWatcherSpy as never,
    },
    aiTransformProvider: provider,
  })
  app.use('/api/projects/proj-test/code', router)
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'code-explorer-router-'))
  db = initDb(':memory:')
  delete process.env.SPECRAILS_CODE_EXPLORER
  mountApp()
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  db.close()
  delete process.env.SPECRAILS_CODE_EXPLORER
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('feature-flag gating', () => {
  it('returns 404 on every route when SPECRAILS_CODE_EXPLORER=false', async () => {
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    const routes = ['/tree', '/find?q=foo', '/search?q=foo', '/file?path=foo.ts', '/summary?path=foo.ts', '/provenance?ticketId=1', '/diff?jobId=j1&path=foo.ts']
    for (const r of routes) {
      const res = await request(app).get(`/api/projects/proj-test/code${r}`)
      expect(res.status).toBe(404)
    }
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /file', () => {
  it.skipIf(process.platform === 'win32')('rejects named pipes without waiting for a writer', async () => {
    execFileSync('mkfifo', [path.join(projectPath, 'input.pipe')])
    const response = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'input.pipe', startLine: 1 }).timeout(1000)
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('path is not a regular file')
  })

  it('returns bounded line pages with a hash while keeping the editor full-file response', async () => {
    const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n')
    fs.writeFileSync(path.join(projectPath, 'pages.ts'), content)
    const first = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'pages.ts', startLine: 1 })
    expect(first.status).toBe(200)
    expect(first.body.content.split('\n')).toHaveLength(200)
    expect(first.body).toMatchObject({ startLine: 1, endLine: 200, totalLines: 600, nextLine: 201, nextColumn: 1, truncated: true })
    expect(first.body.fileHash).toMatch(/^[a-f0-9]{64}$/)
    const last = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'pages.ts', startLine: first.body.nextLine, endLine: 10000, expectedHash: first.body.fileHash })
    expect(last.body.content.split('\n')).toHaveLength(400)
    expect(last.body).toMatchObject({ endLine: 600, nextLine: null, truncated: false, fileHash: first.body.fileHash })
    const capped = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'pages.ts', startLine: 1, endLine: 600 })
    expect(capped.body.content.split('\n')).toHaveLength(500)
    expect(capped.body.nextLine).toBe(501)
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'pages.ts' })).body.content).toBe(content)
  })

  it('paginates minified long lines without dropping content and refuses changed-file continuation', async () => {
    const content = `${'a'.repeat(25000)}tail`
    const file = path.join(projectPath, 'min.js')
    fs.writeFileSync(file, content)
    const first = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'min.js', startLine: 1 })
    expect(first.body.content).toHaveLength(20000)
    expect(first.body).toMatchObject({ nextLine: 1, nextColumn: 20001, truncationReason: 'character-limit' })
    const continuation = { path: 'min.js', startLine: first.body.nextLine, startColumn: first.body.nextColumn, expectedHash: first.body.fileHash }
    const second = await request(app).get('/api/projects/proj-test/code/file').query(continuation)
    expect(first.body.content + second.body.content).toBe(content)
    expect(second.body.nextLine).toBeNull()
    fs.writeFileSync(file, 'changed')
    const changed = await request(app).get('/api/projects/proj-test/code/file').query(continuation)
    expect(changed.status).toBe(409)
    expect(changed.body.error).toBe('file_changed')
    expect(changed.body).not.toHaveProperty('content')
  })

  it('does not exceed its character budget when a complete line exactly fills the page', async () => {
    fs.writeFileSync(path.join(projectPath, 'edge.js'), `${'x'.repeat(20000)}\nnext`)
    const first = await request(app).get('/api/projects/proj-test/code/file').query({ path: 'edge.js', startLine: 1 })
    expect(first.body.content).toHaveLength(20000)
    expect(first.body).toMatchObject({ nextLine: 2, nextColumn: 1 })
  })

  it('returns real errors for paged missing, binary, oversized and invalid-range reads', async () => {
    fs.writeFileSync(path.join(projectPath, 'blob.bin'), Buffer.from([0, 1]))
    fs.writeFileSync(path.join(projectPath, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    fs.writeFileSync(path.join(projectPath, 'one.ts'), 'line one')
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'missing.ts', startLine: 1 })).status).toBe(404)
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'blob.bin', startLine: 1 })).status).toBe(415)
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'big.txt', startLine: 1 })).status).toBe(413)
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'one.ts', startLine: 2 })).status).toBe(416)
    expect((await request(app).get('/api/projects/proj-test/code/file').query({ path: 'one.ts', startLine: 3, endLine: 2 })).status).toBe(400)
  })

  it('returns content + language for a small text file', async () => {
    fs.writeFileSync(path.join(projectPath, 'hello.ts'), 'export const x = 1\n', 'utf8')
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('hello.ts', 12, 'job-a', 'modified', 1000)
    const res = await request(app).get('/api/projects/proj-test/code/file?path=hello.ts')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const x = 1\n')
    expect(res.body.language).toBe('typescript')
    expect(res.body.encoding).toBe('utf-8')
    expect(res.body.summary).toBeNull()
    expect(res.body.summaryStale).toBe(false)
    expect(res.body.provenance).toEqual([
      { path: 'hello.ts', ticketId: 12, jobId: 'job-a', kind: 'modified', at: 1000 },
    ])
  })

  it('refuses path traversal with 400', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/file?path=../../etc/passwd')
    expect(res.status).toBe(400)
  })

  it('rejects absolute paths', async () => {
    const res = await request(app).get(
      `/api/projects/proj-test/code/file?path=${encodeURIComponent('/etc/passwd')}`,
    )
    expect(res.status).toBe(400)
  })

  it('returns binary:true for files with NUL bytes', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00])
    fs.writeFileSync(path.join(projectPath, 'blob.bin'), buf)
    const res = await request(app).get('/api/projects/proj-test/code/file?path=blob.bin')
    expect(res.status).toBe(200)
    expect(res.body.binary).toBe(true)
    expect(res.body.mime).toBe('application/octet-stream')
    expect(res.body.sizeBytes).toBe(5)
  })

  it('returns tooLarge:true for files over 2 MB', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0x41)
    fs.writeFileSync(path.join(projectPath, 'big.txt'), big)
    const res = await request(app).get('/api/projects/proj-test/code/file?path=big.txt')
    expect(res.status).toBe(200)
    expect(res.body.tooLarge).toBe(true)
    expect(res.body.sizeBytes).toBeGreaterThan(2 * 1024 * 1024)
  })

  it('returns 404 when file does not exist and no summary stored', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/file?path=missing.ts')
    expect(res.status).toBe(404)
  })
})

describe('GET /search literal source search', () => {
  const search = (query: Record<string, string | number | boolean>) => request(app).get('/api/projects/proj-test/code/search').query(query)

  it('finds literal text with line/column and narrows by path and case', async () => {
    fs.mkdirSync(path.join(projectPath, 'src'))
    fs.writeFileSync(path.join(projectPath, 'src', 'match.ts'), 'other\nconst a = value.*Test\nconst b = value.*test')
    fs.writeFileSync(path.join(projectPath, 'test.ts'), 'value.*Test')
    const result = await search({ q: 'value.*Test', path: 'src', caseSensitive: true })
    expect(result.status).toBe(200)
    expect(result.body.truncated).toBe(false)
    expect(result.body.matches).toEqual([expect.objectContaining({ path: 'src/match.ts', lineNumber: 2, column: 11, snippet: 'const a = value.*Test' })])
    expect(result.body.matches[0].fileHash).toMatch(/^[a-f0-9]{64}$/)
    const dotPath = await search({ q: 'value.*Test', path: './src/' })
    expect(dotPath.status).toBe(200)
    expect(dotPath.body.matches).toHaveLength(2)
    const insensitive = await search({ q: 'VALUE.*TEST' })
    expect(insensitive.body.matches).toHaveLength(3)
  })

  it('respects deny lists, symlink containment and current gitignore even with a cached tree', async () => {
    execSync('git init -q', { cwd: projectPath })
    fs.writeFileSync(path.join(projectPath, 'public.ts'), 'needle')
    fs.writeFileSync(path.join(projectPath, 'local.txt'), 'needle secret')
    fs.writeFileSync(path.join(projectPath, '.env'), 'needle secret')
    fs.mkdirSync(path.join(projectPath, 'node_modules'))
    fs.writeFileSync(path.join(projectPath, 'node_modules', 'dep.js'), 'needle')
    expect((await search({ q: 'needle' })).body.matches).toHaveLength(2)
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'local.txt\n')
    const next = await search({ q: 'needle' })
    expect(next.body.matches.map((match: { path: string }) => match.path)).toEqual(['public.ts'])
    expect((await search({ q: 'needle', path: '../' })).status).toBe(400)
    expect((await search({ q: 'needle', path: '.env' })).status).toBe(403)
  })

  it('reports partial results when matches or scanned files exceed their budget, including zero matches', async () => {
    fs.writeFileSync(path.join(projectPath, 'a.ts'), 'first\nfirst')
    fs.writeFileSync(path.join(projectPath, 'b.ts'), 'needle')
    const limited = await search({ q: 'first', limit: 1 })
    expect(limited.body.matches).toHaveLength(1)
    expect(limited.body.truncationReasons).toContain('match-limit')
    vi.stubEnv('SPECRAILS_CODE_SEARCH_MAX_FILES', '1')
    const partial = await search({ q: 'needle' })
    expect(partial.body.matches).toEqual([])
    expect(partial.body.truncated).toBe(true)
    expect(partial.body.truncationReasons).toContain('file-limit')
    expect(partial.body.hint).toContain('not proof of absence')
  })

  it('can narrow into a folder omitted from a truncated full-tree scan', async () => {
    vi.stubEnv('SPECRAILS_CODE_TREE_MAX_ENTRIES', '3')
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(projectPath, `a${i}.ts`), 'unrelated')
    fs.mkdirSync(path.join(projectPath, 'z-source'))
    fs.writeFileSync(path.join(projectPath, 'z-source', 'target.ts'), 'needle')
    const global = await search({ q: 'needle' })
    expect(global.body.truncated).toBe(true)
    expect(global.body.truncationReasons).toContain('tree-entry-limit')
    const narrow = await search({ q: 'needle', path: 'z-source' })
    expect(narrow.body.truncated).toBe(false)
    expect(narrow.body.matches[0]).toMatchObject({ path: 'z-source/target.ts', lineNumber: 1 })
  })

  it('marks an unreadable cached file as incomplete instead of returning a definitive empty match set', async () => {
    const file = path.join(projectPath, 'gone.ts')
    fs.writeFileSync(file, 'unrelated')
    await request(app).get('/api/projects/proj-test/code/tree?filter=all')
    fs.unlinkSync(file)
    const result = await search({ q: 'needle' })
    expect(result.body.matches).toEqual([])
    expect(result.body.truncated).toBe(true)
    expect(result.body.truncationReasons).toContain('unreadable-files')
  })

  it('bounds byte reads and reports oversized or unreadable files as incomplete search', async () => {
    fs.writeFileSync(path.join(projectPath, 'a.ts'), 'x'.repeat(50))
    vi.stubEnv('SPECRAILS_CODE_SEARCH_MAX_BYTES', '16')
    const partial = await search({ q: 'needle' })
    expect(partial.body.truncated).toBe(true)
    expect(partial.body.scan.bytesRead).toBeLessThanOrEqual(16)
    expect(partial.body.scan.skipped.tooLarge).toBe(1)
    expect(partial.body.truncationReasons).toContain('oversized-or-changing-files')
  })

  it('rejects empty/multiline/oversized queries and limits snippets around long-line matches', async () => {
    expect((await search({ q: '' })).status).toBe(400)
    expect((await search({ q: 'line\nbreak' })).status).toBe(400)
    expect((await search({ q: 'x'.repeat(257) })).status).toBe(400)
    fs.writeFileSync(path.join(projectPath, 'min.js'), `${'x'.repeat(25000)}needle${'y'.repeat(1000)}`)
    const result = await search({ q: 'needle' })
    expect(result.body.matches[0]).toMatchObject({ lineNumber: 1, column: 25001, snippetTruncated: true })
    expect(result.body.matches[0].snippet.length).toBeLessThanOrEqual(320)
    expect(result.body.matches[0].snippet).toContain('needle')
  })
})

describe('PUT /file (in-app editing)', () => {
  const put = (path: unknown, content: unknown) =>
    request(app).put('/api/projects/proj-test/code/file').send({ path, content })

  it('overwrites an existing text file and persists to disk', async () => {
    fs.writeFileSync(path.join(projectPath, 'edit.ts'), 'const a = 1\n', 'utf8')
    const next = 'const a = 2\nconst b = 3\n'
    const res = await put('edit.ts', next)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.bytes).toBe(Buffer.byteLength(next, 'utf8'))
    expect(fs.readFileSync(path.join(projectPath, 'edit.ts'), 'utf8')).toBe(next)
  })

  it('400 when path or content is missing', async () => {
    expect((await put(undefined, 'x')).status).toBe(400)
    expect((await put('edit.ts', undefined)).status).toBe(400)
  })

  it('404 for a non-existent file (editing only overwrites existing files)', async () => {
    const res = await put('does-not-exist.ts', 'hello')
    expect(res.status).toBe(404)
  })

  it('400 on path traversal', async () => {
    const res = await put('../../etc/passwd', 'pwned')
    expect(res.status).toBe(400)
  })

  it('403 on a deny-listed path', async () => {
    const res = await put('.env', 'SECRET=1')
    expect(res.status).toBe(403)
  })

  it('415 when the new content contains control/NUL bytes', async () => {
    fs.writeFileSync(path.join(projectPath, 'edit.ts'), 'ok\n', 'utf8')
    const res = await put('edit.ts', 'bad\0content')
    expect(res.status).toBe(415)
    // file unchanged
    expect(fs.readFileSync(path.join(projectPath, 'edit.ts'), 'utf8')).toBe('ok\n')
  })

  it('415 when overwriting an existing binary file', async () => {
    fs.writeFileSync(path.join(projectPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    const res = await put('blob.bin', 'now text')
    expect(res.status).toBe(415)
  })

  it('413 when content exceeds the 2 MB cap', async () => {
    fs.writeFileSync(path.join(projectPath, 'big.txt'), 'small\n', 'utf8')
    const res = await put('big.txt', 'A'.repeat(2 * 1024 * 1024 + 10))
    expect(res.status).toBe(413)
  })
})

describe('GET /tree pagination', () => {
  it('pins continuation to its original paths after cache expiry and a changed checkout', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    for (const name of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(projectPath, name), name)
    const first = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'all', limit: 1 })
    expect(first.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['a.ts'])
    now += 6_000 // The discovery cache has expired; this cursor must not use its replacement.
    fs.writeFileSync(path.join(projectPath, '0-new.ts'), 'new')
    fs.unlinkSync(path.join(projectPath, 'b.ts'))
    const fresh = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'all', limit: 1 })
    expect(fresh.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['0-new.ts'])
    const rest = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'all', limit: 2, cursor: first.body.nextCursor })
    expect(rest.status).toBe(200)
    expect(rest.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['b.ts', 'c.ts'])
    expect(rest.body.nextCursor).toBeNull()
    expect(rest.body.scan.cache).toBe('snapshot')
  })

  it('pins touched-file membership when a job records additional paths between pages', async () => {
    const insert = db.prepare("INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, 7, 'run', 'modified', 1)")
    for (const name of ['a.ts', 'b.ts']) insert.run(name)
    const first = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'touched-by-ai', ticketId: 7, limit: 1, withProvenance: 1 })
    insert.run('0-new.ts')
    const next = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'touched-by-ai', ticketId: 7, limit: 1, withProvenance: 1, cursor: first.body.nextCursor })
    expect(next.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['b.ts'])
    expect(next.body.nextCursor).toBeNull()
  })

  it('rejects expired, evicted and offset-only cursors with an explicit retry response', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    for (const name of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(projectPath, name), name)
    const query = { filter: 'all', limit: 1 }
    const first = await request(app).get('/api/projects/proj-test/code/tree').query(query)
    now += 120_000
    const expired = await request(app).get('/api/projects/proj-test/code/tree').query({ ...query, cursor: first.body.nextCursor })
    expect(expired.status).toBe(409)
    expect(expired.body).toEqual({ error: 'tree_snapshot_expired', retryable: true })
    const retained = await request(app).get('/api/projects/proj-test/code/tree').query(query)
    for (let i = 0; i < 4; i++) await request(app).get('/api/projects/proj-test/code/tree').query(query)
    const evicted = await request(app).get('/api/projects/proj-test/code/tree').query({ ...query, cursor: retained.body.nextCursor })
    expect(evicted.status).toBe(409)
    const legacy = Buffer.from(JSON.stringify({ skip: 1 })).toString('base64')
    expect((await request(app).get('/api/projects/proj-test/code/tree').query({ ...query, cursor: legacy })).body).toEqual({ error: 'tree_snapshot_expired', retryable: true })
  })

  it('binds cursors to filters, provenance mode and the mounted repository', async () => {
    for (const name of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(projectPath, name), name)
    const first = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'all', limit: 1 })
    for (const filter of [{ filter: 'touched-by-ai' }, { filter: 'all', withProvenance: 1 }]) {
      const changed = await request(app).get('/api/projects/proj-test/code/tree').query({ ...filter, cursor: first.body.nextCursor })
      expect(changed.status).toBe(400)
      expect(changed.body.error).toBe('tree_cursor_scope_mismatch')
    }
    const another = express().use('/code', createCodeExplorerRouter({ db, projectId: 'other-project', projectPath, broadcast: vi.fn(), fileSummaryManager: { enqueue: vi.fn(), attachWatcher: vi.fn() }, aiTransformProvider: 'claude' }))
    expect((await request(another).get('/code/tree').query({ filter: 'all', cursor: first.body.nextCursor })).status).toBe(409)
    expect((await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'all', cursor: 'garbage' })).status).toBe(400)
    expect((await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'unexpected' })).status).toBe(400)
  })

  it('rechecks changed ignore policy without shifting snapshot offsets or leaking directory badges', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectPath })
    fs.mkdirSync(path.join(projectPath, 'src'))
    for (const name of ['public.ts', 'secret.ts']) fs.writeFileSync(path.join(projectPath, 'src', name), name)
    const insert = db.prepare("INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, 'run', 'modified', 1)")
    insert.run('src/public.ts', 7)
    insert.run('src/secret.ts', 99)
    const first = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'touched-by-ai', withProvenance: 1, limit: 1 })
    expect(first.body.entries[0].path).toBe('src')
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'src/secret.ts\n')
    const rest = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'touched-by-ai', withProvenance: 1, cursor: first.body.nextCursor })
    expect(rest.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['src/public.ts'])
    expect(rest.body.nextCursor).toBeNull()
    const refresh = await request(app).get('/api/projects/proj-test/code/tree').query({ filter: 'touched-by-ai', withProvenance: 1, limit: 1 })
    expect(refresh.body.entries[0].provenance.rows.map((row: { path: string }) => row.path)).toEqual(['src/public.ts'])
    expect(refresh.body.entries[0].provenance.modifiedByTicketIds).toEqual([7])
  })

  it('returns entries up to 2000 and produces a stable cursor', async () => {
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(projectPath, `f${i.toString().padStart(2, '0')}.txt`), 'x')
    }
    const res = await request(app).get('/api/projects/proj-test/code/code/tree?filter=all').catch(() => null)
    void res
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=all')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.entries)).toBe(true)
    expect(r.body.entries.length).toBe(25)
    expect(r.body.nextCursor).toBeNull()
  })

  it('respects the deny-list (node_modules, dotfiles)', async () => {
    fs.mkdirSync(path.join(projectPath, 'node_modules', 'foo'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'node_modules', 'foo', 'index.js'), 'x')
    fs.writeFileSync(path.join(projectPath, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(projectPath, 'visible.ts'), 'x')
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=all')
    expect(r.status).toBe(200)
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths).toContain('visible.ts')
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(paths.some((p) => p === '.env')).toBe(false)
  })

  it('reports an explicit retryable truncation when the visited-entry safety bound is reached', async () => {
    const previous = process.env.SPECRAILS_CODE_TREE_MAX_ENTRIES
    process.env.SPECRAILS_CODE_TREE_MAX_ENTRIES = '3'
    try {
      for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(projectPath, `bounded-${i}.ts`), 'x')
      const r = await request(app).get('/api/projects/proj-test/code/tree?filter=all')
      expect(r.status).toBe(200)
      expect(r.body.truncated).toBe(true)
      expect(r.body.truncationReason).toBe('entry-limit')
      expect(r.body.scan).toEqual(expect.objectContaining({ retryable: true, maxEntries: 3 }))
      expect(r.body.entries.length).toBeLessThanOrEqual(3)
    } finally {
      if (previous === undefined) delete process.env.SPECRAILS_CODE_TREE_MAX_ENTRIES
      else process.env.SPECRAILS_CODE_TREE_MAX_ENTRIES = previous
    }
  })

  it('touched-by-ai filter returns touched files with folder context and provenance rows', async () => {
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'src', 'touched.ts'), 'x')
    fs.writeFileSync(path.join(projectPath, 'untouched.ts'), 'x')
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('src/touched.ts', 42, 'job-1', 'created', Date.now())
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=touched-by-ai&withProvenance=1')
    expect(r.status).toBe(200)
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths).toEqual(['src', 'src/touched.ts'])
    expect(r.body.entries[0].provenance.touchedFileCount).toBe(1)
    expect(r.body.entries[1].provenance.rows).toHaveLength(1)
    expect(r.body.entries[1].provenance.latest).toMatchObject({
      path: 'src/touched.ts',
      ticketId: 42,
      jobId: 'job-1',
      kind: 'created',
    })
  })

  it('touched-by-ai filter can be narrowed to a job', async () => {
    fs.writeFileSync(path.join(projectPath, 'a.ts'), 'x')
    fs.writeFileSync(path.join(projectPath, 'b.ts'), 'x')
    const insert = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run('a.ts', 1, 'job-a', 'modified', 1000)
    insert.run('b.ts', 1, 'job-b', 'modified', 1000)
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=touched-by-ai&withProvenance=1&jobId=job-a')
    expect(r.status).toBe(200)
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths).toEqual(['a.ts'])
  })
})

describe('POST /file/regenerate-summary', () => {
  it('enqueues with overrideBudget=true and returns 202', async () => {
    fs.writeFileSync(path.join(projectPath, 'foo.ts'), 'x')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({ overrideBudget: true })
    expect(res.status).toBe(202)
    expect(res.body.enqueued).toBe(true)
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0][0]).toMatchObject({
      relPath: 'foo.ts',
      overrideBudget: true,
      triggeredBy: { kind: 'user', ticketId: null },
    })
  })

  it('rejects path traversal', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=../etc/passwd')
      .send({})
    expect(res.status).toBe(400)
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('rejects binary files before enqueueing', async () => {
    fs.writeFileSync(path.join(projectPath, 'blob.bin'), Buffer.from([0, 1, 2]))
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=blob.bin')
      .send({})
    expect(res.status).toBe(415)
    expect(res.body.skipped).toBe('binary')
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('rejects files over the preview cap before enqueueing', async () => {
    fs.writeFileSync(path.join(projectPath, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x41))
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=big.txt')
      .send({})
    expect(res.status).toBe(413)
    expect(res.body.skipped).toBe('too-large')
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('rejects Kimi before watcher/manager work and preserves source + summary bytes', async () => {
    const sourcePath = path.join(projectPath, 'foo.ts')
    fs.writeFileSync(sourcePath, 'export const x = 1\n', 'utf8')
    const hash = await computeFileHash(sourcePath)
    await storeSummary('foo.ts', hash)
    const storedSummaryPath = summaryFilePath(projectPath, 'foo.ts')
    const sourceBefore = fs.readFileSync(sourcePath)
    const summaryBefore = fs.readFileSync(storedSummaryPath)

    mountApp('kimi')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({ overrideBudget: true })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'provider_tool_policy_unsupported',
      provider: 'kimi',
      requiredPolicy: 'pure-output',
    })
    expect(attachWatcherSpy).not.toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore)
    expect(fs.readFileSync(storedSummaryPath)).toEqual(summaryBefore)
  })
})

describe('GET /provenance', () => {
  it('returns rows for a ticket as a JSON array', async () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 7, 'job-x', 'created', now)
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('b.ts', 7, 'job-x', 'modified', now)
    const res = await request(app).get('/api/projects/proj-test/code/provenance?ticketId=7')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(2)
    expect(res.body[0]).toHaveProperty('path')
    expect(res.body[0]).toHaveProperty('kind')
    expect(res.body[0]).toHaveProperty('jobId')
    expect(res.body[0]).toHaveProperty('at')
  })

  it('returns rows filtered by jobId', async () => {
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 7, 'job-x', 'created', 1000)
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('b.ts', 7, 'job-y', 'modified', 1000)
    const res = await request(app).get('/api/projects/proj-test/code/provenance?jobId=job-x')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { path: 'a.ts', ticketId: 7, jobId: 'job-x', kind: 'created', at: 1000 },
    ])
  })

  it('returns rows filtered by path', async () => {
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 7, 'job-x', 'created', 1000)
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 8, 'job-y', 'modified', 2000)
    const res = await request(app).get('/api/projects/proj-test/code/provenance?path=a.ts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { path: 'a.ts', ticketId: 8, jobId: 'job-y', kind: 'modified', at: 2000 },
      { path: 'a.ts', ticketId: 7, jobId: 'job-x', kind: 'created', at: 1000 },
    ])
  })

  it('returns empty array for unknown ticket', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/provenance?ticketId=999')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('rejects non-numeric ticketId', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/provenance?ticketId=abc')
    expect(res.status).toBe(400)
  })
})

describe('GET /diff', () => {
  it('returns stored diff for a job/path pair', async () => {
    const result = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 7, 'job-x', 'modified', 1000)
    db.prepare(
      `INSERT INTO file_provenance_diffs (provenance_id, patch, truncated) VALUES (?, ?, ?)`,
    ).run(Number(result.lastInsertRowid), 'diff --git a/a.ts b/a.ts\n+hello', 0)
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-x&path=a.ts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ patch: 'diff --git a/a.ts b/a.ts\n+hello', truncated: false })
  })

  it('returns 404 when the diff was not stored', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-missing&path=a.ts')
    expect(res.status).toBe(404)
  })

  it('BUG-CODE-01: refuses to serve a stored diff for a deny-listed secret file (.env)', async () => {
    // An AI job touched .env; a stored "added" patch contains the full secret.
    const result = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('.env', 1, 'job-secret', 'created', 1000)
    db.prepare(
      `INSERT INTO file_provenance_diffs (provenance_id, patch, truncated) VALUES (?, ?, ?)`,
    ).run(Number(result.lastInsertRowid), 'diff --git a/.env b/.env\n+AWS_SECRET=topsecret', 0)
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-secret&path=.env')
    expect(res.status).toBe(403)
    expect(res.body.patch).toBeUndefined()
  })

  it('BUG-CODE-01: refuses to serve a stored diff for a secret-bearing extension (*.pem)', async () => {
    const result = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('server.pem', 1, 'job-pem', 'created', 1000)
    db.prepare(
      `INSERT INTO file_provenance_diffs (provenance_id, patch, truncated) VALUES (?, ?, ?)`,
    ).run(Number(result.lastInsertRowid), 'diff --git a/server.pem b/server.pem\n+-----BEGIN PRIVATE KEY-----', 0)
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-pem&path=server.pem')
    expect(res.status).toBe(403)
  })

  it('BUG-CODE-01: refuses to serve a stored diff for a gitignored file', async () => {
    execSync('git init -q', { cwd: projectPath })
    execSync('git config user.email t@t.local', { cwd: projectPath })
    execSync('git config user.name t', { cwd: projectPath })
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'config.local.json\n', 'utf8')
    const result = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('config.local.json', 1, 'job-gi', 'modified', 1000)
    db.prepare(
      `INSERT INTO file_provenance_diffs (provenance_id, patch, truncated) VALUES (?, ?, ?)`,
    ).run(Number(result.lastInsertRowid), 'diff --git a/config.local.json b/config.local.json\n+TOKEN=abc', 0)
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-gi&path=config.local.json')
    expect(res.status).toBe(403)
  })

  it('BUG-CODE-01: still serves a diff for an ordinary non-secret file (no false positive)', async () => {
    const result = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('a.ts', 7, 'job-ok', 'modified', 1000)
    db.prepare(
      `INSERT INTO file_provenance_diffs (provenance_id, patch, truncated) VALUES (?, ?, ?)`,
    ).run(Number(result.lastInsertRowid), 'diff --git a/a.ts b/a.ts\n+hello', 0)
    const res = await request(app).get('/api/projects/proj-test/code/diff?jobId=job-ok&path=a.ts')
    expect(res.status).toBe(200)
    expect(res.body.patch).toContain('+hello')
  })
})

describe('GET /summary', () => {
  it('returns { summary: null } when no stored summary', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/summary?path=foo.ts')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ summary: null })
  })
})

describe('summary staleness', () => {
  it('marks identical source stale when explanation language or prompt version changed', async () => {
    fs.writeFileSync(path.join(projectPath, 'hello.ts'), 'export const x = 1\n', 'utf8')
    const hash = await computeFileHash(path.join(projectPath, 'hello.ts'))
    await storeSummary('hello.ts', hash)
    const target = summaryFilePath(projectPath, 'hello.ts')
    const summary = JSON.parse(fs.readFileSync(target, 'utf8'))
    summary.language = 'es'
    fs.writeFileSync(target, JSON.stringify(summary))
    expect((await request(app).get('/api/projects/proj-test/code/summary?path=hello.ts')).body.summaryStale).toBe(true)
    summary.language = 'en'
    summary.generatedBy.promptVersion = CURRENT_PROMPT_VERSION - 1
    fs.writeFileSync(target, JSON.stringify(summary))
    expect((await request(app).get('/api/projects/proj-test/code/file?path=hello.ts')).body.summaryStale).toBe(true)
  })

  it('reports summaryStale=false for a matching hash and true after the file changes', async () => {
    fs.writeFileSync(path.join(projectPath, 'hello.ts'), 'export const x = 1\n', 'utf8')
    const hash = await computeFileHash(path.join(projectPath, 'hello.ts'))
    await storeSummary('hello.ts', hash)

    const fresh = await request(app).get('/api/projects/proj-test/code/summary?path=hello.ts')
    expect(fresh.status).toBe(200)
    expect(fresh.body.summary).not.toBeNull()
    expect(fresh.body.summaryStale).toBe(false)

    // GET /file should agree.
    const file = await request(app).get('/api/projects/proj-test/code/file?path=hello.ts')
    expect(file.body.summaryStale).toBe(false)

    // Mutate the file → the stored summary is now stale.
    fs.writeFileSync(path.join(projectPath, 'hello.ts'), 'export const x = 2\n', 'utf8')
    const stale = await request(app).get('/api/projects/proj-test/code/summary?path=hello.ts')
    expect(stale.body.summaryStale).toBe(true)
  })
})

describe('Monaco language ids', () => {
  it('maps .tsx and .jsx to registered Monaco ids (typescript/javascript)', async () => {
    fs.writeFileSync(path.join(projectPath, 'C.tsx'), 'export const C = () => null\n', 'utf8')
    fs.writeFileSync(path.join(projectPath, 'd.jsx'), 'export const D = () => null\n', 'utf8')
    const tsx = await request(app).get('/api/projects/proj-test/code/file?path=C.tsx')
    expect(tsx.body.language).toBe('typescript')
    const jsx = await request(app).get('/api/projects/proj-test/code/file?path=d.jsx')
    expect(jsx.body.language).toBe('javascript')
  })
})

describe('deny-list enforcement on content endpoints', () => {
  it('GET /file returns 403 for denied files (.env, lockfiles)', async () => {
    fs.writeFileSync(path.join(projectPath, '.env'), 'AWS_SECRET=topsecret', 'utf8')
    fs.writeFileSync(path.join(projectPath, 'package-lock.json'), '{}', 'utf8')
    const env = await request(app).get('/api/projects/proj-test/code/file?path=.env')
    expect(env.status).toBe(403)
    const lock = await request(app).get('/api/projects/proj-test/code/file?path=package-lock.json')
    expect(lock.status).toBe(403)
  })

  it('GET /summary returns 403 for denied files', async () => {
    fs.writeFileSync(path.join(projectPath, '.env'), 'X=1', 'utf8')
    const res = await request(app).get('/api/projects/proj-test/code/summary?path=.env')
    expect(res.status).toBe(403)
  })

  it('POST /file/regenerate-summary returns 403 for denied files and does not enqueue', async () => {
    fs.writeFileSync(path.join(projectPath, 'secrets.log'), 'noise', 'utf8')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=secrets.log')
      .send({})
    expect(res.status).toBe(403)
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('touched-by-ai tree omits denied files so it matches the all-tree', async () => {
    fs.writeFileSync(path.join(projectPath, '.env'), 'X=1', 'utf8')
    db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    ).run('.env', 1, 'job-a', 'modified', Date.now())
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=touched-by-ai&withProvenance=1')
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths).not.toContain('.env')
  })

  it('BUG-CODE-04: touched-by-ai tree drops gitignored files (and their now-empty dir nodes)', async () => {
    execSync('git init -q', { cwd: projectPath })
    execSync('git config user.email t@t.local', { cwd: projectPath })
    execSync('git config user.name t', { cwd: projectPath })
    // A gitignored file whose name/extension is NOT deny-listed, in its own dir.
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'secrets/\n', 'utf8')
    fs.mkdirSync(path.join(projectPath, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'secrets', 'config.local.json'), '{"token":"x"}', 'utf8')
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, 'src', 'visible.ts'), 'x', 'utf8')
    const insert = db.prepare(
      `INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run('secrets/config.local.json', 1, 'job-a', 'modified', Date.now())
    insert.run('src/visible.ts', 2, 'job-a', 'created', Date.now())
    const r = await request(app).get('/api/projects/proj-test/code/tree?filter=touched-by-ai&withProvenance=1')
    expect(r.status).toBe(200)
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path)
    // Gitignored file + its now-empty 'secrets' dir node are both gone.
    expect(paths).not.toContain('secrets/config.local.json')
    expect(paths).not.toContain('secrets')
    // The non-ignored touched file (and its dir) still surface.
    expect(paths).toContain('src/visible.ts')
    expect(paths).toContain('src')
  })
})

describe('symlink path-escape hardening', () => {
  it('rejects a symlink whose target is outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8')
    let linked = false
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectPath, 'link.txt'))
      linked = true
    } catch {
      // Platforms without symlink privileges (e.g. Windows non-admin) — skip.
    }
    try {
      if (!linked) return
      const res = await request(app).get('/api/projects/proj-test/code/file?path=link.txt')
      expect(res.status).toBe(400)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still serves a legitimate in-project file (no false rejection)', async () => {
    fs.writeFileSync(path.join(projectPath, 'real.ts'), 'export const r = 1\n', 'utf8')
    const res = await request(app).get('/api/projects/proj-test/code/file?path=real.ts')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const r = 1\n')
  })
})

describe('POST /file/regenerate-summary result surfacing', () => {
  it('passes force:true so an explicit regenerate bypasses the hash gate', async () => {
    fs.writeFileSync(path.join(projectPath, 'foo.ts'), 'x', 'utf8')
    await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({})
    expect(enqueueSpy.mock.calls[0][0]).toMatchObject({ force: true })
  })

  it('surfaces skipped:budget as 200 { skipped: "budget" } so the client prompt is reachable', async () => {
    fs.writeFileSync(path.join(projectPath, 'foo.ts'), 'x', 'utf8')
    enqueueSpy.mockResolvedValueOnce('skipped:budget')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.skipped).toBe('budget')
  })

  it('surfaces a failed enqueue as 500', async () => {
    fs.writeFileSync(path.join(projectPath, 'foo.ts'), 'x', 'utf8')
    enqueueSpy.mockResolvedValueOnce('failed')
    const res = await request(app)
      .post('/api/projects/proj-test/code/file/regenerate-summary?path=foo.ts')
      .send({})
    expect(res.status).toBe(500)
  })
})

describe('security: deny-list + gitignore', () => {
  it('refuses secret-bearing names/extensions (id_rsa, *.pem) and case-variant build dirs', async () => {
    fs.writeFileSync(path.join(projectPath, 'id_rsa'), 'PRIVATE KEY', 'utf8')
    fs.writeFileSync(path.join(projectPath, 'server.pem'), 'CERT', 'utf8')
    for (const p of ['id_rsa', 'server.pem', 'Node_Modules/pkg/index.js', 'Package-Lock.json']) {
      const res = await request(app).get(`/api/projects/proj-test/code/file?path=${encodeURIComponent(p)}`)
      expect(res.status).toBe(403)
    }
  })

  it('does not serve gitignored files and excludes them from the all-files tree', async () => {
    execSync('git init -q', { cwd: projectPath })
    execSync('git config user.email t@t.local', { cwd: projectPath })
    execSync('git config user.name t', { cwd: projectPath })
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'secret.txt\n', 'utf8')
    fs.writeFileSync(path.join(projectPath, 'secret.txt'), 'sshhh', 'utf8')
    fs.writeFileSync(path.join(projectPath, 'public.ts'), 'export const x = 1\n', 'utf8')

    const blocked = await request(app).get('/api/projects/proj-test/code/file?path=secret.txt')
    expect(blocked.status).toBe(403)

    const ok = await request(app).get('/api/projects/proj-test/code/file?path=public.ts')
    expect(ok.status).toBe(200)

    const tree = await request(app).get('/api/projects/proj-test/code/tree?filter=all')
    const paths = (tree.body.entries as Array<{ path: string }>).map((e) => e.path)
    expect(paths).toContain('public.ts')
    expect(paths).not.toContain('secret.txt')

    const insert = db.prepare("INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, 7, 'run', 'modified', 1)")
    for (const relative of ['secret.txt', '.env', 'public.ts', 'missing.ts']) insert.run(relative)
    const activity = await request(app).get('/api/projects/proj-test/code/activity?ticketId=7')
    expect(activity.body.entries.map((entry: { path: string }) => entry.path).sort()).toEqual(['missing.ts', 'public.ts'])
    for (const filter of ['ticketId=7', 'jobId=run']) {
      const provenance = await request(app).get(`/api/projects/proj-test/code/provenance?${filter}`)
      expect(provenance.body.map((entry: { path: string }) => entry.path).sort()).toEqual(['missing.ts', 'public.ts'])
    }
    expect((await request(app).get('/api/projects/proj-test/code/provenance?path=secret.txt')).body).toEqual([])
  })

  it('applies the deny-list to GET /provenance?path so touched-secret metadata never leaks', async () => {
    const res = await request(app).get('/api/projects/proj-test/code/provenance?path=.env')
    expect(res.status).toBe(403)
  })
})

describe('GET /find (locate a file by name / path suffix)', () => {
  function seedTree(): void {
    for (const rel of [
      'src/components/detail/LessonView.tsx',
      'packages/ui/components/detail/LessonView.tsx',
      'legacy/LessonView.tsx',
      'src/other.ts',
      'node_modules/dep/LessonView.tsx',
    ]) {
      fs.mkdirSync(path.dirname(path.join(projectPath, rel)), { recursive: true })
      fs.writeFileSync(path.join(projectPath, rel), '// x\n', 'utf8')
    }
  }

  it('ranks path-suffix matches (the stack-trace case) before same-name files elsewhere', async () => {
    seedTree()
    const res = await request(app).get('/api/projects/proj-test/code/find?q=components/detail/LessonView.tsx')
    expect(res.status).toBe(200)
    expect(res.body.query).toBe('components/detail/LessonView.tsx')
    expect(res.body.matches).toEqual([
      { path: 'src/components/detail/LessonView.tsx', sizeBytes: 5, match: 'suffix' },
      { path: 'packages/ui/components/detail/LessonView.tsx', sizeBytes: 5, match: 'suffix' },
      { path: 'legacy/LessonView.tsx', sizeBytes: 5, match: 'basename' },
    ])
    expect(res.body.total).toBe(3)
    expect(res.body.truncated).toBe(false)
  })

  it('is case-insensitive, matches fragments, reports exact matches first and honours limit', async () => {
    seedTree()
    const frag = await request(app).get('/api/projects/proj-test/code/find?q=lessonview&limit=2')
    expect(frag.status).toBe(200)
    expect(frag.body.total).toBe(3)
    expect(frag.body.matches.map((m: { path: string }) => m.path)).toEqual([
      'legacy/LessonView.tsx',
      'src/components/detail/LessonView.tsx',
    ])
    const exact = await request(app).get('/api/projects/proj-test/code/find?q=SRC/other.ts')
    expect(exact.body.matches[0]).toMatchObject({ path: 'src/other.ts', match: 'exact' })
  })

  it('never surfaces build trees or gitignored files', async () => {
    seedTree()
    execSync('git init -q', { cwd: projectPath })
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'legacy/\n', 'utf8')
    const res = await request(app).get('/api/projects/proj-test/code/find?q=LessonView.tsx')
    const paths = (res.body.matches as Array<{ path: string }>).map((m) => m.path)
    expect(paths).not.toContain('node_modules/dep/LessonView.tsx')
    expect(paths).not.toContain('legacy/LessonView.tsx')
    expect(paths).toContain('src/components/detail/LessonView.tsx')
  })

  it('rejects a missing or oversized query', async () => {
    expect((await request(app).get('/api/projects/proj-test/code/find')).status).toBe(400)
    expect((await request(app).get('/api/projects/proj-test/code/find?q=%20')).status).toBe(400)
    expect((await request(app).get(`/api/projects/proj-test/code/find?q=${'a'.repeat(300)}`)).status).toBe(400)
  })
})

describe('rankFindMatches', () => {
  const entries = [
    { rel: 'src/a/B.ts', isDir: false, size: 1 },
    { rel: 'src/a', isDir: true, size: null },
    { rel: 'lib/b.ts', isDir: false, size: 2 },
    { rel: 'b.ts', isDir: false, size: 3 },
  ]

  it('normalises backslashes and leading ./ or /, skips directories, and orders by kind then path length', () => {
    expect(rankFindMatches(entries, '.\\src\\a\\b.ts').map((m) => [m.rel, m.match])).toEqual([
      ['src/a/B.ts', 'exact'],
      ['b.ts', 'basename'],
      ['lib/b.ts', 'basename'],
    ])
    expect(rankFindMatches(entries, '/b.ts').map((m) => [m.rel, m.match])).toEqual([
      ['b.ts', 'exact'],
      ['lib/b.ts', 'suffix'],
      ['src/a/B.ts', 'suffix'],
    ])
    expect(rankFindMatches(entries, 'a')).toEqual([{ rel: 'src/a/B.ts', size: 1, match: 'substring' }])
    expect(rankFindMatches(entries, '   ')).toEqual([])
  })
})
