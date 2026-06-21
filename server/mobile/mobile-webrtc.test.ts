import { describe, it, expect, vi } from 'vitest'
import { buildRegisterDevice, buildRpcDispatch, type FetchLike } from './mobile-webrtc'
import { hashToken } from './mobile-devices'
import type { DbInstance } from '../db'

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const db = {
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO mobile_devices')) {
            const [id, name, platform, token_hash, cert_fingerprint] = args as string[]
            rows.set(id, {
              id, name, platform, token_hash, scopes: 'companion', cert_fingerprint,
              created_at: 'now', last_seen_at: null, last_ip: null, revoked_at: null,
            })
          }
          return { changes: 1 }
        },
        get: (arg: string) => {
          // getActiveDeviceByTokenHash resolves by token_hash; everything else by id.
          if (sql.includes('WHERE token_hash = ?')) {
            return [...rows.values()].find((r) => r.token_hash === arg)
          }
          return rows.get(arg)
        },
        all: () => [...rows.values()],
      }
    },
  }
  return { db: db as unknown as DbInstance, rows }
}

function registerDeps() {
  const { db, rows } = fakeDb()
  const fn = buildRegisterDevice({
    db,
    currentFingerprint: () => 'fp-abc',
    desktopName: () => 'Mac Studio',
    desktopInstanceId: () => 'inst-1',
    genToken: () => 'fixed-token',
  })
  return { fn, rows }
}

