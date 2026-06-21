import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb } from '../desktop-db'
import type { DbInstance } from '../db'
import {
  hashToken,
  createDevice,
  getActiveDeviceByTokenHash,
  listDevices,
  revokeDevice,
  revokeAllDevices,
  touchDevice,
  sweepExpiredDevices,
  getAllowedProjects,
  setAllowedProjects,
  intersectAllowedProjects,
  isProjectAllowed,
  _resetAclColumnCacheForTests,
} from './mobile-devices'

describe('mobile-devices', () => {
  let db: DbInstance
  beforeEach(() => {
    _resetAclColumnCacheForTests()
    db = initDesktopDb(':memory:')
  })

  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })

  it('creates and resolves an active device by token hash', () => {
    const token = 'tok-123'
    const row = createDevice(db, { name: 'iPhone', platform: 'ios', tokenHash: hashToken(token), certFingerprint: 'fp1' })
    expect(row.id).toBeTruthy()
    const found = getActiveDeviceByTokenHash(db, hashToken(token))
    expect(found?.id).toBe(row.id)
    expect(found?.scopes).toBe('companion')
    expect(getActiveDeviceByTokenHash(db, hashToken('other'))).toBeUndefined()
  })

  it('revoked devices resolve as undefined', () => {
    const row = createDevice(db, { name: 'A', platform: 'android', tokenHash: hashToken('t'), certFingerprint: 'fp' })
    expect(revokeDevice(db, row.id)).toBe(true)
    expect(revokeDevice(db, row.id)).toBe(false) // idempotent (already revoked)
    expect(getActiveDeviceByTokenHash(db, hashToken('t'))).toBeUndefined()
  })

  it('lists devices (public shape, no token_hash) newest-first', () => {
    createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
    createDevice(db, { name: 'B', platform: 'ios', tokenHash: hashToken('b'), certFingerprint: 'fp' })
    const list = listDevices(db)
    expect(list).toHaveLength(2)
    expect(Object.keys(list[0])).not.toContain('token_hash')
    expect(list[0]).toHaveProperty('revoked', false)
  })

  it('revokeAllDevices revokes every active device', () => {
    createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
    createDevice(db, { name: 'B', platform: 'ios', tokenHash: hashToken('b'), certFingerprint: 'fp' })
    expect(revokeAllDevices(db)).toBe(2)
    expect(listDevices(db).every((d) => d.revoked)).toBe(true)
  })

  it('touchDevice updates last_seen_at/last_ip', () => {
    const row = createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
    touchDevice(db, row.id, '192.168.1.5')
    const found = getActiveDeviceByTokenHash(db, hashToken('a'))
    expect(found?.last_ip).toBe('192.168.1.5')
    expect(found?.last_seen_at).toBeTruthy()
  })

  // ── BUG-MOBILE-02: per-device project ACL ──
  describe('allowed-projects ACL', () => {
    it('a freshly-created device is UNRESTRICTED (null grant = all projects)', () => {
      const row = createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
      expect(getAllowedProjects(db, row.id)).toBeNull()
      expect(isProjectAllowed(getAllowedProjects(db, row.id), 'anything')).toBe(true)
    })

    it('setAllowedProjects scopes the device; getAllowedProjects returns the set', () => {
      const row = createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
      setAllowedProjects(db, row.id, ['p1', 'p2', 'p1']) // dedupes
      const allowed = getAllowedProjects(db, row.id)
      expect(allowed).not.toBeNull()
      expect([...(allowed as Set<string>)].sort()).toEqual(['p1', 'p2'])
      expect(isProjectAllowed(allowed, 'p1')).toBe(true)
      expect(isProjectAllowed(allowed, 'p3')).toBe(false)
    })

    it('an empty array clears the restriction back to unrestricted', () => {
      const row = createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
      setAllowedProjects(db, row.id, ['p1'])
      expect(getAllowedProjects(db, row.id)).not.toBeNull()
      setAllowedProjects(db, row.id, [])
      expect(getAllowedProjects(db, row.id)).toBeNull()
    })

    it('intersectAllowedProjects filters a requested list (unrestricted passes through)', () => {
      expect(intersectAllowedProjects(null, ['p1', 'p2'])).toEqual(['p1', 'p2'])
      expect(intersectAllowedProjects(new Set(['p1']), ['p1', 'p2', 'p3'])).toEqual(['p1'])
      expect(intersectAllowedProjects(new Set(['x']), ['p1'])).toEqual([])
    })
  })

  it('sweepExpiredDevices revokes devices older than the window', () => {
    const row = createDevice(db, { name: 'old', platform: 'ios', tokenHash: hashToken('a'), certFingerprint: 'fp' })
    // Backdate created_at beyond 90 days.
    db.prepare("UPDATE mobile_devices SET created_at = datetime('now', '-100 days') WHERE id = ?").run(row.id)
    expect(sweepExpiredDevices(db, 90)).toBe(1)
    expect(getActiveDeviceByTokenHash(db, hashToken('a'))).toBeUndefined()
    // A fresh device is untouched.
    createDevice(db, { name: 'new', platform: 'ios', tokenHash: hashToken('b'), certFingerprint: 'fp' })
    expect(sweepExpiredDevices(db, 90)).toBe(0)
  })
})
