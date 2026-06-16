import type { SocketLike } from './mobile-ws'

// WebRTC DataChannel transport for the web companion (serverless double-QR
// pairing). Instead of a LAN WSS gateway, the companion connects peer-to-peer
// over a WebRTC DataChannel; this module bridges that channel onto the EXISTING
// mobile semantics so nothing downstream changes:
//   - push frames + per-subscription filtering + redaction + log batching  →
//     reused verbatim by presenting the channel to MobileWsBridge as a SocketLike.
//   - control frames (subscribe / watch_job / unwatch_job)                  →
//     delivered straight to that same bridge.
//   - hello → welcome (device registration + token)                        → new.
//   - rpc → rpc_result (the /v1 allow-list)                                → new.
// The two new flows are dependency-injected so the protocol logic is unit-tested
// without a real WebRTC stack, the database, or the loopback HTTP forward.

const WS_OPEN = 1
const WS_CLOSED = 3

/** Minimal structural view of a WebRTC DataChannel (werift RTCDataChannel or the
 *  browser type), so the wiring adapter and tests can both satisfy it. */
export interface DataChannelLike {
  readonly readyState: string // 'open' | 'closed' | 'connecting' | 'closing'
  send(data: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
}

/** Presents a DataChannel to MobileWsBridge as if it were a ws.WebSocket, so the
 *  existing fan-out (redaction, per-subscription filtering, log batching) is
 *  reused unchanged. WebRTC has no ping/pong frames, so ping() reports liveness
 *  synchronously — DTLS keepalive + onClose drive real liveness. */
export class DataChannelSocket implements SocketLike {
  private _handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  constructor(private _ch: DataChannelLike) {}

  get readyState(): number {
    return this._ch.readyState === 'open' ? WS_OPEN : WS_CLOSED
  }

  send(data: string): void {
    try {
      this._ch.send(data)
    } catch {
      /* channel went away mid-send — onClose will reap it */
    }
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this._handlers.get(event) ?? []
    list.push(cb)
    this._handlers.set(event, list)
  }

  ping(): void {
    this._emit('pong')
  }

  terminate(): void {
    this._emit('close')
  }

  close(code?: number): void {
    // 4401 = the device was revoked from the desktop — tell the companion so it
    // drops to the pairing screen instead of silently going stale.
    if (code === 4401) {
      try {
        this._ch.send(JSON.stringify({ type: 'revoked' }))
      } catch {
        /* ignore */
      }
    }
    this._emit('close')
  }

  /** Hand an inbound control frame to the bridge (its `message` listener). */
  deliver(text: string): void {
    this._emit('message', text)
  }

  /** Mark the underlying channel closed (drops the socket from the bridge). */
  closed(): void {
    this._emit('close')
  }

  private _emit(event: string, ...args: unknown[]): void {
    for (const cb of this._handlers.get(event) ?? []) {
      try {
        cb(...args)
      } catch {
        /* a bad listener must not break fan-out */
      }
    }
  }
}

export interface WelcomeResult {
  ok: true
  deviceId: string
  token: string
  hubName: string
  hubInstanceId: string
}

export interface DataChannelPeerDeps {
  /** The reused push/control fan-out. */
  bridge: { attach(ws: SocketLike, deviceId: string): void }
  /** Validate the pairing secret and register the device; returns the welcome. */
  registerDevice: (input: {
    secret: string
    deviceName: string
    platform: string
    token?: string
  }) => Promise<WelcomeResult | { ok: false }>
  /** Dispatch a /v1 RPC carrying the device's token; returns status + json. */
  rpcDispatch: (input: {
    method: string
    path: string
    body?: unknown
    token: string
  }) => Promise<{ status: number; json: unknown }>
}

/** One paired companion over one DataChannel. Demultiplexes hello / rpc / control
 *  frames; everything else (push) flows out via the bridge. */
export class DataChannelPeer {
  private _sock: DataChannelSocket
  private _authed = false
  private _token = ''

  constructor(private _ch: DataChannelLike, private _deps: DataChannelPeerDeps) {
    this._sock = new DataChannelSocket(_ch)
    _ch.onMessage((data) => {
      void this._onMessage(data)
    })
    _ch.onClose(() => this._sock.closed())
  }

  get authed(): boolean {
    return this._authed
  }

  private _send(obj: unknown): void {
    try {
      this._ch.send(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }

  private async _onMessage(data: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }

    switch (msg.type) {
      case 'hello': {
        if (this._authed) return
        const secret = typeof msg.sec === 'string' ? msg.sec : ''
        const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Device'
        const platform = typeof msg.platform === 'string' ? msg.platform : 'web'
        const token = typeof msg.token === 'string' ? msg.token : undefined
        const r = await this._deps.registerDevice({ secret, deviceName, platform, token })
        console.log('[webrtc] hello received; device registered:', r.ok)
        if (!r.ok) {
          this._send({ type: 'pair_denied' })
          return
        }
        this._authed = true
        this._token = r.token
        this._deps.bridge.attach(this._sock, r.deviceId)
        this._send({
          type: 'welcome',
          deviceId: r.deviceId,
          token: r.token,
          // FROZEN field names — mobile pairing wire contract.
          hubName: r.hubName,
          hubInstanceId: r.hubInstanceId,
        })
        return
      }

      case 'rpc': {
        const id = typeof msg.id === 'string' ? msg.id : null
        if (!id) return
        if (!this._authed) {
          this._send({ type: 'rpc_result', id, status: 401, json: { error: 'not paired' } })
          return
        }
        const method = typeof msg.method === 'string' ? msg.method : 'GET'
        const path = typeof msg.path === 'string' ? msg.path : ''
        const r = await this._deps.rpcDispatch({ method, path, body: msg.body, token: this._token })
        this._send({ type: 'rpc_result', id, status: r.status, json: r.json })
        return
      }

      default:
        // subscribe / watch_job / unwatch_job — reuse the bridge's inbound logic.
        if (this._authed) this._sock.deliver(data)
    }
  }
}
