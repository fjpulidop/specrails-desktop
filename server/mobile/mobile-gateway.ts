import os from 'os'
import https from 'https'
import { randomBytes, randomUUID } from 'crypto'
import express from 'express'
import type { Express } from 'express'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import { getDesktopSetting, setDesktopSetting } from '../desktop-db'
import { loadOrCreateCert, rotateCert, mobileDir, type GatewayCert } from './mobile-tls'
import { createMobileRouter } from './mobile-router'
import { MobileWsBridge } from './mobile-ws'
import { listDevices, revokeAllDevices, sweepExpiredDevices, getAllowedProjects } from './mobile-devices'
import { MobileWebrtcGateway } from './mobile-webrtc-peer'
import { MobileSignalReconnect } from './mobile-signal-reconnect'
import { buildRegisterDevice, buildRpcDispatch, createLoopbackFetch } from './mobile-webrtc'
import type { MobilePlatform } from './mobile-types'

// Lifecycle owner of the second HTTPS+WSS listener (default :4202), hard-isolated
// from the main server. Off by default; started on enable or boot-if-enabled.

const DEFAULT_PORT = 4202
const SETTING = {
  enabled: 'mobile.enabled',
  port: 'mobile.port',
  instanceId: 'mobile.desktop_instance_id',
  name: 'mobile.desktop_name',
  fingerprint: 'mobile.cert_fingerprint',
} as const
// Legacy fallback — pre-rebrand (Specrails Hub) setting keys. Values are
// read-migrated to the renamed keys on first access so the stable instance id
// (which paired phones already store as `hubInstanceId`) survives the rename.
const LEGACY_SETTING = {
  instanceId: 'mobile.hub_instance_id',
  name: 'mobile.hub_name',
} as const

export interface MobileGatewayDeps {
  desktopDb: DbInstance
  desktopPort: number
  broadcast: (msg: WsMessage) => void
  /** Test seams. */
  bindHost?: string
  /** Overrides the `mobile.port` setting (use 0 for an ephemeral test port). */
  port?: number
}

export interface MobileGatewayStatus {
  enabled: boolean
  running: boolean
  port: number
  certFingerprint: string | null
  desktopName: string
}

export class MobileGateway {
  private readonly _db: DbInstance
  private readonly _desktopPort: number
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _bindHost: string
  private _cert: GatewayCert | null = null
  private _server: https.Server | null = null
  private _bridge: MobileWsBridge | null = null
  private _webrtc: MobileWebrtcGateway | null = null
  private _signal: MobileSignalReconnect | null = null
  private _running = false
  private _boundPort = DEFAULT_PORT
  private readonly _portOverride?: number

  constructor(deps: MobileGatewayDeps) {
    this._db = deps.desktopDb
    this._desktopPort = deps.desktopPort
    this._broadcast = deps.broadcast
    this._bindHost = deps.bindHost ?? '0.0.0.0'
    this._portOverride = deps.port
  }

  get bridge(): MobileWsBridge | null {
    return this._bridge
  }
  get webrtc(): MobileWebrtcGateway | null {
    return this._webrtc
  }
  get running(): boolean {
    return this._running
  }

  private configuredPort(): number {
    if (this._portOverride !== undefined) return this._portOverride
    const raw = getDesktopSetting(this._db, SETTING.port)
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
  }

  /** Read a setting, falling back to (and one-time migrating from) its
   *  pre-rebrand key. Legacy fallback — keeps values written by Specrails Hub. */
  private settingWithLegacyFallback(key: string, legacyKey: string): string | undefined {
    const v = getDesktopSetting(this._db, key)
    if (v !== undefined) return v
    const legacy = getDesktopSetting(this._db, legacyKey)
    if (legacy !== undefined) setDesktopSetting(this._db, key, legacy)
    return legacy
  }

  private desktopName(): string {
    const v = this.settingWithLegacyFallback(SETTING.name, LEGACY_SETTING.name)
    if (v && v.trim()) return v
    try { return os.hostname() } catch { return 'Specrails' }
  }

  private instanceId(): string {
    let id = this.settingWithLegacyFallback(SETTING.instanceId, LEGACY_SETTING.instanceId)
    if (!id) {
      id = randomUUID()
      setDesktopSetting(this._db, SETTING.instanceId, id)
    }
    return id
  }

  isEnabledSetting(): boolean {
    return getDesktopSetting(this._db, SETTING.enabled) === 'true'
  }

  status(): MobileGatewayStatus {
    return {
      enabled: this.isEnabledSetting(),
      running: this._running,
      port: this._running ? this._boundPort : this.configuredPort(),
      certFingerprint: this._cert?.fingerprint ?? getDesktopSetting(this._db, SETTING.fingerprint) ?? null,
      desktopName: this.desktopName(),
    }
  }

  /** Flip the persisted enable flag + (start|stop). */
  async setEnabled(enabled: boolean): Promise<MobileGatewayStatus> {
    setDesktopSetting(this._db, SETTING.enabled, enabled ? 'true' : 'false')
    if (enabled) await this.start()
    else await this.stop()
    this._broadcast({ type: 'mobile.gateway_state', running: this._running, port: this._boundPort, timestamp: new Date().toISOString() })
    return this.status()
  }

