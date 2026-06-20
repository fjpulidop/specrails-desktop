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

// WebRTC DataChannels carry an SCTP per-message size cap (werift advertises a
// modest maxMessageSize; oversized sends throw). A large rpc_result — e.g. a
// JIRA-backed project's full ticket list — easily exceeds it, and the throw was
// swallowed silently, so the companion just timed out and rendered "0 tickets".
// We split any oversized frame into ordered `__chunk` envelopes and reassemble
// them on the far side. The channel is ordered+reliable, so chunks arrive in
// order; `g` (group id) keeps concurrent large messages from interleaving.
const CHUNK_SIZE = 16000
let _chunkGroup = 0

/** Send `data` over `ch`, splitting into `__chunk` frames when it exceeds the
 *  safe per-message size. Small frames go out verbatim (no envelope overhead). */
function framedSend(ch: DataChannelLike, data: string): void {
  if (data.length <= CHUNK_SIZE) {
    ch.send(data)
    return
  }
  const g = _chunkGroup++
  const n = Math.ceil(data.length / CHUNK_SIZE)
  for (let i = 0; i < n; i++) {
    const d = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    ch.send(JSON.stringify({ type: '__chunk', g, i, n, d }))
  }
}

/** Buffers inbound `__chunk` frames and yields the reassembled payload once a
 *  group is complete. Non-chunk frames pass straight through. */
export class ChunkReassembler {
  private _groups = new Map<number, { n: number; parts: string[]; got: number }>()
  // Bounds against a malicious/buggy peer: an unvalidated `n` would
  // `new Array(n).fill('')` (RangeError crash for huge/negative n, or a huge
  // allocation), and never-completing groups would leak forever.
  private static readonly MAX_CHUNKS = 1024
  private static readonly MAX_GROUPS = 64

  /** Returns the string to handle (the frame itself, or a completed
   *  reassembly), or null when more chunks of the group are still pending. */
  push(data: string): string | null {
    if (!data.startsWith('{"type":"__chunk"')) return data
    let p: { g: number; i: number; n: number; d: string }
    try {
      p = JSON.parse(data)
    } catch {
      return data
    }
    if (!p || p.n == null) return data
    // Validate counts/index BEFORE allocating: positive integer n within the
    // ceiling, and i a valid index in [0, n).
    if (!Number.isInteger(p.n) || p.n <= 0 || p.n > ChunkReassembler.MAX_CHUNKS) return null
    if (!Number.isInteger(p.i) || p.i < 0 || p.i >= p.n) return null
    let grp = this._groups.get(p.g)
    if (!grp) {
      // Cap concurrent groups; drop the oldest incomplete one when over the cap
      // so a flood of never-completed groups can't grow memory unbounded.
      if (this._groups.size >= ChunkReassembler.MAX_GROUPS) {
        const oldest = this._groups.keys().next().value
        if (oldest !== undefined) this._groups.delete(oldest)
      }
      grp = { n: p.n, parts: new Array(p.n).fill(''), got: 0 }
      this._groups.set(p.g, grp)
    }
    if (p.i < grp.parts.length && grp.parts[p.i] === '' && grp.got < grp.n) {
      grp.parts[p.i] = p.d
      grp.got++
    }
    if (grp.got < grp.n) return null
    this._groups.delete(p.g)
    return grp.parts.join('')
  }
}

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
      framedSend(this._ch, data)
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
  private _reasm = new ChunkReassembler()

  constructor(private _ch: DataChannelLike, private _deps: DataChannelPeerDeps) {
    this._sock = new DataChannelSocket(_ch)
    _ch.onMessage((data) => {
      const full = this._reasm.push(data)
      if (full === null) return
      void this._onMessage(full)
    })
    _ch.onClose(() => this._sock.closed())
  }

  get authed(): boolean {
    return this._authed
  }

  private _send(obj: unknown): void {
    try {
      framedSend(this._ch, JSON.stringify(obj))
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
