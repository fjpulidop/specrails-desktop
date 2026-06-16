// Shared types for the Mobile Gateway (server/mobile/*).
//
// The gateway is a second HTTPS+WSS listener in the SAME Node process as the
// main server, default port 4202, OFF by default. It pairs phones/tablets by QR +
// desktop-approval and exposes a deny-by-default allow-list of the existing API,
// redacted, over a per-device token. The main server at 127.0.0.1:4200 is never
// itself exposed. See docs/mobile.md.

// 'web' = the serverless WebRTC web companion (specrails.dev/companion-app).
export type MobilePlatform = 'ios' | 'android' | 'web'

/** A paired device, as stored in desktop.sqlite `mobile_devices` (migration 12). */
export interface MobileDeviceRow {
  id: string
  name: string
  platform: MobilePlatform
  token_hash: string
  scopes: string
  cert_fingerprint: string
  created_at: string
  last_seen_at: string | null
  last_ip: string | null
  revoked_at: string | null
}

/** Device shape returned to the desktop UI (never includes token_hash). */
export interface MobileDevicePublic {
  id: string
  name: string
  platform: MobilePlatform
  scopes: string
  createdAt: string
  lastSeenAt: string | null
  lastIp: string | null
  revoked: boolean
}

/** The JSON payload encoded into the pairing QR (wrapped in a `specrails://pair?d=`
 *  deep-link). Carries everything the phone needs to connect WITHOUT any prior
 *  discovery: candidate LAN addresses, port, the cert fingerprint to pin, and a
 *  high-entropy single-use secret with a short TTL. */
export interface QrPayload {
  v: 1
  hub: string          // stable instance UUID — mobile-app v1 wire compat: field name frozen, do not rename
  name: string         // user-visible instance name
  addrs: string[]      // candidate LAN IPv4 addresses
  port: number
  fp: string           // sha256 hex of the gateway cert DER (pin target)
  secret: string       // base64url, 16 random bytes, single-use
  claimId: string      // base64url, 16 random bytes — opaque poll handle
  exp: number          // unix epoch seconds
}

export type PairingStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'expired'

/** State the desktop UI polls while a pairing session is open. */
export interface PairingSessionState {
  status: PairingStatus
  claimId: string
  /** Present once a phone has claimed (so the desktop can show the device name
   *  before the user approves). */
  device?: { name: string; platform: MobilePlatform }
  qr?: QrPayload
}

/** Result the phone receives from GET /pair/status once approved (token is
 *  delivered EXACTLY ONCE, then scrubbed server-side). */
export interface PairApprovedResult {
  approved: true
  deviceToken: string
  deviceId: string
  hubName: string       // mobile-app v1 wire compat — field name frozen, do not rename
  hubInstanceId: string // mobile-app v1 wire compat — field name frozen, do not rename
}
