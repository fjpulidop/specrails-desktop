import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mutateStore, readStore, type Ticket } from './ticket-store'
import {
  softDeleteTicket,
  restoreTicket,
  listTrashedTickets,
  purgeTrashedTicket,
  purgeExpiredTickets,
  trashPathFor,
  TRASH_RETENTION_MS,
} from './ticket-trash'

function ticket(id: number, extra: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `T${id}`, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null,
    prerequisites: [], metadata: {}, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, short_summary: null, created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', created_by: 'test', source: 'manual', ...extra,
  }
}

describe('ticket trash (soft delete)', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-'))
    file = path.join(dir, 'local-tickets.json')
    mutateStore(file, (s) => {
      s.tickets['1'] = ticket(1)
      s.tickets['2'] = ticket(2, { is_epic: true })
      s.tickets['3'] = ticket(3, { parent_epic_id: 2, execution_order: 1 })
      s.next_id = 4
    })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('hides a deleted spec from the store and lists it in the trash', () => {
    const r = softDeleteTicket(file, 1, new Date('2026-02-01T00:00:00Z'))
    expect(r?.alreadyTrashed).toBe(false)
    expect(readStore(file).tickets['1']).toBeUndefined()
    const trash = listTrashedTickets(file)
    expect(trash.map((e) => e.ticket.id)).toEqual([1])
    expect(trash[0].deleted_at).toBe('2026-02-01T00:00:00.000Z')
    expect(fs.existsSync(trashPathFor(file))).toBe(true)
  })

  it('returns null for an unknown spec and is idempotent for a repeat delete', () => {
    expect(softDeleteTicket(file, 99)).toBeNull()
    softDeleteTicket(file, 1)
    const again = softDeleteTicket(file, 1)
    expect(again?.alreadyTrashed).toBe(true)
    expect(listTrashedTickets(file)).toHaveLength(1)
  })

  it('restores under the same id and clears the trash; restore is idempotent', () => {
    softDeleteTicket(file, 1)
    const r = restoreTicket(file, 1)
    expect(r?.alreadyLive).toBe(false)
    expect(readStore(file).tickets['1'].title).toBe('T1')
    expect(listTrashedTickets(file)).toEqual([])
    expect(fs.existsSync(trashPathFor(file))).toBe(false)
    expect(restoreTicket(file, 1)?.alreadyLive).toBe(true)
    expect(restoreTicket(file, 42)).toBeNull()
  })

  it('never reuses the id of a deleted spec', () => {
    softDeleteTicket(file, 3)
    expect(readStore(file).next_id).toBe(4)
  })

  it('orphans the children of a deleted epic and re-adopts them on restore', () => {
    const del = softDeleteTicket(file, 2)
    expect(del?.orphanedChildren.map((c) => c.id)).toEqual([3])
    expect(readStore(file).tickets['3'].parent_epic_id).toBeNull()
    const res = restoreTicket(file, 2)
    expect(res?.readoptedChildren.map((c) => c.id)).toEqual([3])
    expect(readStore(file).tickets['3'].parent_epic_id).toBe(2)
  })

  it('does not re-adopt a child that was reassigned meanwhile', () => {
    softDeleteTicket(file, 2)
    mutateStore(file, (s) => { s.tickets['1'].is_epic = true; s.tickets['3'].parent_epic_id = 1 })
    restoreTicket(file, 2)
    expect(readStore(file).tickets['3'].parent_epic_id).toBe(1)
  })

  it('never overwrites a live spec with its trash copy (crash leftover)', () => {
    softDeleteTicket(file, 1)
    mutateStore(file, (s) => { s.tickets['1'] = ticket(1, { title: 'live again' }) })
    expect(listTrashedTickets(file)).toEqual([])
    const r = restoreTicket(file, 1)
    expect(r?.alreadyLive).toBe(true)
    expect(readStore(file).tickets['1'].title).toBe('live again')
  })

  it('purges only entries older than 30 days, idempotently', () => {
    softDeleteTicket(file, 1, new Date('2026-01-01T00:00:00Z'))
    softDeleteTicket(file, 3, new Date('2026-01-25T00:00:00Z'))
    const now = new Date('2026-02-02T00:00:00Z') // 32 d after #1, 8 d after #3
    expect(TRASH_RETENTION_MS).toBe(30 * 24 * 3600 * 1000)
    expect(purgeExpiredTickets(file, now).map((e) => e.ticket.id)).toEqual([1])
    expect(purgeExpiredTickets(file, now)).toEqual([])
    expect(listTrashedTickets(file).map((e) => e.ticket.id)).toEqual([3])
    expect(restoreTicket(file, 1)).toBeNull()
  })

  it('keeps an entry exactly inside the window', () => {
    softDeleteTicket(file, 1, new Date('2026-01-01T00:00:00Z'))
    expect(purgeExpiredTickets(file, new Date('2026-01-30T23:59:59Z'))).toEqual([])
  })

  it('removes a single entry permanently', () => {
    softDeleteTicket(file, 1)
    expect(purgeTrashedTicket(file, 1)?.ticket.id).toBe(1)
    expect(purgeTrashedTicket(file, 1)).toBeNull()
    expect(listTrashedTickets(file)).toEqual([])
  })

  it('refuses to blank a corrupt trash file', () => {
    softDeleteTicket(file, 1)
    fs.writeFileSync(trashPathFor(file), '{not json')
    expect(() => softDeleteTicket(file, 3)).toThrow()
    expect(fs.readFileSync(trashPathFor(file), 'utf-8')).toBe('{not json')
  })
})
