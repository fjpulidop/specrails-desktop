import { getDesktopSetting } from '../../desktop-db'
import type { DbInstance } from '../../db'

/**
 * `mcp_v2`: serve the v2 catalog (15 tools, envelope v2, hidden v1 aliases) to
 * external clients. ON by default since the phase 4 cut-over; the stored
 * desktop setting `'false'` (Settings ▸ MCP) or `SPECRAILS_MCP_V2=false` is the
 * escape hatch back to the v1 catalog. The environment variable wins over the
 * setting. Read per MCP session, so a change applies to new sessions without a
 * restart.
 */
export const MCP_V2_KEY = 'mcp_v2'

export function isMcpV2Enabled(db: DbInstance | undefined, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const override = env.SPECRAILS_MCP_V2
  if (override === 'true') return true
  if (override === 'false') return false
  if (!db) return true
  try { return getDesktopSetting(db, MCP_V2_KEY) !== 'false' } catch { return true }
}
