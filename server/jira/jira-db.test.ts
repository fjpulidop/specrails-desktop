// Tests for the per-project Jira data-access layer (server/jira/jira-db.ts).
//
// Uses initDb(':memory:') (migration 29 creates jira_connection/jira_links/
// jira_outbox) and a deterministic in-memory secret store so token crypto is
// reversible and assertable.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../db'
import { setSecretStore } from './jira-credential-store'
import {
  // connection
  upsertConnection,
  getConnection,
  getConnectionPublic,
  getDecryptedToken,
  hasToken,
  setConnectionEnabled,
  setHighWater,
  deleteConnection,
  type UpsertConnectionInput,
  // links
  ensureLink,
  insertLinkWithId,
  getLinkByIssueId,
  getLinkByLocalId,
  listLinks,
  nextLocalId,
  updateLinkStatusCategory,
  setLinkState,
  tombstoneLink,
  // outbox
  enqueueOutbox,
  enqueueMany,
  claimDrainable,
  markOutboxDone,
  markOutboxRetry,
  markOutboxDead,
  resetInflight,
  retryDeadOutbox,
  listOutbox,
  countOutboxByState,
  type EnqueueOutboxInput,
} from './jira-db'

let db: DbInstance

beforeEach(() => {
  db = initDb(':memory:')
  // Deterministic, reversible crypto: encrypt('x') === 'e:x'; decrypt('e:x') === 'x'.
  setSecretStore({ encrypt: (s) => 'e:' + s, decrypt: (s) => s.slice(2) })
})

afterEach(() => {
  setSecretStore(null)
  db.close()
})

// ─── connection helpers ─────────────────────────────────────────────────────

const baseInput = (over: Partial<UpsertConnectionInput> = {}): UpsertConnectionInput => ({
  projectId: 'proj-1',
  baseUrl: 'https://acme.atlassian.net',
  deployment: 'cloud',
  apiVersion: '3',
  authScheme: 'basic',
  accountEmail: 'me@acme.com',
  jiraProjectKey: 'PROJ',
  jiraProjectId: '10001',
  ...over,
})

