import { getDesktopSetting } from '../../desktop-db'
import type { DbInstance } from '../../db'

/**
 * `mcp_v2`: serve the v2 catalog (15 tools, envelope v2, hidden v1 aliases).
 * OFF by default until the phase 4 cut-over. The environment variable
 * `SPECRAILS_MCP_V2=true|false` wins over the stored desktop setting; only the
 * literal 'true' turns it on. Read per MCP session, so a change applies to new
 * sessions without a restart.
 */
export const MCP_V2_KEY = 'mcp_v2'

export function isMcpV2Enabled(db: DbInstance | undefined, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const override = env.SPECRAILS_MCP_V2
  if (override === 'true') return true
  if (override === 'false') return false
  if (!db) return false
  try { return getDesktopSetting(db, MCP_V2_KEY) === 'true' } catch { return false }
}
