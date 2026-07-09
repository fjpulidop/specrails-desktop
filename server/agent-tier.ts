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
// checkboxes. The server mints an ephemeral capability for each in-app turn,
// binding the level + conversation + pinned project. The bridge presents only
// that unguessable capability; registerTieredTool derives all authority from the
// server-side binding. The legacy context headers below remain exported only so
// regression tests can prove that spoofing them grants no authority.

export type AgentTierLevel = 0 | 1 | 2 | 3

export type AgentTierName = 'observe' | 'edit' | 'operate' | 'autonomous'

export const AGENT_TIER_NAMES: readonly AgentTierName[] = [
  'observe',
  'edit',
  'operate',
  'autonomous',
] as const

/** @deprecated Untrusted legacy header retained for compatibility/negative tests. */
export const AGENT_TIER_HEADER = 'x-specrails-agent-tier'

/** @deprecated Untrusted legacy env var; the bridge deliberately ignores it. */
export const AGENT_TIER_ENV = 'SPECRAILS_AGENT_TIER'

/** @deprecated Untrusted legacy header retained for compatibility/negative tests. */
export const AGENT_PROJECT_HEADER = 'x-specrails-active-project'

/** @deprecated Untrusted legacy env var; the bridge deliberately ignores it. */
export const AGENT_PROJECT_ENV = 'SPECRAILS_ACTIVE_PROJECT'

/** @deprecated Untrusted legacy header retained for compatibility/negative tests. */
export const AGENT_CONVERSATION_HEADER = 'x-specrails-agent-conversation'

/** @deprecated Untrusted legacy env var; the bridge deliberately ignores it. */
export const AGENT_CONVERSATION_ENV = 'SPECRAILS_AGENT_CONVERSATION'

/** Bearer-like proof that an MCP request belongs to a live in-app agent turn. */
export const AGENT_CAPABILITY_HEADER = 'x-specrails-agent-capability'

/** 0600 file path read by the bridge; the secret itself never appears in argv. */
export const AGENT_CAPABILITY_FILE_ENV = 'SPECRAILS_AGENT_CAPABILITY_FILE'

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
 * Parse a legacy tier value. Retained for UI/storage compatibility only: MCP
 * request authorization MUST use a verified server-minted capability instead.
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
