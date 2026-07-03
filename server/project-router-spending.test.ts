import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express, { type Request } from 'express'
import request from 'supertest'

import { registerSpendingRoutes, parseTzOffsetMinutes, localDayBoundsUtc } from './project-router-spending'
import { recordInvocation } from './ai-invocations'
import { mutateStore, type Ticket } from './ticket-store'
import { initDb, type DbInstance } from './db'
import type { ProjectContext } from './project-registry'
import type { ProjectRoutesDeps } from './project-router-helpers'

// ─── Harness ────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1'

function makeTicket(id: number, title: string): Ticket {
  const now = new Date().toISOString()
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    short_summary: null,
    created_at: now,
    updated_at: now,
    created_by: 'test',
    source: 'manual',
  }
}

interface Harness {
  app: express.Express
  db: DbInstance
  ticketStorePath: string
  tmpDir: string
}

function setup(): Harness {
  const db = initDb(':memory:')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spending-test-'))
  const ticketStorePath = path.join(tmpDir, 'local-tickets.json')

  const ctx = () => ({
    project: { id: PROJECT_ID, slug: 'proj', path: tmpDir, name: 'Proj' },
    db,
  }) as unknown as ProjectContext

  const router = express.Router()
  const deps = {
    router,
    registry: {} as never,
    ctx,
    ticketPath: (_req: Request) => ticketStorePath,
  } as ProjectRoutesDeps

  registerSpendingRoutes(deps)

  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)

  return { app, db, ticketStorePath, tmpDir }
}

function seedTicket(h: Harness, id: number, title: string): void {
  mutateStore(h.ticketStorePath, (store) => {
    store.tickets[String(id)] = makeTicket(id, title)
    if (store.next_id <= id) store.next_id = id + 1
  })
}

let seq = 0
function insert(
  db: DbInstance,
  opts: {
    surface?: string
    ticketId?: number | null
    provider?: string
    model?: string
    cost?: number | null
    estimated?: boolean
    status?: string
  } = {},
): void {
  recordInvocation(db, {
    id: `inv-${++seq}`,
    project_id: PROJECT_ID,
    provider: opts.provider ?? 'claude',
    surface: (opts.surface ?? 'job') as never,
    ticket_id: opts.ticketId ?? null,
    model: opts.model ?? 'sonnet',
    status: (opts.status ?? 'completed') as never,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    total_cost_usd: opts.cost === undefined ? 1.0 : opts.cost,
    total_cost_usd_estimated: opts.estimated ?? false,
    num_turns: 1,
  })
}

