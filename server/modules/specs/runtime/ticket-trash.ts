import fs from 'fs'
import path from 'path'
import {
  acquireFileLock,
  releaseFileLock,
  mutateStore,
  readStore,
  type Ticket,
  type TicketStore,
} from './ticket-store'

/**
 * Soft-delete ("Recently deleted") for specs.
 *
 * The ticket store is a JSON file shared with specrails-core, so a `deleted_at`
 * flag inside it would leave deleted specs visible to Core and to every direct
 * reader. Instead a deleted spec MOVES to a sibling `<store>.trash.json`: every
 * list/search/API/Core read sees it gone, restore moves it back under the same
 * id (ids are never reused: `next_id` is monotonic), and a purge drops entries
 * older than the retention window.
 *
 * Crash safety: delete writes the trash entry BEFORE removing the live ticket
 * and restore removes the trash entry AFTER re-inserting, so a crash can only
 * leave the spec in both places — never in neither. Every operation is
 * idempotent; a spec found live is never overwritten by its trash copy.
 */

export const TRASH_RETENTION_DAYS = 30
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

export interface TrashedTicket {
  ticket: Ticket
  deleted_at: string
  /** Children of a deleted epic that were detached; re-adopted on restore if still parentless. */
  orphaned_child_ids: number[]
}

interface TrashFile {
  version: 1
  items: Record<string, TrashedTicket>
}

export function trashPathFor(storePath: string): string {
  const dir = path.dirname(storePath)
  const base = path.basename(storePath).replace(/\.json$/i, '')
  return path.join(dir, `${base}.trash.json`)
}

function readTrash(trashPath: string): TrashFile {
  let raw: string
  try {
    raw = fs.readFileSync(trashPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: {} }
    throw err
  }
  // A present-but-corrupt trash must never be blanked by the next write.
  const data = JSON.parse(raw) as TrashFile
  if (!data || typeof data !== 'object' || !data.items || typeof data.items !== 'object') {
    throw new Error(`ticket trash at ${trashPath} has an unexpected shape`)
  }
  return data
}

function writeTrash(trashPath: string, data: TrashFile): void {
  if (Object.keys(data.items).length === 0) {
    try { fs.unlinkSync(trashPath) } catch { /* already gone */ }
    return
  }
  fs.mkdirSync(path.dirname(trashPath), { recursive: true })
  const tmp = trashPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, trashPath)
}

function withTrash<T>(storePath: string, fn: (trash: TrashFile) => T): T {
  const trashPath = trashPathFor(storePath)
  acquireFileLock(trashPath)
  try {
    const trash = readTrash(trashPath)
    const result = fn(trash)
    writeTrash(trashPath, trash)
    return result
  } finally {
    releaseFileLock(trashPath)
  }
}

export interface SoftDeleteResult {
  ticket: Ticket
  orphanedChildren: Ticket[]
  revision: number
  /** True when the spec was already in the trash (idempotent repeat). */
  alreadyTrashed: boolean
}

/** Move a spec to the trash. Returns null when the spec is neither live nor trashed. */
export function softDeleteTicket(storePath: string, ticketId: number, now: Date = new Date()): SoftDeleteResult | null {
  const key = String(ticketId)
  const live = readStore(storePath).tickets[key]
  if (!live) {
    const trashed = withTrash(storePath, (t) => t.items[key])
    if (!trashed) return null
    return { ticket: trashed.ticket, orphanedChildren: [], revision: readStore(storePath).revision, alreadyTrashed: true }
  }
  const orphanedChildIds = Object.values(readStore(storePath).tickets)
    .filter((c) => live.is_epic && c.parent_epic_id === ticketId)
    .map((c) => c.id)
  withTrash(storePath, (t) => {
    t.items[key] = { ticket: live, deleted_at: now.toISOString(), orphaned_child_ids: orphanedChildIds }
  })
  const orphanedChildren: Ticket[] = []
  const store = mutateStore(storePath, (s) => {
    if (!s.tickets[key]) return
    // SMASH: deleting an epic orphans its children rather than cascading.
    if (s.tickets[key].is_epic) {
      const stamp = now.toISOString()
      for (const childId of Object.keys(s.tickets)) {
        const child = s.tickets[childId]
        if (child.parent_epic_id === ticketId) {
          child.parent_epic_id = null
          child.execution_order = null
          child.updated_at = stamp
          orphanedChildren.push(child)
        }
      }
    }
    delete s.tickets[key]
  })
  return { ticket: live, orphanedChildren, revision: store.revision, alreadyTrashed: false }
}

