import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { safeEqual } from '../auth'
import { readPrivateTextFile, writePrivateTextFile } from '../util/secure-token-file'

// ─── MCP-scoped token (design D3) ─────────────────────────────────────────────
//
// The MCP surface is authenticated by a token SEPARATE from the all-powerful
// master token (`~/.specrails/desktop.token`). The master token grants shell
// (terminals), arbitrary AI-CLI spawns and project admin; handing it to a
// third-party MCP client would be a security smell. Instead the MCP server
// mints its own scoped token at `~/.specrails/mcp.token` (0600). The stdio
// bridge reads it locally so it never appears in client config; the direct
// streamable-HTTP path requires it as `Authorization: Bearer <token>`.
//
// This module mirrors the shape of `server/auth.ts` (loadOrGenerateToken /
// safeEqual / requireAuth) for the scoped token. There is intentionally NO
// legacy-file migration — this is a greenfield credential.

// Honour the shared test-home override (SPECRAILS_REGISTRY_HOME) so tests never
// touch the real ~/.specrails/mcp.token; falls back to os.homedir() in prod.
function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}
function tokenDir(): string {
  return path.join(homeDir(), '.specrails')
}
function tokenPath(): string {
  return path.join(tokenDir(), 'mcp.token')
}

let _mcpToken: string | null = null

function generateToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
}

/**
 * Loads the persisted MCP token, or generates and persists a fresh one.
 * Cached for the lifetime of the process.
 */
export function loadOrGenerateMcpToken(): string {
  if (_mcpToken) return _mcpToken

  try {
    const stored = readPrivateTextFile(tokenPath())
    if (stored !== null) {
      const t = stored.trim()
      if (t && t.length >= 32) {
        _mcpToken = t
        return _mcpToken
      }
    }
  } catch {
    // Fall through to generate a new token.
  }

  _mcpToken = generateToken()
  persist(_mcpToken)
  return _mcpToken
}

function persist(token: string): void {
  try {
    writePrivateTextFile(tokenPath(), token)
  } catch (err) {
    console.warn('[mcp] could not persist mcp token to disk:', err)
  }
}

/** Returns the current MCP token (generating + persisting one if needed). */
export function getMcpToken(): string {
  return loadOrGenerateMcpToken()
}

/**
 * Overwrites the MCP token with a fresh value (invalidating any previously
 * issued token) and returns the new value. Used by the Settings "regenerate"
 * action.
 */
export function regenerateMcpToken(): string {
  const next = generateToken()
  // Commit the file before switching the live credential. If persistence
  // fails, bridges must still authenticate with the existing on-disk token.
  writePrivateTextFile(tokenPath(), next)
  _mcpToken = next
  return next
}

/** Extracts a bearer token from `Authorization: Bearer <t>` or `X-Desktop-Token`. */
function extractToken(req: Request): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim()
  }
  const xToken = req.headers['x-desktop-token']
  if (typeof xToken === 'string' && xToken.trim()) return xToken.trim()
  return null
}

/**
 * Express middleware gating the MCP transport: requires the MCP-scoped token
 * (constant-time compared). Mirrors `requireAuth` from auth.ts but checks the
 * MCP token, never the master token.
 */
export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = extractToken(req)
  if (provided && safeEqual(provided, getMcpToken())) {
    next()
    return
  }
  // JSON-RPC-shaped error so MCP clients can parse it.
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: invalid MCP token' }, id: null })
}

/** Test seam: clears the cached token so a test can point HOME elsewhere. */
export function _resetMcpTokenForTest(): void {
  _mcpToken = null
}
