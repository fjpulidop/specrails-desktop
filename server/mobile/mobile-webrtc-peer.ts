import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { safeEqual } from '../auth'
import { DataChannelPeer, type DataChannelLike, type DataChannelPeerDeps, type WelcomeResult } from './mobile-datachannel'
import type { PreviewChannelLike } from './mobile-preview-channel'

// werift runtime glue: the desktop is the WebRTC *offerer*. It creates a peer +
// DataChannel, emits an offer SDP (for the first QR), then applies the scanned
// answer SDP. The protocol on top of the channel is handled by DataChannelPeer
// (unit-tested); this file is the thin, runtime-only wiring around werift.

export interface MobileWebrtcGatewayDeps {
  /** Creates (or, with a known token, re-uses) the device. `requireExistingToken`
   *  is forwarded for the reconnect path: when set, only an already-paired,
   *  non-revoked device token may re-register (no mint). See BUG-AUTH-01. */
  registerDevice: (input: {
    deviceName: string
    platform: string
    token?: string
    requireExistingToken?: boolean
  }) => Promise<WelcomeResult | { ok: false }>
  rpcDispatch: DataChannelPeerDeps['rpcDispatch']
  bridge: DataChannelPeerDeps['bridge']
}

interface PendingOffer {
  pc: RTCPeerConnection
  secret: string
}

/** Default slot for the QR-pairing flow (a single un-keyed offer at a time). */
const QR_KEY = '__qr__'

export class MobileWebrtcGateway {
  // Pending (un-answered) offers keyed by room/device id. A single slot would be
  // CLOBBERED when multiple devices reconnect in one poll cycle: device B's
  // createOffer closed device A's still-open offer, and acceptAnswer applied A's
  // answer to whatever happened to be pending. Per-room keying isolates them.
  private _pending = new Map<string, PendingOffer>()
  private _active = new Set<RTCPeerConnection>()
  /** The live peer of each authenticated device (latest wins), so Desktop can
   *  open extra DataChannels (app preview) on the connection it already has. */
  private _byDevice = new Map<string, RTCPeerConnection>()

  constructor(private _deps: MobileWebrtcGatewayDeps) {}

  /** Drop the open (un-answered) offer for one room (default = QR slot). */
  clearOffer(key: string = QR_KEY): void {
    const p = this._pending.get(key)
    if (p) {
      this._pending.delete(key)
      this._close(p.pc)
    }
  }

