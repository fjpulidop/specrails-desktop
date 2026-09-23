/**
 * Track D — Concurrent write / lock tests
 *
 * True multi-process concurrency relies on OS O_EXCL which cannot be tested
 * in a single Vitest worker. These tests validate the sequential invariants
 * and lock-lifecycle guarantees of mutateStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { mutateStore, readStore, type Ticket } from './modules/specs/runtime/ticket-store'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTicket(id: number): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'test',
    source: 'manual',
  }
}

let tmpDir: string
let filePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-concurrent-'))
  filePath = path.join(tmpDir, '.claude', 'tickets.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── D1: Two sequential writes ────────────────────────────────────────────────

describe('D1: two sequential mutateStore calls', () => {
  it('results in revision=2 and both tickets present', () => {
    mutateStore(filePath, (store) => {
      store.tickets['1'] = makeTicket(1)
      store.next_id = 2
    })
    mutateStore(filePath, (store) => {
      store.tickets['2'] = makeTicket(2)
      store.next_id = 3
    })

    const store = readStore(filePath)
    expect(store.revision).toBe(2)
    expect(Object.keys(store.tickets)).toHaveLength(2)
    expect(store.tickets['1'].title).toBe('Ticket 1')
    expect(store.tickets['2'].title).toBe('Ticket 2')
  })
})

// ─── D2: N sequential writes ──────────────────────────────────────────────────

describe('D2: N sequential mutateStore calls', () => {
  const N = 10

  it(`results in revision=${N} and all ${N} tickets present`, () => {
    for (let i = 1; i <= N; i++) {
      mutateStore(filePath, (store) => {
        store.tickets[String(i)] = makeTicket(i)
        store.next_id = i + 1
      })
    }

    const store = readStore(filePath)
    expect(store.revision).toBe(N)
    expect(Object.keys(store.tickets)).toHaveLength(N)
    for (let i = 1; i <= N; i++) {
      expect(store.tickets[String(i)].title).toBe(`Ticket ${i}`)
    }
  })

  it('produces monotonically increasing revisions', () => {
    const revisions: number[] = []
    for (let i = 1; i <= N; i++) {
      const result = mutateStore(filePath, (store) => {
        store.tickets[String(i)] = makeTicket(i)
      })
      revisions.push(result.revision)
    }

    // Each revision should be strictly greater than the previous
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1])
    }
    expect(revisions[revisions.length - 1]).toBe(N)
  })
})

// ─── D3: Stale lock detection ─────────────────────────────────────────────────

describe('D3: stale lock (>10s old) is overridden', () => {
  it('proceeds when existing lock is stale', () => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })

    // Plant a stale lock (mtime 11 seconds in the past)
    const lockPath = filePath + '.lock'
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, '12345')
    fs.closeSync(fd)
    const staleTime = new Date(Date.now() - 11_000)
    fs.utimesSync(lockPath, staleTime, staleTime)

    // Should not throw — stale lock is detected and removed
    expect(() => {
      mutateStore(filePath, (store) => {
        store.tickets['1'] = makeTicket(1)
      })
    }).not.toThrow()

    const store = readStore(filePath)
    expect(store.tickets['1']).toBeDefined()
  })
})

// ─── D4: Lock cleanup after throw ─────────────────────────────────────────────

describe('D4: lock cleanup on mutator error', () => {
  it('releases the lock file when the mutator throws', () => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })

    expect(() =>
      mutateStore(filePath, () => {
        throw new Error('intentional failure')
      })
    ).toThrow('intentional failure')

    // Lock file must be gone
    expect(fs.existsSync(filePath + '.lock')).toBe(false)
  })

  it('allows a subsequent mutateStore after a throwing one', () => {
    expect(() =>
      mutateStore(filePath, () => {
        throw new Error('first call fails')
      })
    ).toThrow()

    // Second call should succeed
    mutateStore(filePath, (store) => {
      store.tickets['1'] = makeTicket(1)
    })

    const store = readStore(filePath)
    expect(store.revision).toBe(1)
    expect(store.tickets['1']).toBeDefined()
  })
})

// ─── Data integrity: all Ticket fields preserved ──────────────────────────────

describe('data integrity', () => {
  it('preserves all Ticket fields through a write/read cycle', () => {
    const fullTicket: Ticket = {
      id: 42,
      title: 'Integrity test',
      description: 'Full description',
      status: 'in_progress',
      priority: 'critical',
      labels: ['bug', 'area:backend', 'priority:high'],
      assignee: 'bob',
      prerequisites: [1, 2, 3],
      metadata: { effort_level: 'Large', vpc_scores: { complexity: 0.8 }, area: 'api' },
      created_at: '2026-01-15T10:00:00Z',
      updated_at: '2026-02-20T12:00:00Z',
      created_by: 'alice',
      source: 'product-backlog',
    }

    mutateStore(filePath, (store) => {
      store.tickets['42'] = fullTicket
      store.next_id = 43
    })

    const store = readStore(filePath)
    const t = store.tickets['42']

    expect(t.id).toBe(42)
    expect(t.title).toBe('Integrity test')
    expect(t.description).toBe('Full description')
    expect(t.status).toBe('in_progress')
    expect(t.priority).toBe('critical')
    expect(t.labels).toEqual(['bug', 'area:backend', 'priority:high'])
    expect(t.assignee).toBe('bob')
    expect(t.prerequisites).toEqual([1, 2, 3])
    expect(t.metadata.effort_level).toBe('Large')
    expect((t.metadata.vpc_scores as any).complexity).toBe(0.8)
    expect(t.created_at).toBe('2026-01-15T10:00:00Z')
    expect(t.created_by).toBe('alice')
    expect(t.source).toBe('product-backlog')
  })
})