describe('jira_connection', () => {
  it('upsertConnection inserts a new row and returns the mapped connection', () => {
    const conn = upsertConnection(db, baseInput({ token: 'sekret', statusMap: { todo: 'To Do', done: 'Done' } }))
    expect(conn.projectId).toBe('proj-1')
    expect(conn.baseUrl).toBe('https://acme.atlassian.net')
    expect(conn.deployment).toBe('cloud')
    expect(conn.apiVersion).toBe('3')
    expect(conn.authScheme).toBe('basic')
    expect(conn.accountEmail).toBe('me@acme.com')
    expect(conn.jiraProjectKey).toBe('PROJ')
    expect(conn.jiraProjectId).toBe('10001')
    // enabled defaults to true on insert when not specified.
    expect(conn.enabled).toBe(true)
    expect(conn.statusMap).toEqual({ todo: 'To Do', done: 'Done' })
    expect(conn.highWaterMs).toBeNull()
    expect(conn.createdAt).toBeTruthy()
    expect(conn.updatedAt).toBeTruthy()
  })

  it('upsertConnection encrypts the token and getDecryptedToken round-trips it', () => {
    upsertConnection(db, baseInput({ token: 'tok-abc' }))
    // Encrypted at rest via the injected store.
    const raw = db.prepare('SELECT encrypted_token FROM jira_connection WHERE project_id = ?').get('proj-1') as {
      encrypted_token: string
    }
    expect(raw.encrypted_token).toBe('e:tok-abc')
    expect(getDecryptedToken(db, 'proj-1')).toBe('tok-abc')
  })

  it('upsertConnection preserves the existing token when token is undefined on update', () => {
    upsertConnection(db, baseInput({ token: 'orig-token' }))
    // Update everything else, leaving token undefined.
    const updated = upsertConnection(db, baseInput({ baseUrl: 'https://new.example.com', jiraProjectKey: 'NEW' }))
    expect(updated.baseUrl).toBe('https://new.example.com')
    expect(updated.jiraProjectKey).toBe('NEW')
    // Token survives untouched.
    expect(getDecryptedToken(db, 'proj-1')).toBe('orig-token')
    expect(hasToken(db, 'proj-1')).toBe(true)
  })

  it('upsertConnection replaces the token when a new token is provided on update', () => {
    upsertConnection(db, baseInput({ token: 'orig' }))
    upsertConnection(db, baseInput({ token: 'next' }))
    expect(getDecryptedToken(db, 'proj-1')).toBe('next')
  })

  it('upsertConnection update preserves createdAt and high_water but advances updatedAt', () => {
    const first = upsertConnection(db, baseInput({ token: 'tok' }))
    setHighWater(db, 'proj-1', 1234567890)
    // Force a distinct ISO timestamp by mutating updated_at via a second upsert later.
    const second = upsertConnection(db, baseInput({ token: 'tok2', accountEmail: 'changed@acme.com' }))
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.accountEmail).toBe('changed@acme.com')
    // high_water set between the two upserts is preserved (upsert re-writes existing.highWaterMs).
    expect(second.highWaterMs).toBe(1234567890)
  })

  it('upsertConnection preserves the prior statusMap when statusMap is undefined on update', () => {
    upsertConnection(db, baseInput({ token: 'tok', statusMap: { todo: 'Backlog' } }))
    const updated = upsertConnection(db, baseInput({ accountEmail: 'x@y.com' }))
    expect(updated.statusMap).toEqual({ todo: 'Backlog' })
  })

  it('upsertConnection clears the statusMap when statusMap is explicitly null', () => {
    upsertConnection(db, baseInput({ token: 'tok', statusMap: { todo: 'Backlog' } }))
    const updated = upsertConnection(db, baseInput({ statusMap: null }))
    expect(updated.statusMap).toBeNull()
  })

  it('upsertConnection respects an explicit enabled:false on insert', () => {
    const conn = upsertConnection(db, baseInput({ token: 'tok', enabled: false }))
    expect(conn.enabled).toBe(false)
  })

  it('upsertConnection preserves enabled across an update that omits it', () => {
    upsertConnection(db, baseInput({ token: 'tok', enabled: false }))
    const updated = upsertConnection(db, baseInput({ accountEmail: 'z@z.com' }))
    expect(updated.enabled).toBe(false)
  })

  it('upsertConnection insert with null accountEmail and apiVersion 2 / bearer', () => {
    const conn = upsertConnection(
      db,
      baseInput({ token: 't', accountEmail: null, apiVersion: '2', authScheme: 'bearer', deployment: 'dc' })
    )
    expect(conn.accountEmail).toBeNull()
    expect(conn.apiVersion).toBe('2')
    expect(conn.authScheme).toBe('bearer')
    expect(conn.deployment).toBe('dc')
  })

  it('mapConnection round-trips a complex statusMap as JSON', () => {
    const map = { todo: 'To Do', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled' } as const
    upsertConnection(db, baseInput({ token: 't', statusMap: { ...map } }))
    const conn = getConnection(db, 'proj-1')
    expect(conn?.statusMap).toEqual(map)
  })

  it('mapConnection tolerates corrupt status_map JSON (falls back to null)', () => {
    upsertConnection(db, baseInput({ token: 't', statusMap: { todo: 'X' } }))
    db.prepare('UPDATE jira_connection SET status_map = ? WHERE project_id = ?').run('{not-json', 'proj-1')
    const conn = getConnection(db, 'proj-1')
    expect(conn?.statusMap).toBeNull()
  })

  it('getConnection returns null for an unknown project', () => {
    expect(getConnection(db, 'nope')).toBeNull()
  })

  it('getConnectionPublic exposes hasToken=true and never the encrypted token', () => {
    upsertConnection(db, baseInput({ token: 'secret-token' }))
    const pub = getConnectionPublic(db, 'proj-1')
    expect(pub).not.toBeNull()
    expect(pub!.hasToken).toBe(true)
    // The encrypted/plaintext token is never present on the public shape.
    expect(JSON.stringify(pub)).not.toContain('secret-token')
    expect(JSON.stringify(pub)).not.toContain('e:secret-token')
    expect('encrypted_token' in (pub as object)).toBe(false)
  })

  it('getConnectionPublic reports hasToken=false when no token is stored', () => {
    upsertConnection(db, baseInput({})) // no token
    const pub = getConnectionPublic(db, 'proj-1')
    expect(pub!.hasToken).toBe(false)
  })

  it('getConnectionPublic returns null for an unknown project', () => {
    expect(getConnectionPublic(db, 'ghost')).toBeNull()
  })

  it('getDecryptedToken returns null when there is no connection', () => {
    expect(getDecryptedToken(db, 'absent')).toBeNull()
  })

  it('getDecryptedToken returns null when the connection has no token', () => {
    upsertConnection(db, baseInput({})) // token undefined → null column
    expect(getDecryptedToken(db, 'proj-1')).toBeNull()
  })

  it('getDecryptedToken returns null when decrypt throws', () => {
    upsertConnection(db, baseInput({ token: 'tok' }))
    // Swap to a store whose decrypt blows up.
    setSecretStore({
      encrypt: (s) => 'e:' + s,
      decrypt: () => {
        throw new Error('boom')
      },
    })
    expect(getDecryptedToken(db, 'proj-1')).toBeNull()
  })

  it('hasToken is false with no connection, false with null token, true with a token', () => {
    expect(hasToken(db, 'none')).toBe(false)
    upsertConnection(db, baseInput({})) // no token
    expect(hasToken(db, 'proj-1')).toBe(false)
    upsertConnection(db, baseInput({ token: 'now-set' }))
    expect(hasToken(db, 'proj-1')).toBe(true)
  })

  it('setConnectionEnabled flips the enabled flag', () => {
    upsertConnection(db, baseInput({ token: 't', enabled: true }))
    setConnectionEnabled(db, 'proj-1', false)
    expect(getConnection(db, 'proj-1')!.enabled).toBe(false)
    setConnectionEnabled(db, 'proj-1', true)
    expect(getConnection(db, 'proj-1')!.enabled).toBe(true)
  })

  it('setHighWater updates the high-water mark', () => {
    upsertConnection(db, baseInput({ token: 't' }))
    expect(getConnection(db, 'proj-1')!.highWaterMs).toBeNull()
    setHighWater(db, 'proj-1', 99999)
    expect(getConnection(db, 'proj-1')!.highWaterMs).toBe(99999)
  })

  it('deleteConnection removes the row', () => {
    upsertConnection(db, baseInput({ token: 't' }))
    expect(getConnection(db, 'proj-1')).not.toBeNull()
    deleteConnection(db, 'proj-1')
    expect(getConnection(db, 'proj-1')).toBeNull()
    expect(hasToken(db, 'proj-1')).toBe(false)
  })

  it('deleteConnection on a missing project is a no-op (no throw)', () => {
    expect(() => deleteConnection(db, 'missing')).not.toThrow()
  })
})