describe('buildRegisterDevice', () => {
  // The single-use secret check lives per-connection in MobileWebrtcGateway
  // (and is covered by the DataChannelPeer "wrong-secret" test); this just
  // persists the device once that check has passed.
  it('persists a device and returns the welcome', async () => {
    const { fn, rows } = registerDeps()
    const r = await fn({ deviceName: 'iPhone', platform: 'web' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.token).toBe('fixed-token')
      expect(r.hubName).toBe('Mac Studio')
      expect(r.hubInstanceId).toBe('inst-1')
      expect(rows.get(r.deviceId)).toMatchObject({ platform: 'web', cert_fingerprint: 'fp-abc' })
    }
  })

  it('defaults a blank device name and maps unknown platforms to web', async () => {
    const { fn, rows } = registerDeps()
    const r = await fn({ deviceName: '', platform: 'palm-os' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(rows.get(r.deviceId)).toMatchObject({ name: 'Web companion', platform: 'web' })
  })

  it('reuses an existing device when a known token is presented (no new row)', async () => {
    const { db, rows } = fakeDb()
    const fn = buildRegisterDevice({
      db, currentFingerprint: () => 'fp', desktopName: () => 'Mac', desktopInstanceId: () => 'i',
      genToken: () => 'tok-A',
    })
    const first = await fn({ deviceName: 'iPhone', platform: 'web' }) // QR mint
    expect(first.ok).toBe(true)
    expect(rows.size).toBe(1)
    // Reconnect with the same token → same device, no new row.
    const again = await fn({ deviceName: 'iPhone', platform: 'web', token: 'tok-A', requireExistingToken: true })
    expect(again.ok).toBe(true)
    if (again.ok && first.ok) expect(again.deviceId).toBe(first.deviceId)
    expect(rows.size).toBe(1)
  })

  // ── BUG-AUTH-01: reconnect re-registration must require a valid existing token ──
  describe('reconnect token requirement (BUG-AUTH-01)', () => {
    it('refuses to mint a device on the reconnect path with NO token (mailbox-only attacker)', async () => {
      const { db, rows } = fakeDb()
      const fn = buildRegisterDevice({
        db, currentFingerprint: () => 'fp', desktopName: () => 'Mac', desktopInstanceId: () => 'i',
      })
      const r = await fn({ deviceName: 'Evil', platform: 'web', requireExistingToken: true })
      expect(r.ok).toBe(false)
      expect(rows.size).toBe(0) // nothing minted
    })

    it('refuses an UNKNOWN/revoked token on the reconnect path', async () => {
      const { db, rows } = fakeDb()
      const fn = buildRegisterDevice({
        db, currentFingerprint: () => 'fp', desktopName: () => 'Mac', desktopInstanceId: () => 'i',
      })
      const r = await fn({ deviceName: 'Evil', platform: 'web', token: 'never-issued', requireExistingToken: true })
      expect(r.ok).toBe(false)
      expect(rows.size).toBe(0)
    })

    it('accepts a VALID existing token on the reconnect path and reuses the device', async () => {
      const { db, rows } = fakeDb()
      // Seed a paired device whose token hash matches 'good-tok'.
      const seed = buildRegisterDevice({
        db, currentFingerprint: () => 'fp', desktopName: () => 'Mac', desktopInstanceId: () => 'i',
        genToken: () => 'good-tok',
      })
      const paired = await seed({ deviceName: 'iPhone', platform: 'web' })
      expect(paired.ok).toBe(true)
      // Sanity: the seeded row's token_hash is the sha256 of the issued token.
      expect([...rows.values()][0].token_hash).toBe(hashToken('good-tok'))

      const reconnect = await seed({
        deviceName: 'iPhone', platform: 'web', token: 'good-tok', requireExistingToken: true,
      })
      expect(reconnect.ok).toBe(true)
      if (reconnect.ok && paired.ok) expect(reconnect.deviceId).toBe(paired.deviceId)
      expect(rows.size).toBe(1) // no new device minted
    })

    it('still MINTS on first-time QR pairing (requireExistingToken unset)', async () => {
      const { db, rows } = fakeDb()
      const fn = buildRegisterDevice({
        db, currentFingerprint: () => 'fp', desktopName: () => 'Mac', desktopInstanceId: () => 'i',
        genToken: () => 'qr-tok',
      })
      const r = await fn({ deviceName: 'iPhone', platform: 'web' }) // no requireExistingToken
      expect(r.ok).toBe(true)
      expect(rows.size).toBe(1)
    })
  })
})

describe('buildRpcDispatch', () => {
  function withFetch(status: number, text: string) {
    const doFetch = vi.fn<FetchLike>(async () => ({ status, text: async () => text }))
    return { dispatch: buildRpcDispatch({ gatewayBase: 'https://127.0.0.1:4202', doFetch }), doFetch }
  }

  it('proxies a GET to the /v1 gateway with the bearer token', async () => {
    const { dispatch, doFetch } = withFetch(200, JSON.stringify({ projects: [] }))
    const r = await dispatch({ method: 'GET', path: '/v1/projects', token: 'tok-1' })
    expect(r).toEqual({ status: 200, json: { projects: [] } })
    expect(doFetch).toHaveBeenCalledWith('https://127.0.0.1:4202/v1/projects', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok-1' },
      body: undefined,
    })
  })

  it('serializes a body + content-type for POST', async () => {
    const { dispatch, doFetch } = withFetch(201, '{}')
    await dispatch({ method: 'POST', path: '/v1/projects/p/tickets/from-prompt', body: { prompt: 'hi' }, token: 't' })
    const [, init] = doFetch.mock.calls[0]
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"prompt":"hi"}')
  })

  it('refuses paths outside /v1 with 404 and never fetches', async () => {
    const { dispatch, doFetch } = withFetch(200, '{}')
    expect(await dispatch({ method: 'GET', path: '/api/secrets', token: 't' })).toEqual({
      status: 404,
      json: { error: 'not found' },
    })
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('maps a transport failure to 502', async () => {
    const doFetch = vi.fn<FetchLike>(async () => {
      throw new Error('ECONNREFUSED')
    })
    const dispatch = buildRpcDispatch({ gatewayBase: 'https://127.0.0.1:4202', doFetch })
    expect(await dispatch({ method: 'GET', path: '/v1/projects', token: 't' })).toEqual({
      status: 502,
      json: { error: 'gateway unreachable' },
    })
  })
})
