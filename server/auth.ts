import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID, timingSafeEqual } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Request, Response, NextFunction } from 'express'
import { readPrivateTextFile, writePrivateTextFile } from './util/secure-token-file'

const TOKEN_DIR = path.join(os.homedir(), '.specrails')
const TOKEN_PATH = path.join(TOKEN_DIR, 'desktop.token')
// Legacy (pre-rebrand) token filename — referenced by the one-time migration
// below only. Migration/compat code.
const LEGACY_TOKEN_PATH = path.join(TOKEN_DIR, 'hub.token')

let _token: string | null = null

/**
 * Rebrand migration (Specrails Hub → Specrails Desktop): if the legacy
 * `hub.token` exists and the new `desktop.token` does not, rename it before
 * reading so existing clients keep their token across the rename.
 */
function migrateLegacyTokenFile(): void {
  try {
    if (fs.existsSync(LEGACY_TOKEN_PATH) && !fs.existsSync(TOKEN_PATH)) {
      fs.renameSync(LEGACY_TOKEN_PATH, TOKEN_PATH)
    }
  } catch {
    // Non-fatal — a fresh token will be generated below if the read fails.
  }
}

/**
 * Loads an existing API token from disk, or generates and persists a new one.
 * Returns the same token for the lifetime of the process.
 *
 * DESIGN NOTE (H-06): this is a single static, non-expiring, unscoped token
 * (≈122 bits) that grants EVERYTHING — terminals (= remote shell), arbitrary
 * `claude --dangerously-skip-permissions` spawns, filesystem reads, project
 * admin. We deliberately do NOT mitigate this in-process: changing the token
 * model would break the existing web client and CLI, and the correct fix is
 * architectural. The future Mobile Gateway issues PER-DEVICE, hashed,
 * `companion`-scoped tokens bound to a cert fingerprint with sliding 90-day
 * expiry + revocation, and NEVER exposes this master token to the network. The
 * master token stays loopback-only (see `requireLoopback`) + bound to 127.0.0.1.
 */
export function loadOrGenerateToken(): string {
  if (_token) return _token

  migrateLegacyTokenFile()

  try {
    const stored = readPrivateTextFile(TOKEN_PATH)
    if (stored !== null) {
      const t = stored.trim()
      if (t && t.length >= 32) {
        _token = t
        return _token
      }
    }
  } catch {
    // Fall through to generate a new token
  }

  _token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')

  try {
    writePrivateTextFile(TOKEN_PATH, _token)
  } catch (err) {
    console.warn('[auth] could not persist token to disk:', err)
  }

  return _token
}

/** Returns the server token (for use in tests or the CLI). */
export function getServerToken(): string {
  return loadOrGenerateToken()
}

/**
 * Constant-time string comparison (H-05).
 *
 * `a !== b` on strings short-circuits at the first differing byte, leaking a
 * timing oracle that can recover a secret byte-by-byte. `timingSafeEqual`
 * compares in time independent of where the first mismatch is — but it THROWS
 * when the two buffers differ in length, so we length-guard first. The length
 * guard itself is not secret (the token length is fixed and public), so it
 * leaks nothing useful.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * True when an address is an IPv4/IPv6 loopback address.
 *
 * Node reports the peer of a TCP connection as `req.socket.remoteAddress`.
 * For a server bound to 127.0.0.1 this is always loopback today, but the
 * `requireLoopback` middleware below is an explicit, bind-independent guard so
 * that the day the Mobile Gateway (or a mistaken bind change) opens a network
 * surface, the most sensitive endpoints (token bootstrap, OTLP, docs) still
 * reject non-local peers. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and the whole
 * 127.0.0.0/8 block are treated as loopback.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true
  // Strip an IPv4-mapped IPv6 prefix if present.
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/**
 * Express middleware that rejects any request whose peer is not on the loopback
 * interface (H-02/H-03/H-04). Applied to endpoints that must work without a
 * token for the local client/CLI/telemetry to bootstrap, but must never be
 * reachable from the network: `/api/token`, `/otlp`, `/api/docs`.
 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    next()
    return
  }
  res.status(403).json({ error: 'Forbidden: loopback only' })
}

// ─── Host-header validation (H-08) — anti DNS-rebinding ───────────────────────
//
// CORS alone does not stop DNS rebinding: a same-origin GET carries no Origin
// header, so a CORS check lets it through. Validating the Host header does stop
// it — a rebound page keeps sending `Host: evil.com:4200` (the host is the
// page's origin, not the resolved IP), which fails this allowlist. Legitimate
// clients (web on localhost/127.0.0.1, the CLI, the Tauri WebView via
// tauri.localhost, telemetry on 127.0.0.1) all match. A missing Host is allowed
// (non-browser HTTP/1.0 clients); browsers always send one, so the rebinding
// vector is still closed.
export const ALLOWED_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\]|tauri\.localhost)(:\d+)?$/

/** True when a Host header value is an allowed loopback host (or absent). */
export function isAllowedHost(host: string | undefined): boolean {
  return host === undefined || ALLOWED_HOST_PATTERN.test(host)
}

/** Express middleware: 403 when the Host header is present and not loopback. */
export function hostValidationMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isAllowedHost(req.headers['host'])) {
    next()
    return
  }
  res.status(403).json({ error: 'Forbidden: invalid Host header' })
}

/**
 * Resets the in-memory token cache (for tests only).
 * @internal
 */
export function _resetTokenForTest(): void {
  _token = null
}

/**
 * Express middleware that requires a valid Bearer or X-Desktop-Token header.
 * Returns 401 for missing or invalid tokens.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = loadOrGenerateToken()

  const authHeader = req.headers['authorization']
  const desktopTokenHeader = req.headers['x-desktop-token']

  let provided: string | null = null

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7).trim()
  } else if (typeof desktopTokenHeader === 'string') {
    provided = desktopTokenHeader.trim()
  }

  if (!provided || !safeEqual(provided, token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}

/**
 * Extracts the server token from a WebSocket upgrade request.
 *
 * Browsers cannot set custom headers for WebSocket upgrades, so the frontend
 * sends the token as a subprotocol: `desktop-token.<token>`. The CLI can use
 * the standard Authorization header.
 */
export function tokenFromUpgradeRequest(request: IncomingMessage): string | null {
  const authHeader = request.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }

  const protocolHeader = request.headers['sec-websocket-protocol']
  if (typeof protocolHeader !== 'string') return null

  for (const part of protocolHeader.split(',')) {
    const protocol = part.trim()
    if (protocol.startsWith('desktop-token.')) {
      return protocol.slice('desktop-token.'.length).trim()
    }
  }
  return null
}