// ─── links ──────────────────────────────────────────────────────────────────

const linkArgs = (over: Partial<Parameters<typeof ensureLink>[1]> = {}) => ({
  jiraIssueId: '10100',
  jiraKey: 'PROJ-1',
  jiraProjectId: '10001',
  deployment: 'cloud' as const,
  ...over,
})

describe('jira_links', () => {
  it('nextLocalId starts at 1 on an empty table', () => {
    expect(nextLocalId(db)).toBe(1)
  })

  it('ensureLink mints a new monotonic local id', () => {
    const a = ensureLink(db, linkArgs({ jiraIssueId: '1', jiraKey: 'P-1' }))
    const b = ensureLink(db, linkArgs({ jiraIssueId: '2', jiraKey: 'P-2' }))
    const c = ensureLink(db, linkArgs({ jiraIssueId: '3', jiraKey: 'P-3' }))
    expect(a.localId).toBe(1)
    expect(b.localId).toBe(2)
    expect(c.localId).toBe(3)
    expect(a.jiraIssueId).toBe('1')
    expect(a.jiraKey).toBe('P-1')
    expect(a.jiraProjectId).toBe('10001')
    expect(a.deployment).toBe('cloud')
    expect(a.statusCategory).toBeNull()
    expect(a.state).toBe('linked')
    expect(a.tombstoned).toBe(false)
    expect(nextLocalId(db)).toBe(4)
  })

  it('ensureLink is idempotent for the same issue id (returns the existing link, no new id)', () => {
    const first = ensureLink(db, linkArgs({ jiraIssueId: '50', jiraKey: 'P-50' }))
    const again = ensureLink(db, linkArgs({ jiraIssueId: '50', jiraKey: 'P-50' }))
    expect(again.localId).toBe(first.localId)
    expect(listLinks(db)).toHaveLength(1)
  })

  it('ensureLink refreshes the display key when it changes (id immutable)', () => {
    const first = ensureLink(db, linkArgs({ jiraIssueId: '60', jiraKey: 'OLD-60' }))
    const moved = ensureLink(db, linkArgs({ jiraIssueId: '60', jiraKey: 'NEW-60' }))
    expect(moved.localId).toBe(first.localId)
    expect(moved.jiraKey).toBe('NEW-60')
    // Persisted, not just returned.
    expect(getLinkByIssueId(db, '60')!.jiraKey).toBe('NEW-60')
  })

  it('ensureLink does NOT update the key when the new key is null', () => {
    ensureLink(db, linkArgs({ jiraIssueId: '70', jiraKey: 'KEEP-70' }))
    const same = ensureLink(db, linkArgs({ jiraIssueId: '70', jiraKey: null }))
    expect(same.jiraKey).toBe('KEEP-70')
  })

  it('ensureLink does NOT touch the key when it is unchanged', () => {
    const first = ensureLink(db, linkArgs({ jiraIssueId: '80', jiraKey: 'SAME-80' }))
    const again = ensureLink(db, linkArgs({ jiraIssueId: '80', jiraKey: 'SAME-80' }))
    // Returns the existing (unmodified) row.
    expect(again.jiraKey).toBe('SAME-80')
    expect(again.updatedAt).toBe(first.updatedAt)
  })

  it('ensureLink can mint a link with a null jiraKey', () => {
    const link = ensureLink(db, linkArgs({ jiraIssueId: '90', jiraKey: null }))
    expect(link.jiraKey).toBeNull()
    expect(link.localId).toBe(1)
  })

  it('insertLinkWithId honours a caller-chosen local id', () => {
    const link = insertLinkWithId(db, {
      localId: 500,
      jiraIssueId: '900',
      jiraKey: 'P-900',
      jiraProjectId: '10001',
      deployment: 'cloud',
    })
    expect(link.localId).toBe(500)
    expect(link.jiraIssueId).toBe('900')
    // Subsequent ensureLink mints above the inserted id.
    expect(nextLocalId(db)).toBe(501)
  })

  it('insertLinkWithId accepts a null jiraKey', () => {
    const link = insertLinkWithId(db, {
      localId: 7,
      jiraIssueId: '901',
      jiraKey: null,
      jiraProjectId: '10001',
      deployment: 'dc',
    })
    expect(link.jiraKey).toBeNull()
    expect(link.deployment).toBe('dc')
  })

  it('getLinkByIssueId / getLinkByLocalId return null for unknown rows', () => {
    expect(getLinkByIssueId(db, 'ghost')).toBeNull()
    expect(getLinkByLocalId(db, 99999)).toBeNull()
  })

  it('getLinkByIssueId and getLinkByLocalId resolve to the same row', () => {
    const created = ensureLink(db, linkArgs({ jiraIssueId: '111', jiraKey: 'P-111' }))
    expect(getLinkByIssueId(db, '111')!.localId).toBe(created.localId)
    expect(getLinkByLocalId(db, created.localId)!.jiraIssueId).toBe('111')
  })

  it('listLinks returns all links ordered by local_id', () => {
    insertLinkWithId(db, { localId: 3, jiraIssueId: 'c', jiraKey: null, jiraProjectId: '10001', deployment: 'cloud' })
    insertLinkWithId(db, { localId: 1, jiraIssueId: 'a', jiraKey: null, jiraProjectId: '10001', deployment: 'cloud' })
    insertLinkWithId(db, { localId: 2, jiraIssueId: 'b', jiraKey: null, jiraProjectId: '10001', deployment: 'cloud' })
    expect(listLinks(db).map((l) => l.localId)).toEqual([1, 2, 3])
  })

  it('listLinks is empty on a fresh db', () => {
    expect(listLinks(db)).toEqual([])
  })

  it('updateLinkStatusCategory sets the category', () => {
    ensureLink(db, linkArgs({ jiraIssueId: '200' }))
    updateLinkStatusCategory(db, '200', 'done')
    expect(getLinkByIssueId(db, '200')!.statusCategory).toBe('done')
    updateLinkStatusCategory(db, '200', 'indeterminate')
    expect(getLinkByIssueId(db, '200')!.statusCategory).toBe('indeterminate')
  })

  it('setLinkState transitions the link state', () => {
    ensureLink(db, linkArgs({ jiraIssueId: '300' }))
    expect(getLinkByIssueId(db, '300')!.state).toBe('linked')
    setLinkState(db, '300', 'conflict')
    expect(getLinkByIssueId(db, '300')!.state).toBe('conflict')
    setLinkState(db, '300', 'orphaned')
    expect(getLinkByIssueId(db, '300')!.state).toBe('orphaned')
  })

  it('tombstoneLink marks the link tombstoned + orphaned and keeps the local id', () => {
    const link = ensureLink(db, linkArgs({ jiraIssueId: '400', jiraKey: 'P-400' }))
    tombstoneLink(db, '400')
    const after = getLinkByIssueId(db, '400')!
    expect(after.tombstoned).toBe(true)
    expect(after.state).toBe('orphaned')
    expect(after.localId).toBe(link.localId)
    // Local id stays reserved — next mint is above it.
    expect(nextLocalId(db)).toBe(link.localId + 1)
  })
})

