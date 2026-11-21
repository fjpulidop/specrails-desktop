import type { DbInstance } from '../../../db'
import type { LiveMissionFacts } from '../domain'
import type { MissionDirectory } from '../ports'

const CHUNK = 400
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',')

/**
 * Missions live in the app database (`agent_conversations`), above projects.
 * Two statements per refresh, whatever the number of lanes: the titles and
 * providers, and each mission's own turns today from its ledger
 * (`agent_invocations`, the source Analytics reads).
 */
export function createMissionDirectory(desktopDb: DbInstance): MissionDirectory {
  return {
    describe(conversationIds, day) {
      const out = new Map<string, LiveMissionFacts>()
      for (let i = 0; i < conversationIds.length; i += CHUNK) {
        const ids = conversationIds.slice(i, i + CHUNK)
        const rows = desktopDb.prepare(`SELECT id, title, provider FROM agent_conversations WHERE id IN (${marks(ids.length)}) AND deleted_at IS NULL`)
          .all(...ids) as Array<{ id: string; title: string | null; provider: string | null }>
        for (const row of rows) out.set(row.id, { title: row.title?.trim() || null, provider: row.provider, todayCostUsd: null })
        const spend = desktopDb.prepare(`
          SELECT conversation_id AS id, SUM(total_cost_usd) AS cost
          FROM agent_invocations
          WHERE conversation_id IN (${marks(ids.length)}) AND started_at >= ? AND started_at < ? AND total_cost_usd IS NOT NULL
          GROUP BY conversation_id
        `).all(...ids, day.from, day.to) as Array<{ id: string; cost: number | null }>
        for (const row of spend) {
          const mission = out.get(row.id)
          if (mission && typeof row.cost === 'number') mission.todayCostUsd = row.cost
        }
      }
      return out
    },
  }
}
