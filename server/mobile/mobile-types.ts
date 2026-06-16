// Shared types for the Mobile Gateway (server/mobile/*).
//
// The gateway is a second HTTPS listener in the SAME Node process as the main
// server, default port 4202, OFF by default. It pairs the web companion
// serverlessly over WebRTC (double-QR) and exposes a deny-by-default allow-list
// of the existing API, redacted, over a per-device token. The main server at
// 127.0.0.1:4200 is never itself exposed.

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
