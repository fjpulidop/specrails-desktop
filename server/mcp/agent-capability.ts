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
const revocationListeners = new Map<string, Set<() => void>>()

function removeCapability(hash: string): void {
  capabilities.delete(hash)
  const listeners = revocationListeners.get(hash)
  revocationListeners.delete(hash)
  for (const listener of listeners ?? []) {
    try { listener() } catch { /* one session must not prevent revoking others */ }
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function pruneExpired(now = Date.now()): void {
  for (const [hash, capability] of capabilities) {
    if (capability.expiresAt <= now) removeCapability(hash)
  }
}

function headerToken(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? undefined : value
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
  if (!Number.isInteger(input.tierLevel) || input.tierLevel < 0 || input.tierLevel > 3) {
    throw new Error('Invalid agent permission level')
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
  removeCapability(tokenHash(token.trim()))
}

/** Close transports immediately when their owning turn settles. */
export function onAgentCapabilityRevoked(token: string, listener: () => void): () => void {
  const hash = tokenHash(token.trim())
  if (!verifyAgentCapability(token)) { listener(); return () => {} }
  const listeners = revocationListeners.get(hash) ?? new Set<() => void>()
  listeners.add(listener)
  revocationListeners.set(hash, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) revocationListeners.delete(hash)
  }
}

/** Test seam: capabilities are process-local and must never bleed between cases. */
export function _resetAgentCapabilitiesForTest(): void {
  for (const hash of capabilities.keys()) removeCapability(hash)
}
