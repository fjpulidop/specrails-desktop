import { createHash, randomBytes } from 'crypto'
import type { AgentTierLevel } from '../agent-tier'

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TTL_MS = DEFAULT_TTL_MS
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface AgentCapabilityContext {
  conversationId: string
  projectId: string | null
  tierLevel: AgentTierLevel
  expiresAt: number
}

type StoredCapability = AgentCapabilityContext

const capabilities = new Map<string, StoredCapability>()

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function pruneExpired(now = Date.now()): void {
  for (const [hash, capability] of capabilities) {
    if (capability.expiresAt <= now) capabilities.delete(hash)
  }
}

function headerToken(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  return token.length >= 32 && token.length <= 256 ? token : null
}

/**
 * Mint an in-memory, per-turn capability. Only the hash is retained server-side;
 * callers must revoke the returned secret when the owning AI process settles.
 */
export function mintAgentCapability(input: {
  conversationId: string
  projectId?: string | null
  tierLevel: AgentTierLevel
  ttlMs?: number
}): string {
  if (!CONVERSATION_ID_RE.test(input.conversationId)) {
    throw new Error(`unsafe agent conversation id: ${input.conversationId}`)
  }
  const ttl = Number.isFinite(input.ttlMs) && (input.ttlMs as number) > 0
    ? Math.min(Math.trunc(input.ttlMs as number), MAX_TTL_MS)
    : DEFAULT_TTL_MS
  const now = Date.now()
  pruneExpired(now)
  const token = randomBytes(32).toString('base64url')
  capabilities.set(tokenHash(token), {
    conversationId: input.conversationId,
    projectId: input.projectId?.trim() || null,
    tierLevel: input.tierLevel,
    expiresAt: now + ttl,
  })
  return token
}

/** Resolve only capabilities minted by this process and still inside their TTL. */
export function verifyAgentCapability(
  value: string | string[] | undefined,
): AgentCapabilityContext | null {
  const token = headerToken(value)
  if (!token) return null
  const now = Date.now()
  pruneExpired(now)
  const found = capabilities.get(tokenHash(token))
  if (!found || found.expiresAt <= now) return null
  return { ...found }
}

/** Revoke a turn capability immediately; safe to call more than once. */
export function revokeAgentCapability(token: string | null | undefined): void {
  if (!token) return
  capabilities.delete(tokenHash(token))
}

/** Test seam: capabilities are process-local and must never bleed between cases. */
export function _resetAgentCapabilitiesForTest(): void {
  capabilities.clear()
}