export interface RestoreResult {
  ticket: Ticket
  readoptedChildren: Ticket[]
  revision: number
  /** The spec was already live (repeat restore, or restored elsewhere). */
  alreadyLive: boolean
}

/** Move a spec back from the trash. Returns null when it is in neither place. */
export function restoreTicket(storePath: string, ticketId: number, now: Date = new Date()): RestoreResult | null {
  const key = String(ticketId)
  const entry = withTrash(storePath, (t) => t.items[key])
  const current = readStore(storePath)
  if (!entry) {
    const live = current.tickets[key]
    return live ? { ticket: live, readoptedChildren: [], revision: current.revision, alreadyLive: true } : null
  }
  const readoptedChildren: Ticket[] = []
  let alreadyLive = false
  let restored: Ticket = entry.ticket
  const store = mutateStore(storePath, (s) => {
    if (s.tickets[key]) { alreadyLive = true; restored = s.tickets[key]; return }
    restored = { ...entry.ticket, updated_at: now.toISOString() }
    s.tickets[key] = restored
    if (ticketId >= s.next_id) s.next_id = ticketId + 1
    if (restored.is_epic) {
      for (const childId of entry.orphaned_child_ids) {
        const child = s.tickets[String(childId)]
        if (child && child.parent_epic_id === null) {
          child.parent_epic_id = ticketId
          child.updated_at = now.toISOString()
          readoptedChildren.push(child)
        }
      }
    }
    // A parent epic that is no longer there cannot be re-adopted: stand alone.
    if (restored.parent_epic_id !== null && !s.tickets[String(restored.parent_epic_id)]?.is_epic) {
      restored.parent_epic_id = null
      restored.execution_order = null
    }
  })
  withTrash(storePath, (t) => { delete t.items[key] })
  return { ticket: restored, readoptedChildren, revision: store.revision, alreadyLive }
}

/** The trash, newest deletion first. Entries whose id is live again are crash leftovers and hidden. */
export function listTrashedTickets(storePath: string): TrashedTicket[] {
  const live: TicketStore['tickets'] = readStore(storePath).tickets
  const trash = withTrash(storePath, (t) => Object.values(t.items))
  return trash
    .filter((e) => !live[String(e.ticket.id)])
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
}

/** Remove one entry for good. Returns the removed spec so the caller can run its cascade. */
export function purgeTrashedTicket(storePath: string, ticketId: number): TrashedTicket | null {
  return withTrash(storePath, (t) => {
    const entry = t.items[String(ticketId)]
    if (!entry) return null
    delete t.items[String(ticketId)]
    return entry
  })
}

/** Remove every entry older than the retention window. Idempotent. */
export function purgeExpiredTickets(storePath: string, now: Date = new Date(), retentionMs: number = TRASH_RETENTION_MS): TrashedTicket[] {
  const cutoff = now.getTime() - retentionMs
  if (!fs.existsSync(trashPathFor(storePath))) return []
  return withTrash(storePath, (t) => {
    const expired: TrashedTicket[] = []
    for (const [key, entry] of Object.entries(t.items)) {
      const at = Date.parse(entry.deleted_at)
      if (Number.isNaN(at) || at <= cutoff) {
        expired.push(entry)
        delete t.items[key]
      }
    }
    return expired
  })
}
