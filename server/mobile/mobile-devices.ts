import { createHash, randomUUID } from 'crypto'
import type { DbInstance } from '../db'
import type { MobileDeviceRow, MobileDevicePublic, MobilePlatform } from './mobile-types'

// CRUD over desktop.sqlite `mobile_devices` (table created by desktop-db migration 12).
// Tokens are stored ONLY as sha256 hashes; the plaintext token is shown to the
// phone exactly once at approval and never persisted.

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── Per-device project ACL (BUG-MOBILE-02) ──────────────────────────────────
// A companion may be scoped to a subset of projects. The grant is stored as a
// JSON array in the `allowed_projects` column. The column is added idempotently
// here (rather than via a desktop-db migration this module doesn't own) so it is
// always present before any read/write.
//   - column NULL / unset  → UNRESTRICTED (all projects). Backward-compatible:
//     every pre-existing device keeps all-projects access (byte-identical).
//   - column = JSON array   → the device may ONLY see/operate on those project ids.
// Both the WS subscribe set and the /v1 `:pid` forward intersect against this.
let _aclColumnReady = false
function ensureAclColumn(db: DbInstance): void {
  if (_aclColumnReady) return
  try {
    const cols = db.prepare('PRAGMA table_info(mobile_devices)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'allowed_projects')) {
      db.exec('ALTER TABLE mobile_devices ADD COLUMN allowed_projects TEXT')
    }
    _aclColumnReady = true
  } catch {
    // Table not created yet (gateway disabled / fresh db) — retry on next call.
  }
}

/** Test/lifecycle seam: forget the cached "column exists" flag so a fresh
 *  in-memory db in another test re-runs the idempotent ALTER. */
export function _resetAclColumnCacheForTests(): void {
  _aclColumnReady = false
}

/** The set of project ids this device may access, or `null` when unrestricted
 *  (all projects). Only the legacy NULL/unset value grants all projects;
 *  malformed persisted restrictions fail closed. */
export function getAllowedProjects(db: DbInstance, deviceId: string): Set<string> | null {
  ensureAclColumn(db)
  const row = db
    .prepare('SELECT allowed_projects FROM mobile_devices WHERE id = ?')
    .get(deviceId) as { allowed_projects: string | null } | undefined
  if (!row) return new Set()
  if (row.allowed_projects == null || row.allowed_projects === '') return null
  try {
    const parsed = JSON.parse(row.allowed_projects) as unknown
    if (!Array.isArray(parsed)) return new Set()
    if (parsed.some(x => typeof x !== 'string')) return new Set()
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

/** Restrict a device to a specific set of project ids. An empty array clears the
 *  restriction (back to unrestricted/all-projects). Parameterised SQL only. */
export function setAllowedProjects(db: DbInstance, deviceId: string, projectIds: string[]): void {
  ensureAclColumn(db)
  const deduped = [...new Set(projectIds.filter((x) => typeof x === 'string'))]
  const value = deduped.length > 0 ? JSON.stringify(deduped) : null
  db.prepare('UPDATE mobile_devices SET allowed_projects = ? WHERE id = ?').run(value, deviceId)
}

/** Intersect a requested project-id list against a device's allowed set. When the
 *  device is unrestricted (`allowed === null`) the request passes through verbatim. */
export function intersectAllowedProjects(allowed: Set<string> | null, requested: Iterable<string>): string[] {
  if (allowed === null) return [...requested]
  const out: string[] = []
  for (const p of requested) if (allowed.has(p)) out.push(p)
  return out
}

/** Whether a single project id is reachable by a device given its allowed set. */
export function isProjectAllowed(allowed: Set<string> | null, projectId: string): boolean {
  return allowed === null || allowed.has(projectId)
}

export function createDevice(
  db: DbInstance,
  opts: { name: string; platform: MobilePlatform; tokenHash: string; certFingerprint: string },
): MobileDeviceRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO mobile_devices (id, name, platform, token_hash, scopes, cert_fingerprint)
     VALUES (?, ?, ?, ?, 'companion', ?)`,
  ).run(id, opts.name, opts.platform, opts.tokenHash, opts.certFingerprint)
  return db.prepare('SELECT * FROM mobile_devices WHERE id = ?').get(id) as MobileDeviceRow
}

/** Look up a device by its token hash. Returns undefined if unknown OR revoked —
 *  a revoked device must behave as if it never existed. */
export function getActiveDeviceByTokenHash(db: DbInstance, tokenHash: string): MobileDeviceRow | undefined {
  const row = db
    .prepare('SELECT * FROM mobile_devices WHERE token_hash = ?')
    .get(tokenHash) as MobileDeviceRow | undefined
  if (!row || row.revoked_at) return undefined
  return row
}

export function listDevices(db: DbInstance): MobileDevicePublic[] {
  const rows = db
    .prepare('SELECT * FROM mobile_devices ORDER BY created_at DESC')
    .all() as MobileDeviceRow[]
  return rows.map(toPublic)
}

export function toPublic(row: MobileDeviceRow): MobileDevicePublic {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastIp: row.last_ip,
    revoked: !!row.revoked_at,
  }
}

/** Mark a device revoked (idempotent). Returns true if a row was affected. */
export function revokeDevice(db: DbInstance, id: string): boolean {
  const res = db
    .prepare("UPDATE mobile_devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(id)
  return res.changes > 0
}

/** Revoke EVERY device — used by cert rotation ("Reset mobile identity"). */
export function revokeAllDevices(db: DbInstance): number {
  const res = db
    .prepare("UPDATE mobile_devices SET revoked_at = datetime('now') WHERE revoked_at IS NULL")
    .run()
  return res.changes
}

/** Refresh last_seen_at/last_ip. Callers throttle this to ~1/min per device. */
export function touchDevice(db: DbInstance, id: string, ip: string | undefined): void {
  db.prepare("UPDATE mobile_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?").run(ip ?? null, id)
}

/** Sliding-expiry sweep: revoke devices unseen for `days` (default 90). Devices
 *  that have never connected are measured from created_at. Returns count revoked. */
export function sweepExpiredDevices(db: DbInstance, days = 90): number {
  const res = db
    .prepare(
      `UPDATE mobile_devices SET revoked_at = datetime('now')
       WHERE revoked_at IS NULL
         AND COALESCE(last_seen_at, created_at) < datetime('now', ?)`,
    )
    .run(`-${days} days`)
  return res.changes
}