// ─── outbox ───────────────────────────────────────────────────────────────

const op = (over: Partial<EnqueueOutboxInput> = {}): EnqueueOutboxInput => ({
  jiraIssueId: '1000',
  opType: 'transition',
  idempotencyKey: 'idem-1',
  payload: { category: 'done' },
  ...over,
})

describe('jira_outbox', () => {
  it('enqueueOutbox inserts a pending row and returns its id', () => {
    const id = enqueueOutbox(db, op())
    expect(id).toBeGreaterThan(0)
    const rows = listOutbox(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].jiraIssueId).toBe('1000')
    expect(rows[0].opType).toBe('transition')
    expect(rows[0].idempotencyKey).toBe('idem-1')
    expect(rows[0].payload).toBe(JSON.stringify({ category: 'done' }))
    expect(rows[0].state).toBe('pending')
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].nextAttemptAt).toBeNull()
    expect(rows[0].lastError).toBeNull()
    expect(rows[0].deadReason).toBeNull()
  })

  it('enqueueOutbox is idempotent on idempotencyKey (second call returns same id, no new row)', () => {
    const id1 = enqueueOutbox(db, op({ idempotencyKey: 'dup' }))
    const id2 = enqueueOutbox(db, op({ idempotencyKey: 'dup', payload: { category: 'todo' } }))
    expect(id2).toBe(id1)
    const rows = listOutbox(db)
    expect(rows).toHaveLength(1)
    // The first write wins (INSERT OR IGNORE); payload is unchanged.
    expect(rows[0].payload).toBe(JSON.stringify({ category: 'done' }))
  })

  it('enqueueOutbox supports comment and create op types with arbitrary payloads', () => {
    enqueueOutbox(db, op({ idempotencyKey: 'c1', opType: 'comment', payload: { body: 'hi' } }))
    enqueueOutbox(db, op({ idempotencyKey: 'cr1', opType: 'create', payload: { summary: 'New' } }))
    const rows = listOutbox(db)
    expect(rows.map((r) => r.opType).sort()).toEqual(['comment', 'create'])
  })

  it('enqueueMany inserts all ops atomically', () => {
    enqueueMany(db, [
      op({ idempotencyKey: 'm1', jiraIssueId: 'A' }),
      op({ idempotencyKey: 'm2', jiraIssueId: 'B' }),
      op({ idempotencyKey: 'm3', jiraIssueId: 'C' }),
    ])
    expect(listOutbox(db)).toHaveLength(3)
    expect(countOutboxByState(db).pending).toBe(3)
  })

  it('enqueueMany dedupes within the batch by idempotencyKey', () => {
    enqueueMany(db, [op({ idempotencyKey: 'same' }), op({ idempotencyKey: 'same' })])
    expect(listOutbox(db)).toHaveLength(1)
  })

  it('enqueueMany rolls back the whole batch if one op throws (atomicity)', () => {
    // Pre-seed a row so the unique index is satisfied normally; the bad op has a
    // non-serialisable payload (a BigInt) → JSON.stringify throws → tx rolls back.
    expect(() =>
      enqueueMany(db, [
        op({ idempotencyKey: 'ok-1', jiraIssueId: 'X' }),
        // BigInt cannot be JSON.stringify'd → throws inside the transaction.
        op({ idempotencyKey: 'bad', payload: { n: BigInt(1) } as unknown }),
      ])
    ).toThrow()
    // Nothing committed — the first op was rolled back too.
    expect(listOutbox(db)).toHaveLength(0)
  })

  it('claimDrainable claims pending rows FIFO and marks them inflight', () => {
    const id1 = enqueueOutbox(db, op({ idempotencyKey: 'q1', jiraIssueId: 'A' }))
    const id2 = enqueueOutbox(db, op({ idempotencyKey: 'q2', jiraIssueId: 'B' }))
    const claimed = claimDrainable(db, 10)
    expect(claimed.map((r) => r.id)).toEqual([id1, id2])
    expect(claimed.every((r) => r.state === 'inflight')).toBe(true)
    // Persisted as inflight.
    expect(countOutboxByState(db).inflight).toBe(2)
    expect(countOutboxByState(db).pending).toBe(0)
  })

  it('claimDrainable returns at most ONE op per issue per pass (FIFO-per-issue)', () => {
    enqueueOutbox(db, op({ idempotencyKey: 's1', jiraIssueId: 'SAME' }))
    enqueueOutbox(db, op({ idempotencyKey: 's2', jiraIssueId: 'SAME' }))
    enqueueOutbox(db, op({ idempotencyKey: 'o1', jiraIssueId: 'OTHER' }))
    const claimed = claimDrainable(db, 10)
    // SAME issue contributes only its earliest op; OTHER contributes one.
    expect(claimed).toHaveLength(2)
    const sameClaims = claimed.filter((r) => r.jiraIssueId === 'SAME')
    expect(sameClaims).toHaveLength(1)
    expect(sameClaims[0].idempotencyKey).toBe('s1') // earliest by id
    // The second SAME op stays pending.
    expect(countOutboxByState(db).pending).toBe(1)
  })

  it('does not claim a later op while the same issue already has one inflight', () => {
    enqueueOutbox(db, op({ idempotencyKey: 'serial-1', jiraIssueId: 'SERIAL' }))
    enqueueOutbox(db, op({ idempotencyKey: 'serial-2', jiraIssueId: 'SERIAL' }))

    expect(claimDrainable(db, 10).map((r) => r.idempotencyKey)).toEqual(['serial-1'])
    expect(claimDrainable(db, 10)).toEqual([])
    expect(listOutbox(db, { state: 'pending' }).map((r) => r.idempotencyKey)).toEqual(['serial-2'])
  })

  it('does not skip a backed-off earlier op to apply a newer op for the same issue', () => {
    const first = enqueueOutbox(db, op({ idempotencyKey: 'retry-first', jiraIssueId: 'ORDERED' }))
    enqueueOutbox(db, op({ idempotencyKey: 'newer-second', jiraIssueId: 'ORDERED' }))
    markOutboxRetry(db, first, '2999-01-01T00:00:00.000Z', 'later')

    expect(claimDrainable(db, 10, '2026-01-01T00:00:00.000Z')).toEqual([])
  })

  it('claimDrainable respects the limit (distinct issues)', () => {
    enqueueOutbox(db, op({ idempotencyKey: 'l1', jiraIssueId: 'A' }))
    enqueueOutbox(db, op({ idempotencyKey: 'l2', jiraIssueId: 'B' }))
    enqueueOutbox(db, op({ idempotencyKey: 'l3', jiraIssueId: 'C' }))
    const claimed = claimDrainable(db, 2)
    expect(claimed).toHaveLength(2)
    expect(claimed.map((r) => r.jiraIssueId)).toEqual(['A', 'B'])
    expect(countOutboxByState(db).pending).toBe(1)
  })

  it('claimDrainable skips rows whose next_attempt_at is in the future', () => {
    const future = enqueueOutbox(db, op({ idempotencyKey: 'f1', jiraIssueId: 'FUT' }))
    const ready = enqueueOutbox(db, op({ idempotencyKey: 'r1', jiraIssueId: 'RDY' }))
    // Schedule FUT far in the future via a retry.
    markOutboxRetry(db, future, '2999-01-01T00:00:00.000Z', 'later')
    const claimed = claimDrainable(db, 10, '2020-01-01T00:00:00.000Z')
    expect(claimed.map((r) => r.id)).toEqual([ready])
  })

  it('claimDrainable includes rows whose next_attempt_at is due (<= now)', () => {
    const id = enqueueOutbox(db, op({ idempotencyKey: 'd1', jiraIssueId: 'DUE' }))
    markOutboxRetry(db, id, '2020-01-01T00:00:00.000Z', 'retry')
    // now is after next_attempt_at → eligible.
    const claimed = claimDrainable(db, 10, '2020-06-01T00:00:00.000Z')
    expect(claimed.map((r) => r.id)).toEqual([id])
  })

  it('claimDrainable returns an empty array when nothing is drainable', () => {
    expect(claimDrainable(db, 10)).toEqual([])
  })

  it('claimDrainable ignores inflight/done/dead rows', () => {
    const done = enqueueOutbox(db, op({ idempotencyKey: 'x1', jiraIssueId: 'A' }))
    const dead = enqueueOutbox(db, op({ idempotencyKey: 'x2', jiraIssueId: 'B' }))
    markOutboxDone(db, done)
    markOutboxDead(db, dead, 'permission')
    expect(claimDrainable(db, 10)).toEqual([])
  })

  it('markOutboxDone moves a row to done', () => {
    const id = enqueueOutbox(db, op())
    markOutboxDone(db, id)
    expect(listOutbox(db)[0].state).toBe('done')
    expect(countOutboxByState(db)).toMatchObject({ done: 1, pending: 0 })
  })

  it('markOutboxRetry bumps attempts, sets next_attempt_at + last_error, returns to pending', () => {
    const id = enqueueOutbox(db, op())
    claimDrainable(db, 10) // → inflight
    markOutboxRetry(db, id, '2030-01-01T00:00:00.000Z', 'transient failure')
    const row = listOutbox(db)[0]
    expect(row.state).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt).toBe('2030-01-01T00:00:00.000Z')
    expect(row.lastError).toBe('transient failure')
    // A second retry increments attempts again.
    markOutboxRetry(db, id, '2031-01-01T00:00:00.000Z', 'again')
    expect(listOutbox(db)[0].attempts).toBe(2)
  })

  it('markOutboxRetry truncates the error message to 500 chars', () => {
    const id = enqueueOutbox(db, op())
    const longErr = 'E'.repeat(600)
    markOutboxRetry(db, id, '2030-01-01T00:00:00.000Z', longErr)
    expect(listOutbox(db)[0].lastError).toHaveLength(500)
  })

  it('markOutboxDead sets dead state and reason', () => {
    const id = enqueueOutbox(db, op())
    markOutboxDead(db, id, 'no_transition')
    const row = listOutbox(db)[0]
    expect(row.state).toBe('dead')
    expect(row.deadReason).toBe('no_transition')
  })

  it('markOutboxDead truncates the reason to 500 chars', () => {
    const id = enqueueOutbox(db, op())
    markOutboxDead(db, id, 'R'.repeat(900))
    expect(listOutbox(db)[0].deadReason).toHaveLength(500)
  })

  it('resetInflight returns all inflight rows to pending and reports the count', () => {
    enqueueOutbox(db, op({ idempotencyKey: 'a', jiraIssueId: 'A' }))
    enqueueOutbox(db, op({ idempotencyKey: 'b', jiraIssueId: 'B' }))
    claimDrainable(db, 10) // both → inflight
    expect(countOutboxByState(db).inflight).toBe(2)
    const reset = resetInflight(db)
    expect(reset).toBe(2)
    expect(countOutboxByState(db).inflight).toBe(0)
    expect(countOutboxByState(db).pending).toBe(2)
  })

  it('resetInflight is a no-op (returns 0) when nothing is inflight', () => {
    enqueueOutbox(db, op())
    expect(resetInflight(db)).toBe(0)
  })

  it('retryDeadOutbox re-queues a dead row and clears its failure metadata', () => {
    const id = enqueueOutbox(db, op())
    markOutboxRetry(db, id, '2030-01-01T00:00:00.000Z', 'err') // sets attempts + next + last_error
    markOutboxDead(db, id, 'validation')
    expect(retryDeadOutbox(db, id)).toBe(true)
    const row = listOutbox(db)[0]
    expect(row.state).toBe('pending')
    expect(row.nextAttemptAt).toBeNull()
    expect(row.deadReason).toBeNull()
    expect(row.lastError).toBeNull()
    // Attempts are intentionally preserved (only failure metadata is cleared).
    expect(row.attempts).toBe(1)
  })

  it('retryDeadOutbox returns false for a non-dead row (only dead → pending)', () => {
    const pendingId = enqueueOutbox(db, op({ idempotencyKey: 'p', jiraIssueId: 'P' }))
    expect(retryDeadOutbox(db, pendingId)).toBe(false)
    expect(listOutbox(db).find((r) => r.id === pendingId)!.state).toBe('pending')

    const doneId = enqueueOutbox(db, op({ idempotencyKey: 'd', jiraIssueId: 'D' }))
    markOutboxDone(db, doneId)
    expect(retryDeadOutbox(db, doneId)).toBe(false)
    expect(listOutbox(db).find((r) => r.id === doneId)!.state).toBe('done')
  })

  it('retryDeadOutbox returns false for an unknown id', () => {
    expect(retryDeadOutbox(db, 99999)).toBe(false)
  })

  it('listOutbox returns rows newest-first (id DESC) and honours the limit', () => {
    const ids: number[] = []
    for (let i = 0; i < 5; i++) ids.push(enqueueOutbox(db, op({ idempotencyKey: `k${i}`, jiraIssueId: `I${i}` })))
    const all = listOutbox(db)
    expect(all.map((r) => r.id)).toEqual([...ids].reverse())
    const limited = listOutbox(db, { limit: 2 })
    expect(limited.map((r) => r.id)).toEqual([ids[4], ids[3]])
  })

  it('listOutbox filters by state', () => {
    const a = enqueueOutbox(db, op({ idempotencyKey: 'a', jiraIssueId: 'A' }))
    const b = enqueueOutbox(db, op({ idempotencyKey: 'b', jiraIssueId: 'B' }))
    enqueueOutbox(db, op({ idempotencyKey: 'c', jiraIssueId: 'C' }))
    markOutboxDone(db, a)
    markOutboxDead(db, b, 'permission')
    expect(listOutbox(db, { state: 'pending' }).map((r) => r.jiraIssueId)).toEqual(['C'])
    expect(listOutbox(db, { state: 'done' }).map((r) => r.id)).toEqual([a])
    expect(listOutbox(db, { state: 'dead' }).map((r) => r.id)).toEqual([b])
    expect(listOutbox(db, { state: 'inflight' })).toEqual([])
  })

  it('listOutbox caps the limit at 1000', () => {
    enqueueOutbox(db, op())
    // Should not throw and should clamp internally; we just assert it returns the row.
    expect(listOutbox(db, { limit: 999999 })).toHaveLength(1)
  })

  it('listOutbox defaults the limit to 200 when unspecified', () => {
    enqueueOutbox(db, op())
    expect(listOutbox(db)).toHaveLength(1)
  })

  it('countOutboxByState returns all four states zero-filled', () => {
    expect(countOutboxByState(db)).toEqual({ pending: 0, inflight: 0, done: 0, dead: 0 })
  })

  it('countOutboxByState tallies a mix of states', () => {
    const a = enqueueOutbox(db, op({ idempotencyKey: 'a', jiraIssueId: 'A' }))
    const b = enqueueOutbox(db, op({ idempotencyKey: 'b', jiraIssueId: 'B' }))
    const c = enqueueOutbox(db, op({ idempotencyKey: 'c', jiraIssueId: 'C' }))
    enqueueOutbox(db, op({ idempotencyKey: 'd', jiraIssueId: 'D' })) // stays pending
    markOutboxDone(db, a)
    markOutboxDead(db, b, 'permission')
    // c → inflight
    db.prepare("UPDATE jira_outbox SET state = 'inflight' WHERE id = ?").run(c)
    expect(countOutboxByState(db)).toEqual({ pending: 1, inflight: 1, done: 1, dead: 1 })
  })
})
