import type { DbInstance } from '../../../db'
import { deleteConversation, getConversation } from '../../../db'
import { readStore } from './ticket-store'
import {
  purgeExpiredTickets,
  type TrashedTicket,
  TRASH_RETENTION_MS,
} from './ticket-trash'

/** Effects a permanent removal still owes: the pieces soft-delete deliberately kept. */
export interface TrashFinalizeDeps {
  ticketStorePath: () => string
  db: DbInstance
  /** Delete every attachment stored for a ticket id. */
  deleteAttachments: (ticketKey: string) => Promise<unknown>
  /** Forget in-memory state of an Explore conversation the spec was a draft of. */
  forgetExploreConversation?: (conversationId: string) => void
}

/**
 * Run the cascade a hard delete used to run inline: attachments, and the Explore
 * conversation of a draft nothing else references. Skips a spec that is live
 * again (a crash leftover) so purge never strips a restored spec of its files.
 */
export async function finalizeTrashedTicket(deps: TrashFinalizeDeps, entry: TrashedTicket): Promise<void> {
  const ticket = entry.ticket
  const store = readStore(deps.ticketStorePath())
  if (store.tickets[String(ticket.id)]) return
  await deps.deleteAttachments(String(ticket.id)).catch((e) => {
    console.error('[ticket-trash] attachment cascade delete failed:', e)
  })
  const conversationId = ticket.status === 'draft' ? ticket.origin_conversation_id : null
  if (!conversationId) return
  const stillReferenced = Object.values(store.tickets).some((other) => other.origin_conversation_id === conversationId)
  if (stillReferenced) return
  try {
    const conv = getConversation(deps.db, conversationId)
    if (conv && (conv as { kind?: string }).kind === 'explore') {
      deleteConversation(deps.db, conversationId)
      deps.forgetExploreConversation?.(conversationId)
    }
  } catch (err) {
    console.error('[ticket-trash] orphan conversation cleanup failed:', err)
  }
}

/** Purge every expired spec of one project and run their cascades. Idempotent. */
export async function purgeProjectTrash(deps: TrashFinalizeDeps, now: Date = new Date(), retentionMs: number = TRASH_RETENTION_MS): Promise<number> {
  let expired: TrashedTicket[]
  try {
    expired = purgeExpiredTickets(deps.ticketStorePath(), now, retentionMs)
  } catch (err) {
    console.error('[ticket-trash] purge failed:', err)
    return 0
  }
  for (const entry of expired) await finalizeTrashedTicket(deps, entry)
  return expired.length
}

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Purge now (startup) and every few hours while the project is loaded. */
export function startProjectTrashPurge(deps: TrashFinalizeDeps): { stop(): void } {
  const run = (): void => { void purgeProjectTrash(deps) }
  const first = setTimeout(run, 5_000)
  const timer = setInterval(run, PURGE_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return { stop: () => { clearTimeout(first); clearInterval(timer) } }
}
