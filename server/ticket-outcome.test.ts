import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  applyJobOutcomeToTickets,
  mutateStore,
  readStore,
  type Ticket,
  type TicketStatus,
  type TicketStore,
} from './ticket-store'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTicket(id: number, status: TicketStatus, extra: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    description: '',
    status,
    priority: status === 'draft' ? null : 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    short_summary: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'test',
    source: 'manual',
    ...extra,
  }
}

function makeStore(tickets: Ticket[]): TicketStore {
  const map: Record<string, Ticket> = {}
  for (const t of tickets) map[String(t.id)] = t
  return {
    schema_version: '1.3',
    revision: 1,
    last_updated: '2026-01-01T00:00:00.000Z',
    next_id: tickets.length + 1,
    tickets: map,
  }
}

const NOW = '2026-06-09T12:00:00.000Z'

// ─── applyJobOutcomeToTickets ───────────────────────────────────────────────────

describe('applyJobOutcomeToTickets', () => {
  describe('completed', () => {
    it('promotes a todo spec to done', () => {
      const store = makeStore([makeTicket(1, 'todo')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['1'].updated_at).toBe(NOW)
    })

    it('promotes an in_progress spec to done', () => {
      const store = makeStore([makeTicket(1, 'in_progress')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('done')
    })

    it('does NOT resurrect a draft spec into done', () => {
      const store = makeStore([makeTicket(1, 'draft')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('draft')
    })

    it('does NOT resurrect a cancelled spec into done', () => {
      const store = makeStore([makeTicket(1, 'cancelled')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('cancelled')
    })

    it('clears a needs_review flag on clean completion (already done)', () => {
      const store = makeStore([makeTicket(1, 'done', { needs_review: true })])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['1'].needs_review).toBeUndefined()
    })

    it('leaves an already-done spec with no flag untouched', () => {
      const store = makeStore([makeTicket(1, 'done')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].updated_at).toBe('2026-01-01T00:00:00.000Z')
    })

    it('marks every ticket of a multi-spec job done (batch)', () => {
      const store = makeStore([makeTicket(1, 'todo'), makeTicket(2, 'in_progress'), makeTicket(3, 'todo')])
      const changed = applyJobOutcomeToTickets(store, [1, 2, 3], 'completed', NOW)
      expect(changed.sort()).toEqual([1, 2, 3])
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['2'].status).toBe('done')
      expect(store.tickets['3'].status).toBe('done')
    })

    it('does NOT promote an on_review spec to done (only the PR-decision endpoint moves it)', () => {
      const store = makeStore([makeTicket(1, 'on_review')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('on_review')
    })

    it('regression pin: default (no opts) and empty opts both promote to done', () => {
      const store = makeStore([makeTicket(1, 'todo'), makeTicket(2, 'in_progress')])
      applyJobOutcomeToTickets(store, [1], 'completed', NOW)
      applyJobOutcomeToTickets(store, [2], 'completed', NOW, {})
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['2'].status).toBe('done')
    })
  })

  describe("completed with completedStatus: 'on_review' (ask-first PR delivery)", () => {
    const OPTS = { completedStatus: 'on_review' as const }

    it('promotes a todo spec to on_review', () => {
      const store = makeStore([makeTicket(1, 'todo')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW, OPTS)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('on_review')
      expect(store.tickets['1'].updated_at).toBe(NOW)
    })

    it('promotes an in_progress spec to on_review', () => {
      const store = makeStore([makeTicket(1, 'in_progress')])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW, OPTS)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('on_review')
    })

    it('leaves draft, done and cancelled specs untouched (same guard set as done)', () => {
      const store = makeStore([makeTicket(1, 'draft'), makeTicket(2, 'done'), makeTicket(3, 'cancelled')])
      const changed = applyJobOutcomeToTickets(store, [1, 2, 3], 'completed', NOW, OPTS)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('draft')
      expect(store.tickets['2'].status).toBe('done')
      expect(store.tickets['3'].status).toBe('cancelled')
    })

    it('still clears a needs_review flag on an already-done spec (kept done, not demoted)', () => {
      const store = makeStore([makeTicket(1, 'done', { needs_review: true })])
      const changed = applyJobOutcomeToTickets(store, [1], 'completed', NOW, OPTS)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['1'].needs_review).toBeUndefined()
    })

    it('promotes a whole batch to on_review', () => {
      const store = makeStore([makeTicket(1, 'todo'), makeTicket(2, 'in_progress')])
      const changed = applyJobOutcomeToTickets(store, [1, 2], 'completed', NOW, OPTS)
      expect(changed.sort()).toEqual([1, 2])
      expect(store.tickets['1'].status).toBe('on_review')
      expect(store.tickets['2'].status).toBe('on_review')
    })
  })

  describe.each(['failed', 'canceled', 'zombie_terminated'] as const)('%s', (outcome) => {
    it('reverts an in_progress spec back to todo (→ Specs column)', () => {
      const store = makeStore([makeTicket(1, 'in_progress')])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('todo')
      expect(store.tickets['1'].updated_at).toBe(NOW)
    })

    it('leaves a todo spec in todo (no-op, stays in Specs)', () => {
      const store = makeStore([makeTicket(1, 'todo')])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('todo')
    })

    it('flags an already-done spec for review but keeps it in done', () => {
      const store = makeStore([makeTicket(1, 'done')])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW)
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('done')
      expect(store.tickets['1'].needs_review).toBe(true)
    })

    it('does not double-flag a spec already needing review', () => {
      const store = makeStore([makeTicket(1, 'done', { needs_review: true })])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW)
      expect(changed).toEqual([])
    })

    it('does not touch a draft or cancelled spec', () => {
      const store = makeStore([makeTicket(1, 'draft'), makeTicket(2, 'cancelled')])
      const changed = applyJobOutcomeToTickets(store, [1, 2], outcome, NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('draft')
      expect(store.tickets['2'].status).toBe('cancelled')
    })

    it("still reverts in_progress to todo when completedStatus opts are passed (opts only affect 'completed')", () => {
      const store = makeStore([makeTicket(1, 'in_progress')])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW, { completedStatus: 'on_review' })
      expect(changed).toEqual([1])
      expect(store.tickets['1'].status).toBe('todo')
    })

    it('does not touch an on_review spec (only the PR-decision endpoint moves it)', () => {
      const store = makeStore([makeTicket(1, 'on_review')])
      const changed = applyJobOutcomeToTickets(store, [1], outcome, NOW)
      expect(changed).toEqual([])
      expect(store.tickets['1'].status).toBe('on_review')
    })
  })

  it('ignores ids with no matching ticket', () => {
    const store = makeStore([makeTicket(1, 'todo')])
    const changed = applyJobOutcomeToTickets(store, [99], 'completed', NOW)
    expect(changed).toEqual([])
  })

  it('handles a mixed batch: revert in_progress, flag done, skip todo (failed)', () => {
    const store = makeStore([
      makeTicket(1, 'in_progress'),
      makeTicket(2, 'done'),
      makeTicket(3, 'todo'),
    ])
    const changed = applyJobOutcomeToTickets(store, [1, 2, 3], 'failed', NOW)
    expect(changed.sort()).toEqual([1, 2])
    expect(store.tickets['1'].status).toBe('todo')
    expect(store.tickets['2'].status).toBe('done')
    expect(store.tickets['2'].needs_review).toBe(true)
    expect(store.tickets['3'].status).toBe('todo')
  })
})

// ─── Atomic writeStore + needs_review round-trip ────────────────────────────────

describe('writeStore atomicity + needs_review persistence', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-outcome-'))
    file = path.join(dir, '.specrails', 'local-tickets.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('persists needs_review through a mutate → read round-trip', () => {
    mutateStore(file, (store) => {
      store.tickets['1'] = makeTicket(1, 'done', { needs_review: true })
    })
    const reloaded = readStore(file)
    expect(reloaded.tickets['1'].needs_review).toBe(true)
  })

  it('clearing needs_review removes the field on next write', () => {
    mutateStore(file, (store) => {
      store.tickets['1'] = makeTicket(1, 'done', { needs_review: true })
    })
    mutateStore(file, (store) => {
      applyJobOutcomeToTickets(store, [1], 'completed', NOW)
    })
    const reloaded = readStore(file)
    expect(reloaded.tickets['1'].needs_review).toBeUndefined()
  })

  it('leaves no temp file behind after a write', () => {
    mutateStore(file, (store) => {
      store.tickets['1'] = makeTicket(1, 'todo')
    })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(file + '.tmp')).toBe(false)
    // The persisted file is valid JSON (never half-written).
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(parsed.tickets['1'].id).toBe(1)
  })

  it('bumps revision on each atomic write', () => {
    const s1 = mutateStore(file, (store) => { store.tickets['1'] = makeTicket(1, 'todo') })
    const s2 = mutateStore(file, (store) => { store.tickets['1'].status = 'done' })
    expect(s2.revision).toBe(s1.revision + 1)
    expect(readStore(file).revision).toBe(s2.revision)
  })
})
