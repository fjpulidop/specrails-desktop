import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { createAgentAuditService } from '../application'
import { registerAgentAuditHttp } from '../adapters/http'
import { createProjectAgentAudit, sha256 } from '../adapters/runtime'
import { createSqliteAgentActionStore } from '../adapters/sqlite'
import type { AgentActionRow } from '../domain'

const databases: DbInstance[] = []
function db(): DbInstance {
  const instance = initDb(':memory:')
  databases.push(instance)
  return instance
}
afterEach(() => { for (const instance of databases.splice(0)) instance.close() })

const row = (overrides: Partial<AgentActionRow> = {}): AgentActionRow => ({
  runId: 'run-1', jobId: 'run-1', role: 'developer', kind: 'read', target: 'src/a.ts', hash: null, ts: '2026-10-20T10:00:00.000Z', source: 'claude-stream', ...overrides,
})

describe('migration', () => {
  it('creates agent_actions with the kind check and run/ts indexes', () => {
    const instance = db()
    const columns = (instance.prepare('PRAGMA table_info(agent_actions)').all() as Array<{ name: string; notnull: number }>).map(c => [c.name, c.notnull])
    expect(columns).toEqual([['id', 0], ['run_id', 1], ['job_id', 0], ['role', 1], ['kind', 1], ['target', 1], ['hash', 0], ['ts', 1], ['source', 1]])
    const indexes = (instance.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_actions'").all() as Array<{ name: string }>).map(i => i.name).sort()
    expect(indexes).toEqual(['idx_agent_actions_run', 'idx_agent_actions_ts'])
    expect(() => instance.prepare("INSERT INTO agent_actions (run_id, role, kind, target, ts, source) VALUES ('r','x','delete','t','2026-01-01','s')").run()).toThrow(/CHECK/)
  })
})

describe('SQLite store', () => {
  it('inserts batches atomically and keeps projects isolated', () => {
    const first = createSqliteAgentActionStore(db())
    const secondDb = db()
    const second = createSqliteAgentActionStore(secondDb)
    first.insertMany([row(), row({ kind: 'exec', target: 'npm test', ts: '2026-10-20T10:00:01.000Z' })])
    expect(first.listByRun('run-1', 10).map(r => r.target)).toEqual(['src/a.ts', 'npm test'])
    expect(second.listByRun('run-1', 10)).toEqual([])
    // A bad row rolls back its whole batch.
    expect(() => second.insertMany([row(), row({ kind: 'bogus' as never })])).toThrow()
    expect(second.listByRun('run-1', 10)).toEqual([])
  })

  it('lists by job id, filters a window, counts by kind and deletes before a cutoff', () => {
    const store = createSqliteAgentActionStore(db())
    store.insertMany([
      row({ ts: '2026-09-01T00:00:00.000Z' }),
      row({ runId: 'conv-1', jobId: null, kind: 'mcp', target: 'specrails_jobs:list', ts: '2026-10-10T00:00:00.000Z' }),
      row({ runId: 'loop-1', jobId: 'job-7', kind: 'write', target: 'b.ts', ts: '2026-10-15T00:00:00.000Z' }),
    ])
    expect(store.listByRun('job-7', 10).map(r => r.target)).toEqual(['b.ts'])
    expect(store.listWindow({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z', limit: 10 }).map(r => r.runId)).toEqual(['conv-1'])
    expect(store.countByKind(['run-1', 'job-7', ''])).toEqual({ read: 1, write: 1, exec: 0, mcp: 0, network: 0 })
    expect(store.countByKind([])).toEqual({ read: 0, write: 0, exec: 0, mcp: 0, network: 0 })
    expect(store.deleteBefore('2026-10-01T00:00:00.000Z')).toBe(1)
    expect(store.listWindow({ limit: 10 }).length).toBe(2)
  })
})

describe('project runtime and retention', () => {
  it('flushes on dispose and prunes with the project setting', () => {
    const instance = db()
    let days = 30
    const audit = createProjectAgentAudit(instance, { retentionDays: () => days, autoStartRetention: false })
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    const recent = new Date(Date.now() - 10 * 86_400_000).toISOString()
    audit.recorder.record([
      { runId: 'r', kind: 'read', target: 'old', source: 's', ts: old },
      { runId: 'r', kind: 'write', target: 'f.ts', source: 's', ts: recent, hashSource: 'content' },
    ])
    expect(audit.pruneNow()).toBe(1)
    const rows = audit.service.exportRun('r', 'jsonl').body.trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toEqual([expect.objectContaining({ target: 'f.ts', hash: sha256('content') })])
    days = 5
    expect(audit.pruneNow()).toBe(1)
    audit.recorder.record({ runId: 'r', kind: 'exec', target: 'ls', source: 's' })
    audit.dispose()
    expect(createSqliteAgentActionStore(instance).listByRun('r', 10).map(r => r.target)).toEqual(['ls'])
  })

  it('retention failures are logged, never thrown', () => {
    const instance = db()
    const audit = createProjectAgentAudit(instance, { retentionDays: () => { throw new Error('settings unavailable') }, autoStartRetention: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(audit.pruneNow()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings unavailable'))
    warn.mockRestore()
    audit.dispose()
  })
})

describe('HTTP export', () => {
  function app(instance: DbInstance) {
    const router = express.Router()
    registerAgentAuditHttp(router, () => createAgentAuditService({ store: createSqliteAgentActionStore(instance) }))
    const server = express()
    server.use('/api/projects', router)
    return server
  }

  it('exports one run as JSONL and CSV with attachment headers', async () => {
    const instance = db()
    createSqliteAgentActionStore(instance).insertMany([row(), row({ kind: 'exec', target: 'npm run "build", now', ts: '2026-10-20T10:00:05.000Z' }), row({ runId: 'other', jobId: 'other' })])
    const jsonl = await request(app(instance)).get('/api/projects/p1/jobs/run-1/audit')
    expect(jsonl.status).toBe(200)
    expect(jsonl.headers['content-type']).toContain('application/x-ndjson')
    expect(jsonl.headers['content-disposition']).toBe('attachment; filename="agent-actions-run-1.jsonl"')
    expect(jsonl.text.trim().split('\n').map(line => JSON.parse(line).target)).toEqual(['src/a.ts', 'npm run "build", now'])

    const csv = await request(app(instance)).get('/api/projects/p1/jobs/run-1/audit?format=csv')
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.text.trim().split('\n')).toEqual([
      'id,ts,run_id,job_id,role,kind,target,hash,source',
      '1,2026-10-20T10:00:00.000Z,run-1,run-1,developer,read,src/a.ts,,claude-stream',
      '2,2026-10-20T10:00:05.000Z,run-1,run-1,developer,exec,"npm run ""build"", now",,claude-stream',
    ])
  })

  it('exports a project-wide window and validates its parameters', async () => {
    const instance = db()
    createSqliteAgentActionStore(instance).insertMany([row({ ts: '2026-09-01T00:00:00.000Z' }), row({ runId: 'b', ts: '2026-10-15T00:00:00.000Z' })])
    const windowed = await request(app(instance)).get('/api/projects/p1/agent-actions?from=2026-10-01T00:00:00Z')
    expect(windowed.status).toBe(200)
    expect(windowed.text.trim().split('\n').map(line => JSON.parse(line).run_id)).toEqual(['b'])
    expect((await request(app(instance)).get('/api/projects/p1/agent-actions?format=xml')).status).toBe(400)
    expect((await request(app(instance)).get('/api/projects/p1/agent-actions?from=yesterday')).status).toBe(400)
    expect((await request(app(instance)).get('/api/projects/p1/agent-actions?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).status).toBe(400)
    expect((await request(app(instance)).get('/api/projects/p1/jobs/x/audit?format=pdf')).status).toBe(400)
  })
})
