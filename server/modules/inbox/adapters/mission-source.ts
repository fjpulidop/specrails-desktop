import type { DbInstance } from '../../../db'
import { inboxItemId, oneLine, toIso, type InboxItem, type InboxMissionCard } from '../domain'

/**
 * Mission cards that wait for the person, read from the app database (missions
 * live above projects) for ONE project:
 *
 * - a ```rail-launch proposal or a ```flow-offer (Intent or implement) in an
 *   agent message of a mission pinned to the project, with no decision stored
 *   on the message (`agent_messages.intent`) and no message from the person
 *   after it (once they wrote again, they moved on: the card stays in the
 *   mission, not in the inbox);
 * - a `pr-ci-offer` system card about one of the project's deliveries that is
 *   still `offered` (its own state machine settles it; the newest copy per
 *   delivery wins).
 *
 * A PR decision card is not listed: its delivery is already a review item.
 * Archived and deleted missions, and cards older than {@link MISSION_CARD_WINDOW_MS},
 * never count. Bounded reads only (two indexed queries, at most 100 rows each).
 */

export const MISSION_CARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface MissionCardHandle {
  project: { id: string; name: string }
  db: DbInstance
}

interface MessageRow {
  id: string
  conversation_id: string
  content: string
  intent: string | null
  created_at: string
  title: string | null
}

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

function fences(content: string, tag: string): unknown[] {
  if (!content.includes('```' + tag)) return []
  const re = new RegExp('```' + tag + '[^\\S\\n]*\\n([\\s\\S]*?)\\n[^\\S\\n]*```', 'g')
  const out: unknown[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    try { out.push(JSON.parse(match[1])) } catch { out.push(null) }
  }
  return out
}

function ticketIdsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim().replace(/^#/, '')) : NaN
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Decisions stored on the message: `<kind>:<proposalIndex>`. */
function decided(raw: string | null): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  try {
    const parsed = JSON.parse(raw) as unknown
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const row = record(entry)
      if (typeof row.kind === 'string' && typeof row.proposalIndex === 'number') out.add(`${row.kind}:${row.proposalIndex}`)
    }
  } catch { /* an unreadable decision column decides nothing */ }
  return out
}

const specsLabel = (ids: readonly number[]) => `${ids.slice(0, 3).map((id) => `#${id}`).join(', ')}${ids.length > 3 ? ` +${ids.length - 3}` : ''}`

function item(handle: MissionCardHandle, row: Pick<MessageRow, 'conversation_id' | 'title'>, card: InboxMissionCard, detail: string | null, at: string, version: string): InboxItem {
  return {
    id: inboxItemId(handle.project.id, 'mission', card.id),
    projectId: handle.project.id,
    projectName: handle.project.name,
    kind: 'mission',
    title: oneLine(row.title, 80) ?? 'Mission',
    detail,
    at,
    version,
    action: 'open-mission',
    subjectId: card.id,
    conversationId: row.conversation_id,
    diagnosis: null,
    card,
  }
}

export function missionCardItems(handle: MissionCardHandle, nowMs: number): InboxItem[] {
  const nowIso = new Date(nowMs).toISOString()
  const since = new Date(nowMs - MISSION_CARD_WINDOW_MS).toISOString()
  const out: InboxItem[] = []

  const proposals = handle.db.prepare(`
    SELECT m.id, m.conversation_id, m.content, m.intent, m.created_at, c.title
    FROM agent_conversations c
    JOIN agent_messages m ON m.conversation_id = c.id
    WHERE c.pinned_project_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND m.role = 'assistant'
      AND julianday(m.created_at) >= julianday(?)
      AND (instr(m.content, '\`\`\`rail-launch') > 0 OR instr(m.content, '\`\`\`flow-offer') > 0)
      AND NOT EXISTS (
        SELECT 1 FROM agent_messages u
        WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
          AND julianday(u.created_at) > julianday(m.created_at))
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all(handle.project.id, since) as MessageRow[]
  for (const row of proposals) {
    const done = decided(row.intent)
    const at = toIso(row.created_at, nowIso)
    fences(row.content, 'rail-launch').forEach((raw, index) => {
      if (done.has(`rail-launch:${index}`)) return
      const data = record(raw)
      const ticketIds = ticketIdsOf(data.ticketIds ?? data.specs ?? data.tickets)
      // An unreadable proposal is shown as unreadable in the mission and cannot be launched.
      if (!ticketIds.length) return
      out.push(item(handle, row, { id: `${row.id}:rail-launch:${index}`, kind: 'rail-launch', ticketIds }, specsLabel(ticketIds), at, 'rail-launch:pending'))
    })
    fences(row.content, 'flow-offer').forEach((raw, index) => {
      if (done.has(`flow-offer:${index}`)) return
      const idea = typeof record(raw).idea === 'string' ? oneLine(record(raw).idea as string) : null
      if (!idea) return
      out.push(item(handle, row, { id: `${row.id}:flow-offer:${index}`, kind: 'flow-offer' }, idea, at, 'flow-offer:pending'))
    })
  }

  const offers = handle.db.prepare(`
    SELECT m.id, m.conversation_id, m.content, NULL AS intent, m.created_at, c.title
    FROM agent_messages m
    JOIN agent_conversations c ON c.id = m.conversation_id
    WHERE m.role = 'system' AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND julianday(m.created_at) >= julianday(?)
      AND instr(m.content, '"pr-ci-offer"') > 0 AND instr(m.content, '"offered"') > 0
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all(since) as MessageRow[]
  const seen = new Set<string>()
  for (const row of offers) {
    let data: Row
    try { data = record(JSON.parse(row.content)) } catch { continue }
    if (data.kind !== 'pr-ci-offer' || data.state !== 'offered' || data.projectId !== handle.project.id) continue
    const delivery = typeof data.prDeliveryId === 'string' ? data.prDeliveryId : null
    const key = delivery ?? String(data.admissionId ?? row.id)
    if (seen.has(key)) continue
    seen.add(key)
    const prNumber = typeof data.prNumber === 'number' ? data.prNumber : undefined
    const card: InboxMissionCard = { id: `${row.id}:pr-ci-offer:0`, kind: 'pr-ci-offer', ...(prNumber ? { prNumber } : {}), ...(delivery ? { prDeliveryId: delivery } : {}) }
    const at = toIso(typeof data.at === 'string' ? data.at : row.created_at, nowIso)
    out.push(item(handle, row, card, prNumber ? `PR #${prNumber}` : null, at, `pr-ci-offer:offered:${at}`))
  }
  return out
}