  /** Create a fresh pairing offer (peer + DataChannel + gathered offer SDP).
   *  Replaces any previously-open offer FOR THE SAME ROOM. Returns the SDP to
   *  embed in the QR / post to the room's mailbox.
   *
   *  The QR slot (default key) is FIRST-TIME pairing: the secret rides the QR the
   *  desktop user scans, and a successful secret check mints a new device.
   *  A per-room key (reconnect, key !== QR_KEY) goes through a PUBLIC mailbox, so
   *  the secret is NOT the credential there — the companion MUST present its
   *  existing device token (`requireExistingToken`). This blocks a mailbox reader
   *  from minting a device with the broadcast secret alone (BUG-AUTH-01). */
  async createOffer(secret: string, key: string = QR_KEY): Promise<{ sdp: string }> {
    this.clearOffer(key)
    const isReconnect = key !== QR_KEY
    const pc = new RTCPeerConnection({ iceServers: [] })
    const dc = pc.createDataChannel('mobile')

    // The companion peer activates when the channel opens.
    //  - QR pairing: validate `hello.sec` against THIS connection's offer secret
    //    (captured in this closure) — not a global pending secret, which is
    //    already null by the time hello arrives. A pass may mint a device.
    //  - Reconnect: the secret is NOT trusted (it travelled a public mailbox);
    //    require a valid existing device token instead, and never mint.
    new DataChannelPeer(toChannelLike(dc), {
      registerDevice: async (input) => {
        let result: WelcomeResult | { ok: false }
        if (isReconnect) {
          result = await this._deps.registerDevice({
            deviceName: input.deviceName,
            platform: input.platform,
            token: input.token,
            requireExistingToken: true,
          })
        } else {
          result = input.secret && safeEqual(input.secret, secret)
            ? await this._deps.registerDevice({ deviceName: input.deviceName, platform: input.platform, token: input.token })
            : { ok: false }
        }
        if (result.ok) this._byDevice.set(result.deviceId, pc)
        return result
      },
      rpcDispatch: this._deps.rpcDispatch,
      bridge: this._deps.bridge,
    })

    pc.connectionStateChange.subscribe((s) => {
      console.log('[webrtc] pc connectionState:', s)
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this._active.delete(pc)
        for (const [deviceId, owned] of this._byDevice) if (owned === pc) this._byDevice.delete(deviceId)
        // Drop this pc from whichever room slot still holds it.
        if (this._pending.get(key)?.pc === pc) this._pending.delete(key)
      }
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitIceComplete(pc)
    const sdp = pc.localDescription?.sdp
    if (!sdp) {
      this._close(pc)
      throw new Error('no local description after ICE gathering')
    }
    console.log(`[webrtc] offer ready: ${(sdp.match(/a=candidate/g) ?? []).length} ICE candidates`)
    this._pending.set(key, { pc, secret })
    return { sdp }
  }

  /** Apply the companion's scanned answer SDP to the open offer FOR THE SAME ROOM
   *  and keep the connection alive for the session. */
  async acceptAnswer(sdp: string, key: string = QR_KEY): Promise<{ ok: boolean }> {
    const p = this._pending.get(key)
    if (!p) return { ok: false }
    try {
      console.log(`[webrtc] applying answer: ${(sdp.match(/a=candidate/g) ?? []).length} ICE candidates`)
      await p.pc.setRemoteDescription({ type: 'answer', sdp })
      this._active.add(p.pc)
      this._pending.delete(key)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  /** Open an ordered, reliable DataChannel on the device's live peer (no SDP
   *  renegotiation: the SCTP association already exists). Null when the
   *  device has no connected WebRTC peer. */
  openChannel(deviceId: string, label: string): PreviewChannelLike | null {
    const pc = this._byDevice.get(deviceId)
    if (!pc || pc.connectionState !== 'connected') return null
    try {
      return toPreviewChannel(pc.createDataChannel(label, { ordered: true }))
    } catch {
      return null
    }
  }

  /** Forget a device's peer (revoked). Its channels close with the peer. */
  forgetDevice(deviceId: string): void {
    this._byDevice.delete(deviceId)
  }

  /** Tear down every peer (gateway stopping / disabled). */
  stop(): void {
    for (const key of [...this._pending.keys()]) this.clearOffer(key)
    for (const pc of this._active) this._close(pc)
    this._active.clear()
    this._byDevice.clear()
  }

  private _close(pc: RTCPeerConnection): void {
    try {
      void pc.close()
    } catch {
      /* ignore */
    }
  }
}

function toChannelLike(dc: RTCDataChannel): DataChannelLike {
  dc.stateChanged.subscribe((s) => console.log('[webrtc] datachannel state:', s))
  return {
    get readyState() {
      return dc.readyState
    },
    send: (data) => dc.send(data),
    onMessage: (cb) => {
      dc.onMessage.subscribe((d) => cb(typeof d === 'string' ? d : d.toString('utf8')))
    },
    onClose: (cb) => {
      dc.stateChanged.subscribe((s) => {
        if (s === 'closed') cb()
      })
    },
  }
}

function toPreviewChannel(dc: RTCDataChannel): PreviewChannelLike {
  return {
    get label() { return dc.label },
    get readyState() { return dc.readyState },
    get bufferedAmount() { return dc.bufferedAmount },
    send: (data) => dc.send(data),
    close: () => dc.close(),
    onOpen: (cb) => {
      if (dc.readyState === 'open') queueMicrotask(cb)
      else dc.stateChanged.subscribe((s) => { if (s === 'open') cb() })
    },
    onMessage: (cb) => { dc.onMessage.subscribe((d) => cb(d)) },
    onClose: (cb) => { dc.stateChanged.subscribe((s) => { if (s === 'closed') cb() }) },
  }
}

/** Vanilla ICE: resolve once gathering completes so the offer SDP carries all
 *  candidates (there's no trickle channel — the SDP travels by QR). */
function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    pc.iceGatheringStateChange.subscribe((s) => {
      if (s === 'complete') finish()
    })
    const t = setTimeout(finish, 3000)
    t.unref?.()
  })
}
