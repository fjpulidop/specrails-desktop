import { getDesktopSetting } from '../desktop-db'
import type { DbInstance } from '../db'

// ─── Four-tier permission model (design D7) — default ON, opt-out ────────────
//
// Every MCP tool declares one tier. The server refuses any tool whose tier is
// not enabled, returning a machine-readable error naming the tier to turn on.
//
//   read        — always available when MCP is enabled (queries + resources)
//   write       — mutating, non-destructive, non-spawn (create/edit specs, settings, rail config)
//   ai-spawn    — spawns an AI CLI; costs money (launch rail, generate spec, send chat)
//   destructive — deletes data or kills processes / external-system mutation
//
// Tier state is persisted in `desktop_settings` as 'true'/'false' strings,
// mirroring the mobile-gateway enable flag. The read tier has no stored key
// (it is implied by MCP being enabled at all).
//
// DEFAULTS: MCP itself AND every tier are ON on a fresh install — the app is
// meant to be reachable from the user's AI tools out of the box, with no trip
// through Settings ▸ MCP first. Only the literal stored string 'false' disables
// (unset ⇒ enabled), the same convention as the app's feature flags, so a user
// who explicitly switched something off keeps that choice across upgrades. The
// server still stays loopback-only + scoped-token authenticated regardless.

export type McpTier = 'read' | 'write' | 'ai-spawn' | 'destructive'

export const MCP_TIERS: readonly McpTier[] = ['read', 'write', 'ai-spawn', 'destructive'] as const

/** desktop_settings keys for the opt-out tiers (all on by default; read is implicit). */
export const TIER_SETTING_KEY: Record<Exclude<McpTier, 'read'>, string> = {
  write: 'mcp_tier_write',
  'ai-spawn': 'mcp_tier_ai_spawn',
  destructive: 'mcp_tier_destructive',
}

export const MCP_ENABLED_KEY = 'mcp_enabled'

/** True when MCP itself is enabled (default TRUE — only an explicit 'false' disables). */
export function isMcpEnabled(db: DbInstance): boolean {
  return getDesktopSetting(db, MCP_ENABLED_KEY) !== 'false'
}

/**
 * True when a tool of the given tier may run right now. Read is always allowed
 * (its availability is governed by MCP being enabled, checked at the transport
 * gate). The other tiers default ON and are disabled only when the user has
 * explicitly stored 'false' for them (opt-out).
 */
export function isTierEnabled(db: DbInstance, tier: McpTier): boolean {
  if (tier === 'read') return true
  return getDesktopSetting(db, TIER_SETTING_KEY[tier]) !== 'false'
}

/** Human-readable label for a tier, used in refusal messages. */
export function tierLabel(tier: McpTier): string {
  switch (tier) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'ai-spawn':
      return 'AI-spawn (cost-incurring)'
    case 'destructive':
      return 'Destructive'
  }
}

/** The message returned when a tool is refused because its tier is disabled. */
export function tierRefusalMessage(tier: McpTier): string {
  return (
    `This action requires the "${tierLabel(tier)}" permission tier, which is currently disabled. ` +
    `Enable it in the Specrails app under Settings ▸ MCP, then retry.`
  )
}
