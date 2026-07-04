import type { McpTier } from './mcp/mcp-tiers'

// ─── In-app agent cumulative tier ladder (design D4) ──────────────────────────
//
// The embedded MCP server (server/mcp/mcp-tiers.ts) governs EXTERNAL clients with
// four INDEPENDENT opt-in checkboxes (write / ai-spawn / destructive). The in-app
// agent chat instead exposes a CUMULATIVE ladder the user steers live with
// Shift+Tab — each level includes every capability of the levels below it:
//
//   0  observe     → read
//   1  edit        → read + write
//   2  operate     → read + write + ai-spawn        (costs money)
//   3  autonomous  → read + write + ai-spawn + destructive   (irreversible)
//
// The ladder is enforced PER REQUEST and INDEPENDENTLY of the external Settings
// checkboxes: the agent's MCP bridge connection forwards the current level as a
// loopback-only header (AGENT_TIER_HEADER); the central tool guard
// (registerTieredTool) honours it in place of the desktop_settings flags when
// present, leaving external clients untouched.

export type AgentTierLevel = 0 | 1 | 2 | 3

export type AgentTierName = 'observe' | 'edit' | 'operate' | 'autonomous'

export const AGENT_TIER_NAMES: readonly AgentTierName[] = [
  'observe',
  'edit',
  'operate',
  'autonomous',
] as const

/** The HTTP header the agent's MCP bridge sets so the tool guard can read the level. */
export const AGENT_TIER_HEADER = 'x-specrails-agent-tier'

/** Env var the AgentChatManager sets on the bridge spawn; the bridge forwards it as the header. */
export const AGENT_TIER_ENV = 'SPECRAILS_AGENT_TIER'

/** Header carrying the pinned project id so tools resolve it per-request. */
export const AGENT_PROJECT_HEADER = 'x-specrails-active-project'

/** Env var the manager sets on the bridge spawn; the bridge forwards it as the project header. */
export const AGENT_PROJECT_ENV = 'SPECRAILS_ACTIVE_PROJECT'

/** Header carrying the launching agent-chat conversation id (safe-pr-review-flow
 *  origin link) so an MCP-launched rail can be tagged with its origin. */
export const AGENT_CONVERSATION_HEADER = 'x-specrails-agent-conversation'

/** Env var set on the bridge spawn; the bridge forwards it as the conversation header. */
export const AGENT_CONVERSATION_ENV = 'SPECRAILS_AGENT_CONVERSATION'

/** Which MCP tiers a given ladder level unlocks (cumulative). */
const TIERS_BY_LEVEL: Record<AgentTierLevel, ReadonlySet<McpTier>> = {
  0: new Set<McpTier>(['read']),
  1: new Set<McpTier>(['read', 'write']),
  2: new Set<McpTier>(['read', 'write', 'ai-spawn']),
  3: new Set<McpTier>(['read', 'write', 'ai-spawn', 'destructive']),
}

export function tierNameForLevel(level: AgentTierLevel): AgentTierName {
  return AGENT_TIER_NAMES[level]
}

export function levelForTierName(name: string): AgentTierLevel | null {
  const idx = AGENT_TIER_NAMES.indexOf(name as AgentTierName)
  return idx === -1 ? null : (idx as AgentTierLevel)
}

/** Clamp an arbitrary number/string to a valid ladder level (default observe). */
export function normalizeLevel(value: unknown): AgentTierLevel {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 3) {
    return n as AgentTierLevel
  }
  // Allow the name form too.
  if (typeof value === 'string') {
    const byName = levelForTierName(value)
    if (byName !== null) return byName
  }
  return 0
}

/** Cycle Shift+Tab: 0→1→2→3→0. */
export function nextLevel(level: AgentTierLevel): AgentTierLevel {
  return ((level + 1) % 4) as AgentTierLevel
}

/** True when the given MCP tier is permitted at the given ladder level. */
export function levelAllowsTier(level: AgentTierLevel, tier: McpTier): boolean {
  return TIERS_BY_LEVEL[level].has(tier)
}

/**
 * Parse the agent-tier header value into a level, or null when absent/invalid.
 * The header carries the tier NAME (observe/edit/operate/autonomous) or the
 * numeric level; anything else yields null (→ fall back to Settings tiers).
 */
export function levelFromHeader(headerValue: string | string[] | undefined): AgentTierLevel | null {
  if (headerValue == null) return null
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const byName = levelForTierName(raw.trim())
  if (byName !== null) return byName
  const n = Number(raw.trim())
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n as AgentTierLevel
  return null
}

/**
 * Whether a cost/destructive action needs an explicit inline approval (Option C):
 * reversible writes (read/write) run silently; ai-spawn and destructive prompt.
 */
export function tierNeedsApproval(tier: McpTier): boolean {
  return tier === 'ai-spawn' || tier === 'destructive'
}