describe('project-router-spending', () => {
  let h: Harness
  beforeEach(() => {
    seq = 0
    h = setup()
  })
  afterEach(() => {
    h.db.close()
    fs.rmSync(h.tmpDir, { recursive: true, force: true })
  })

  // ─── BUG-ANALYTICS-18 / 36: /spending enriches topTickets titles ────────────
  describe('GET /spending — topTickets title enrichment', () => {
    it('populates ticketTitle for a live ticket (not "Deleted")', async () => {
      seedTicket(h, 7, 'Refactor auth flow')
      insert(h.db, { surface: 'job', ticketId: 7, cost: 2 })

      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/spending`)
      expect(res.status).toBe(200)
      const t = res.body.topTickets.find((x: { ticketId: number }) => x.ticketId === 7)
      expect(t.ticketTitle).toBe('Refactor auth flow')
      expect(t.isDeleted).toBe(false)
    })

    it('marks a ticket with spend but no store row as deleted', async () => {
      // store exists but ticket #99 was removed
      seedTicket(h, 1, 'Some other ticket')
      insert(h.db, { surface: 'job', ticketId: 99, cost: 3 })

      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/spending`)
      const t = res.body.topTickets.find((x: { ticketId: number }) => x.ticketId === 99)
      expect(t.ticketTitle).toBeNull()
      expect(t.isDeleted).toBe(true)
    })

    it('leaves the unattributed bucket title null', async () => {
      insert(h.db, { surface: 'job', ticketId: null, cost: 1 })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/spending`)
      const u = res.body.topTickets.find((x: { ticketId: number | null }) => x.ticketId === null)
      expect(u.ticketTitle).toBeNull()
    })
  })

  // ─── BUG-ANALYTICS-36: per-ticket modal endpoint carries a title ────────────
  describe('GET /tickets/:id/spending-summary — title in payload', () => {
    it('merges ticketTitle + isDeleted onto the summary', async () => {
      seedTicket(h, 5, 'Ship the dashboard')
      insert(h.db, { surface: 'job', ticketId: 5, cost: 4 })

      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/tickets/5/spending-summary`)
      expect(res.status).toBe(200)
      expect(res.body.ticketTitle).toBe('Ship the dashboard')
      expect(res.body.isDeleted).toBe(false)
      // legacy fields preserved
      expect(res.body.totalCostUsd).toBe(4)
    })

    it('reports isDeleted=true for a ticket missing from the store', async () => {
      seedTicket(h, 1, 'present')
      insert(h.db, { surface: 'job', ticketId: 42, cost: 1 })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/tickets/42/spending-summary`)
      expect(res.body.ticketTitle).toBeNull()
      expect(res.body.isDeleted).toBe(true)
    })
  })

  // ─── BUG-ANALYTICS-19: /invocations truncation flag on the limit path ───────
  describe('GET /invocations — truncation flag', () => {
    it('sets truncated when totalAvailable exceeds returned rows (limit path)', async () => {
      for (let i = 0; i < 5; i++) insert(h.db, { surface: 'job', cost: 1 })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/invocations?limit=2`)
      expect(res.status).toBe(200)
      expect(res.body.rows.length).toBe(2)
      expect(res.body.totalAvailable).toBe(5)
      expect(res.body.truncated).toBe(true)
    })

    it('keeps truncated=false when every row is returned', async () => {
      for (let i = 0; i < 3; i++) insert(h.db, { surface: 'job', cost: 1 })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/invocations?limit=50`)
      expect(res.body.rows.length).toBe(3)
      expect(res.body.truncated).toBe(false)
    })
  })

  // ─── BUG-ANALYTICS-06: raw CSV header carries provider + estimated ──────────
  describe('GET /analytics/export?mode=raw&format=csv — provider + estimated', () => {
    it('includes provider and total_cost_usd_estimated columns', async () => {
      insert(h.db, { surface: 'job', provider: 'codex', model: 'gpt-5.5', cost: 0.5, estimated: true })
      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=raw&format=csv`)
      expect(res.status).toBe(200)
      const [header, ...rows] = res.text.split('\n')
      expect(header).toContain('provider')
      expect(header).toContain('total_cost_usd_estimated')
      // codex estimated row distinguishable from a claude authoritative one
      const cols = header.split(',')
      const providerIdx = cols.indexOf('provider')
      const estIdx = cols.indexOf('total_cost_usd_estimated')
      const dataRow = rows[0].split(',')
      expect(dataRow[providerIdx]).toBe('codex')
      expect(dataRow[estIdx]).toBe('1')
    })

    it('stamps claude / non-estimated for a claude row', async () => {
      insert(h.db, { surface: 'job', provider: 'claude', cost: 2, estimated: false })
      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=raw&format=csv`)
      const [header, dataLine] = res.text.split('\n')
      const cols = header.split(',')
      const dataRow = dataLine.split(',')
      expect(dataRow[cols.indexOf('provider')]).toBe('claude')
      expect(dataRow[cols.indexOf('total_cost_usd_estimated')]).toBe('0')
    })
  })

  // ─── BUG-ANALYTICS-16: summary CSV daily timeline carries loopCostUsd ───────
  // ─── BUG-ANALYTICS-17/36: summary CSV top tickets carries all 7 + title ────
  describe('GET /analytics/export?mode=summary&format=csv', () => {
    it('daily timeline header + rows include loopCostUsd', async () => {
      insert(h.db, { surface: 'loop', provider: 'codex', cost: 0.3, estimated: true })
      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=summary&format=csv`)
      expect(res.status).toBe(200)
      const lines = res.text.split('\n')
      const dailyHeaderIdx = lines.findIndex((l) => l === '# Daily timeline')
      const dailyHeader = lines[dailyHeaderIdx + 1]
      expect(dailyHeader.split(',')).toContain('loopCostUsd')
      // the loop column must precede totalCostUsd (reconciliation column order)
      const dh = dailyHeader.split(',')
      expect(dh.indexOf('loopCostUsd')).toBeLessThan(dh.indexOf('totalCostUsd'))
    })

    it('top tickets section carries title + all 7 surface cost columns', async () => {
      seedTicket(h, 3, 'Loop work')
      insert(h.db, { surface: 'loop', ticketId: 3, provider: 'codex', cost: 1, estimated: true })
      insert(h.db, { surface: 'smash', ticketId: 3, cost: 0.2 })
      insert(h.db, { surface: 'file-summary', ticketId: 3, cost: 0.1 })

      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=summary&format=csv`)
      const lines = res.text.split('\n')
      const topIdx = lines.findIndex((l) => l === '# Top tickets')
      const header = lines[topIdx + 1].split(',')
      expect(header).toContain('ticketTitle')
      expect(header).toContain('smashCost')
      expect(header).toContain('fileSummaryCost')
      expect(header).toContain('loopCost')

      const dataRow = lines[topIdx + 2].split(',')
      // ticketTitle column populated with the live title
      expect(dataRow[header.indexOf('ticketTitle')]).toBe('Loop work')
      // smash / file-summary / loop cost columns now emitted (non-zero)
      expect(Number(dataRow[header.indexOf('loopCost')])).toBeCloseTo(1)
      expect(Number(dataRow[header.indexOf('smashCost')])).toBeCloseTo(0.2)
      expect(Number(dataRow[header.indexOf('fileSummaryCost')])).toBeCloseTo(0.1)
    })

    it('summary JSON export still enriches topTickets titles (BUG-36)', async () => {
      seedTicket(h, 8, 'Json ticket')
      insert(h.db, { surface: 'job', ticketId: 8, cost: 1 })
      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=summary&format=json`)
      const t = res.body.topTickets.find((x: { ticketId: number }) => x.ticketId === 8)
      expect(t.ticketTitle).toBe('Json ticket')
    })
  })

  // ─── MED-6: GET /budget costToday sums ALL ai_invocations surfaces/statuses ──
  describe('GET /budget — costToday over all surfaces (MED-6)', () => {
    it('sums every ai_invocations surface (not just the jobs table)', async () => {
      insert(h.db, { surface: 'job', cost: 1, status: 'success' })
      insert(h.db, { surface: 'explore-spec', cost: 2, status: 'success' })
      insert(h.db, { surface: 'ai-edit', cost: 0.5, status: 'success' })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/budget`)
      expect(res.status).toBe(200)
      // Previously this read `FROM jobs` (0 rows here) → costToday 0; now 3.5.
      expect(res.body.costToday).toBeCloseTo(3.5, 5)
    })

    it('counts non-success statuses (failed/aborted billed runs)', async () => {
      insert(h.db, { surface: 'job', cost: 1, status: 'success' })
      insert(h.db, { surface: 'job', cost: 0.4, status: 'failed' })
      insert(h.db, { surface: 'explore-spec', cost: 0.2, status: 'aborted' })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/budget`)
      expect(res.body.costToday).toBeCloseTo(1.6, 5)
    })

    it('computes budgetUtilizationPct against the daily budget', async () => {
      h.db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '10')`).run()
      insert(h.db, { surface: 'job', cost: 2.5, status: 'success' })
      const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/budget`)
      expect(res.body.dailyBudgetUsd).toBe(10)
      expect(res.body.budgetUtilizationPct).toBeCloseTo(25, 5)
    })
  })

  // ─── LOW-3: summary CSV '# By model' reconciles to '# Totals' ────────────────
  describe('GET /analytics/export?mode=summary — By model reconciliation (LOW-3)', () => {
    it('appends a remainder row so By model sums to Totals (NULL-model spend)', async () => {
      insert(h.db, { surface: 'job', model: 'sonnet', cost: 2, status: 'success' })
      // A killed/aborted claude run with NULL model + NULL... actually NULL model,
      // real cost — excluded from byModel but present in the grand total.
      recordInvocation(h.db, {
        id: 'inv-nullmodel',
        project_id: PROJECT_ID,
        provider: 'claude',
        surface: 'job',
        model: null,
        status: 'success',
        started_at: new Date().toISOString(),
        total_cost_usd: 0.75,
        total_cost_usd_estimated: false,
      } as Parameters<typeof recordInvocation>[1])

      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=summary&format=csv&period=all`)
      expect(res.status).toBe(200)
      const lines = res.text.split('\n')
      const byModelIdx = lines.findIndex((l) => l === '# By model')
      // Rows follow until the next blank line.
      const section: string[] = []
      for (let i = byModelIdx + 2; i < lines.length && lines[i] !== ''; i++) section.push(lines[i])
      // costUsd is the 3rd column; sum every row (incl. the remainder row).
      const sectionSum = section.reduce((s, row) => {
        const cols = row.split(',')
        return s + Number(cols[cols.length - 1])
      }, 0)

      const totalsIdx = lines.findIndex((l) => l === '# Totals')
      const totalCostUsd = Number(lines[totalsIdx + 2].split(',')[0])

      expect(sectionSum).toBeCloseTo(totalCostUsd, 6)
      expect(section.some((r) => r.startsWith('(other / unmodeled)'))).toBe(true)
    })

    it('omits the remainder row when By model already reconciles', async () => {
      insert(h.db, { surface: 'job', model: 'sonnet', cost: 2, status: 'success' })
      const res = await request(h.app)
        .get(`/api/projects/${PROJECT_ID}/analytics/export?mode=summary&format=csv&period=all`)
      const lines = res.text.split('\n')
      expect(lines.some((l) => l.startsWith('(other / unmodeled)'))).toBe(false)
    })
  })

  // ─── Absent-store path mirrors /invocations (empty store ⇒ no title) ───────
  it('reports null title for spend against an absent ticket store', async () => {
    insert(h.db, { surface: 'job', ticketId: 7, cost: 1 })
    // no seedTicket → store file never created; readStore returns an empty store
    // on ENOENT (same as the /invocations enrichment path), so the ticket has no
    // title and is treated as deleted.
    const res = await request(h.app).get(`/api/projects/${PROJECT_ID}/spending`)
    const t = res.body.topTickets.find((x: { ticketId: number }) => x.ticketId === 7)
    expect(t.ticketTitle).toBeNull()
    expect(t.isDeleted).toBe(true)
  })
})

// ─── Helper units (MED-6) ─────────────────────────────────────────────────────

describe('parseTzOffsetMinutes', () => {
  it('parses a valid offset', () => {
    expect(parseTzOffsetMinutes('600')).toBe(600)
    expect(parseTzOffsetMinutes('-300')).toBe(-300)
    expect(parseTzOffsetMinutes('0')).toBe(0)
  })
  it('falls back to 0 for non-string / non-numeric / out-of-range', () => {
    expect(parseTzOffsetMinutes(undefined)).toBe(0)
    expect(parseTzOffsetMinutes(600)).toBe(0) // not a string
    expect(parseTzOffsetMinutes('abc')).toBe(0)
    expect(parseTzOffsetMinutes('9999')).toBe(0) // beyond ±840
  })
})

describe('localDayBoundsUtc', () => {
  it('UTC (offset 0) bounds the calendar day', () => {
    const now = Date.parse('2026-07-02T15:30:00Z')
    const { startIso, endIso } = localDayBoundsUtc(0, now)
    expect(startIso).toBe('2026-07-02T00:00:00.000Z')
    expect(endIso).toBe('2026-07-03T00:00:00.000Z')
  })

  it('shifts the boundary to the user local day (UTC+2)', () => {
    // 23:30Z is 01:30 local the NEXT day → local day 2026-07-03.
    const now = Date.parse('2026-07-02T23:30:00Z')
    const { startIso, endIso } = localDayBoundsUtc(120, now)
    expect(startIso).toBe('2026-07-02T22:00:00.000Z')
    expect(endIso).toBe('2026-07-03T22:00:00.000Z')
  })

  it('shifts the boundary west of UTC (UTC-5)', () => {
    // 02:00Z is 21:00 local the PREVIOUS day → local day 2026-07-01.
    const now = Date.parse('2026-07-02T02:00:00Z')
    const { startIso, endIso } = localDayBoundsUtc(-300, now)
    expect(startIso).toBe('2026-07-01T05:00:00.000Z')
    expect(endIso).toBe('2026-07-02T05:00:00.000Z')
  })
})
