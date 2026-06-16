import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { safeEqual } from '../auth'
import { DataChannelPeer, type DataChannelLike, type DataChannelPeerDeps, type WelcomeResult } from './mobile-datachannel'

// werift runtime glue: the desktop is the WebRTC *offerer*. It creates a peer +
// DataChannel, emits an offer SDP (for the first QR), then applies the scanned
// answer SDP. The protocol on top of the channel is handled by DataChannelPeer
// (unit-tested); this file is the thin, runtime-only wiring around werift.

export interface MobileWebrtcGatewayDeps {
  /** Creates (or, with a known token, re-uses) the device once the per-connection
   *  secret check passes. */
  registerDevice: (input: { deviceName: string; platform: string; token?: string }) => Promise<WelcomeResult>
  rpcDispatch: DataChannelPeerDeps['rpcDispatch']
  bridge: DataChannelPeerDeps['bridge']
}

interface PendingOffer {
  pc: RTCPeerConnection
  secret: string
}

export class MobileWebrtcGateway {
  private _pending: PendingOffer | null = null
  private _active = new Set<RTCPeerConnection>()

  constructor(private _deps: MobileWebrtcGatewayDeps) {}

  /** Drop the open (un-answered) offer. */
  clearOffer(): void {
    const p = this._pending
    this._pending = null
    if (p) this._close(p.pc)
  }

  /** Create a fresh pairing offer (peer + DataChannel + gathered offer SDP).
   *  Replaces any previously-open offer. Returns the SDP to embed in the QR. */
  async createOffer(secret: string): Promise<{ sdp: string }> {
    this.clearOffer()
    const pc = new RTCPeerConnection({ iceServers: [] })
    const dc = pc.createDataChannel('mobile')

    // The companion peer activates when the channel opens. It validates `hello`
    // against THIS connection's offer secret (captured in this closure) — not a
    // global pending secret, which is already null by the time hello arrives.
    new DataChannelPeer(toChannelLike(dc), {
      registerDevice: async (input) =>
        input.secret && safeEqual(input.secret, secret)
          ? this._deps.registerDevice({ deviceName: input.deviceName, platform: input.platform, token: input.token })
          : { ok: false },
      rpcDispatch: this._deps.rpcDispatch,
      bridge: this._deps.bridge,
    })

    pc.connectionStateChange.subscribe((s) => {
      console.log('[webrtc] pc connectionState:', s)
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this._active.delete(pc)
        if (this._pending?.pc === pc) this._pending = null
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
    this._pending = { pc, secret }
    return { sdp }
  }

  /** Apply the companion's scanned answer SDP to the open offer and keep the
   *  connection alive for the session. */
  async acceptAnswer(sdp: string): Promise<{ ok: boolean }> {
    const p = this._pending
    if (!p) return { ok: false }
    try {
      console.log(`[webrtc] applying answer: ${(sdp.match(/a=candidate/g) ?? []).length} ICE candidates`)
      await p.pc.setRemoteDescription({ type: 'answer', sdp })
      this._active.add(p.pc)
      this._pending = null
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  /** Tear down every peer (gateway stopping / disabled). */
  stop(): void {
    this.clearOffer()
    for (const pc of this._active) this._close(pc)
    this._active.clear()
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