  /** Idempotent. Loads/creates cert, binds the listener, starts the WS bridge. */
  async start(): Promise<void> {
    if (this._running) return
    // Sliding-expiry sweep on each (re)start.
    try { sweepExpiredDevices(this._db) } catch { /* non-fatal */ }

    this._cert = await loadOrCreateCert(mobileDir())
    setDesktopSetting(this._db, SETTING.fingerprint, this._cert.fingerprint)

    const app: Express = express()
    app.use(express.json({ limit: '256kb' }))
    app.use(createMobileRouter({
      db: this._db,
      desktopPort: this._desktopPort,
      currentFingerprint: () => this._cert!.fingerprint,
    }))

    const server = https.createServer({ cert: this._cert.certPem, key: this._cert.keyPem }, app)
    // BUG-MOBILE-02: scope each socket's subscribe to the device's granted
    // projects (null ⇒ unrestricted/all-projects, the default for paired devices).
    const bridge = new MobileWsBridge({
      allowedProjectsFor: (deviceId) => getAllowedProjects(this._db, deviceId),
    })
    bridge.start()

    const port = this.configuredPort()
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        // EADDRINUSE (or any bind error) must NOT crash the sidecar — surface it.
        reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : (err.message || 'listen failed')))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const addr = server.address()
        this._boundPort = typeof addr === 'object' && addr ? addr.port : port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, this._bindHost)
    })

    this._server = server
    this._bridge = bridge
    this._running = true

    // Serverless WebRTC companion peer (offerer). Reuses this bridge for push +
    // control, and tunnels its RPC to the /v1 allow-list above over loopback.
    const createWebDevice = buildRegisterDevice({
      db: this._db,
      currentFingerprint: () => this._cert!.fingerprint,
      desktopName: () => this.desktopName(),
      desktopInstanceId: () => this.instanceId(),
    })
    this._webrtc = new MobileWebrtcGateway({
      bridge,
      registerDevice: async (input) => {
        // `input` already carries `requireExistingToken` on the reconnect path
        // (set by MobileWebrtcGateway.createOffer) so a mailbox-only attacker
        // cannot mint a device — see BUG-AUTH-01.
        const r = await createWebDevice(input)
        if (r.ok) {
          this._broadcast({
            type: 'mobile.device_paired',
            deviceId: r.deviceId,
            name: input.deviceName || 'Web companion',
            timestamp: new Date().toISOString(),
          })
        }
        return r
      },
      rpcDispatch: buildRpcDispatch({
        gatewayBase: `https://127.0.0.1:${this._boundPort}`,
        doFetch: createLoopbackFetch(),
      }),
    })

    // Outbound reconnect poller: lets a refreshed/reopened companion re-establish
    // the WebRTC link via the public signaling mailbox — no QR re-scan. Polls
    // OUTBOUND only (no inbound, no cert wall); the mailbox only sees the ~5s
    // handshake.
    const signalBase =
      getDesktopSetting(this._db, 'mobile.signal_url') || 'https://specrails.dev/companion-signal.php'
    this._signal = new MobileSignalReconnect({
      signalBase,
      doFetch: (url, init) => fetch(url, init),
      rooms: () => listDevices(this._db).filter((d) => !d.revoked).map((d) => d.id),
      makeOffer: (room) => this.webrtcOffer(room),
      acceptAnswer: (room, sdp) => this.webrtcAnswer(sdp, room),
    })
    this._signal.start()
  }

  /** Idempotent teardown. */
  async stop(): Promise<void> {
    if (this._signal) { this._signal.stop(); this._signal = null }
    if (this._webrtc) { this._webrtc.stop(); this._webrtc = null }
    if (this._bridge) { this._bridge.stop(); this._bridge = null }
    if (this._server) {
      await new Promise<void>((resolve) => this._server!.close(() => resolve()))
      this._server = null
    }
    this._running = false
  }

  /** "Reset mobile identity": new cert + revoke every device + relisten. */
  async rotateCert(): Promise<MobileGatewayStatus> {
    await rotateCert(mobileDir())
    revokeAllDevices(this._db)
    const wasRunning = this._running
    if (wasRunning) {
      await this.stop()
      await this.start()
    } else {
      this._cert = await loadOrCreateCert(mobileDir())
      setDesktopSetting(this._db, SETTING.fingerprint, this._cert.fingerprint)
    }
    this._broadcast({ type: 'mobile.gateway_state', running: this._running, port: this._boundPort, timestamp: new Date().toISOString() })
    return this.status()
  }

  /** Open a serverless WebRTC pairing offer (for the first QR). Returns the offer
   *  SDP + a single-use secret + the desktop identity; the webview encodes these
   *  into the QR the companion scans. */
  async webrtcOffer(room?: string): Promise<{ sdp: string; secret: string; hubName: string; hubInstanceId: string } | null> {
    if (!this._webrtc) return null
    const secret = randomBytes(16).toString('base64url')
    // Per-room slot for reconnect (room = device id); undefined ⇒ the QR slot.
    const { sdp } = room !== undefined ? await this._webrtc.createOffer(secret, room) : await this._webrtc.createOffer(secret)
    return { sdp, secret, hubName: this.desktopName(), hubInstanceId: this.instanceId() }
  }

  /** Apply the companion's scanned answer SDP to the open offer (per-room slot
   *  for reconnect; the QR slot when no room given). */
  async webrtcAnswer(sdp: string, room?: string): Promise<boolean> {
    if (!this._webrtc) return false
    const res = room !== undefined ? await this._webrtc.acceptAnswer(sdp, room) : await this._webrtc.acceptAnswer(sdp)
    return res.ok
  }
}

export type { MobilePlatform }
