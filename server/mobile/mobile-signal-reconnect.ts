// Outbound reconnect poller for the serverless web companion.
//
// After a page reload the companion's WebRTC link is gone. To re-establish it
// without re-scanning a QR, the companion drops a "reconnect request" into a
// tiny public mailbox (companion-signal.php on specrails.dev); the desktop polls
// that mailbox (OUTBOUND — no inbound needed, no cert wall), answers with a
// fresh offer, and reads back the companion's answer. The mailbox only ever
// carries the ~5s SDP handshake; once connected, all traffic is P2P. The desktop
// authenticates the reconnecting device by its EXISTING token (see
// buildRegisterDevice + MobileWebrtcGateway reconnect path), so no new
// pairing/device is created.
//
// BUG-AUTH-01: the offer's single-use pairing secret is NOT published to the
// mailbox on reconnect. Reconnect auth is the device's existing token, not the
// secret; broadcasting the secret in cleartext would let a mailbox reader / MITM
// answer the offer. The secret is retained only for the QR (first-pairing) path,
// which never goes through this mailbox.

export interface SignalFetchResult {
  status: number
  text: () => Promise<string>
}

export interface SignalReconnectDeps {
  /** e.g. https://specrails.dev/companion-signal.php */
  signalBase: string
  doFetch: (url: string, init?: { method?: string; body?: string }) => Promise<SignalFetchResult>
  /** Active (non-revoked) device ids — each is a mailbox "room". */
  rooms: () => string[]
  /** Create a fresh offer + its single-use secret (and the desktop identity) for
   *  a specific room, so concurrent rooms don't clobber each other's offers. */
  makeOffer: (room: string) => Promise<{ sdp: string; secret: string; hubName: string; hubInstanceId: string } | null>
  /** Apply the companion's answer SDP to that room's open offer. */
  acceptAnswer: (room: string, sdp: string) => Promise<boolean>
}

export class MobileSignalReconnect {
  private _timer: ReturnType<typeof setInterval> | null = null
  private _busy = false

  constructor(private _deps: SignalReconnectDeps) {}

  start(intervalMs = 3000): void {
    if (this._timer) return
    this._timer = setInterval(() => void this.poll(), intervalMs)
    this._timer.unref?.()
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /** One poll cycle across all rooms. Exposed for tests. */
  async poll(): Promise<void> {
    if (this._busy) return // never overlap cycles (a slow makeOffer must not stack)
    this._busy = true
    try {
      for (const room of this._deps.rooms()) {
        try {
          // A phone asking to reconnect? → answer with a fresh offer.
          const req = await this._get(room, 'req')
          if (req !== null) {
            const offer = await this._deps.makeOffer(room)
            if (offer) {
              // BUG-AUTH-01: never publish `offer.secret` to the public mailbox.
              // The reconnecting companion authenticates with its existing device
              // token; the secret would only help an eavesdropper.
              await this._post(
                room,
                'offer',
                JSON.stringify({ sdp: offer.sdp, hub: offer.hubInstanceId, name: offer.hubName }),
              )
            }
          }
          // A phone's answer waiting? → complete the connection.
          const ans = await this._get(room, 'answer')
          if (ans) {
            try {
              const parsed = JSON.parse(ans) as { sdp?: unknown }
              if (typeof parsed.sdp === 'string') await this._deps.acceptAnswer(room, parsed.sdp)
            } catch {
              /* malformed answer — ignore */
            }
          }
        } catch {
          /* transient per-room network error — retry next cycle */
        }
      }
    } finally {
      this._busy = false
    }
  }

  private async _get(room: string, slot: string): Promise<string | null> {
    const res = await this._deps.doFetch(`${this._deps.signalBase}?room=${encodeURIComponent(room)}&slot=${slot}`)
    if (res.status !== 200) return null
    return res.text()
  }

  private async _post(room: string, slot: string, body: string): Promise<void> {
    await this._deps.doFetch(`${this._deps.signalBase}?room=${encodeURIComponent(room)}&slot=${slot}`, {
      method: 'POST',
      body,
    })
  }
}
