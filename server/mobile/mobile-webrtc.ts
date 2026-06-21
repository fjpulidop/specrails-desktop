import https from 'https'
import { randomBytes } from 'crypto'
import { createDevice, getActiveDeviceByTokenHash, hashToken } from './mobile-devices'
import type { DbInstance } from '../db'
import type { MobilePlatform } from './mobile-types'
import type { WelcomeResult } from './mobile-datachannel'

// Glue for the serverless WebRTC companion, kept dependency-injected so the
// security-relevant bits (secret check, device creation, /v1 dispatch) are
// unit-tested without a real WebRTC peer, the DB driver, or HTTP. The werift
// runtime peer lives in ./mobile-webrtc-peer.ts and consumes these.

function toPlatform(p: string): MobilePlatform {
  return p === 'android' ? 'android' : p === 'ios' ? 'ios' : 'web'
}

export interface RegisterDeviceDeps {
  db: DbInstance
  currentFingerprint: () => string
  desktopName: () => string
  desktopInstanceId: () => string
  genToken?: () => string
}

/** Persists a paired device + issues its token. The single-use pairing-secret
 *  check is done per-connection by [MobileWebrtcGateway] (which holds each
 *  offer's secret for the life of that connection — the secret must NOT live on
 *  the global "pending offer", which is cleared the moment the answer is
 *  accepted, well before the companion's `hello` arrives). Approval is implicit:
 *  the desktop user actively scanned the phone's answer QR.
 *
 *  BUG-AUTH-01: `requireExistingToken` gates the RECONNECT path. The reconnect
 *  offer (and its secret) travels through a PUBLIC mailbox, so the secret alone
 *  must NOT be sufficient to mint a device. When set, a missing/unresolved token
 *  returns `{ok:false}` — only an already-paired, non-revoked device token can
 *  re-register. First-time QR pairing leaves it unset and may mint. */
export function buildRegisterDevice(deps: RegisterDeviceDeps) {
  const genToken = deps.genToken ?? (() => randomBytes(32).toString('hex'))
  return async (input: {
    deviceName: string
    platform: string
    token?: string
    requireExistingToken?: boolean
  }): Promise<WelcomeResult | { ok: false }> => {
    // Reconnect: a known, non-revoked device token → reuse that device (no new
    // row, no growing the paired-devices list on every reconnect).
    if (input.token) {
      const existing = getActiveDeviceByTokenHash(deps.db, hashToken(input.token))
      if (existing) {
        return {
          ok: true,
          deviceId: existing.id,
          token: input.token,
          hubName: deps.desktopName(),
          hubInstanceId: deps.desktopInstanceId(),
        }
      }
    }
    // Reconnect re-registration MUST present a valid existing token. An absent or
    // unknown/revoked token here is an attacker who only read the mailbox secret —
    // refuse rather than mint a brand-new full-scope companion device.
    if (input.requireExistingToken) {
      return { ok: false }
    }
    const token = genToken()
    const row = createDevice(deps.db, {
      name: (input.deviceName || 'Web companion').slice(0, 80),
      platform: toPlatform(input.platform),
      tokenHash: hashToken(token),
      certFingerprint: deps.currentFingerprint(),
    })
    return {
      ok: true,
      deviceId: row.id,
      token,
      hubName: deps.desktopName(),
      hubInstanceId: deps.desktopInstanceId(),
    }
  }
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number
    text: () => Promise<string>
  }>
}

export interface RpcDispatchDeps {
  /** Base URL of the local authenticated `/v1` gateway, e.g. `https://127.0.0.1:4202`. */
  gatewayBase: string
  /** Loopback fetch (the default ignores the gateway's self-signed cert). */
  doFetch: FetchLike
}

/** Builds the `rpcDispatch` used by [DataChannelPeer] on `rpc`. A thin proxy to
 *  the EXISTING `/v1` allow-list (which already validates params, forwards to the
 *  internal API, and redacts), authenticated with the device's bearer token. */
export function buildRpcDispatch(deps: RpcDispatchDeps) {
  return async (input: {
    method: string
    path: string
    body?: unknown
    token: string
  }): Promise<{ status: number; json: unknown }> => {
    // Only the /v1 surface is reachable; the gateway enforces the allow-list.
    if (input.path !== '/v1' && !input.path.startsWith('/v1/')) {
      return { status: 404, json: { error: 'not found' } }
    }
    const method = input.method.toUpperCase()
    const headers: Record<string, string> = { Authorization: `Bearer ${input.token}` }
    let body: string | undefined
    if (input.body !== undefined && method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(input.body)
    }
    try {
      const res = await deps.doFetch(deps.gatewayBase + input.path, { method, headers, body })
      const text = await res.text()
      let json: unknown = {}
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = {}
      }
      return { status: res.status, json }
    } catch {
      return { status: 502, json: { error: 'gateway unreachable' } }
    }
  }
}

/** A loopback `fetch` for the local /v1 gateway. It deliberately ignores the
 *  gateway's self-signed cert — the connection never leaves 127.0.0.1, and the
 *  device bearer token (not the TLS cert) is the auth boundary. */
export function createLoopbackFetch(): FetchLike {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url)
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init.method,
          headers: init.headers,
          rejectUnauthorized: false,
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (c: string) => {
            data += c
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: async () => data }))
        },
      )
      req.on('error', reject)
      if (init.body) req.write(init.body)
      req.end()
    })
}
