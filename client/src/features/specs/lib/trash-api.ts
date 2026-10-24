import { API_ORIGIN } from '../../../lib/origin'
import type { LocalTicket } from '../../../types'

/**
 * "Recently deleted" specs (soft delete, restorable for 30 days). Every call
 * names its project explicitly so a project switch can never redirect it.
 */

export interface DeletedSpec {
  ticket: LocalTicket
  deletedAt: string
  purgeAt: string
}

function base(projectId: string): string {
  return `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/tickets`
}

export async function listDeletedSpecs(projectId: string, signal?: AbortSignal): Promise<{ items: DeletedSpec[]; retentionDays: number }> {
  const res = await fetch(`${base(projectId)}/trash`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function restoreSpec(projectId: string, ticketId: number): Promise<void> {
  const res = await fetch(`${base(projectId)}/${ticketId}/restore`, { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** "Delete permanently": removes the spec and its attachments for good. */
export async function purgeSpec(projectId: string, ticketId: number): Promise<void> {
  const res = await fetch(`${base(projectId)}/trash/${ticketId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
