import { EventEmitter } from 'events'
import type { WsMessage } from '../types'

// In-process fan-out of every WS broadcast to the Mobile Gateway.
//
// The plan originally had the gateway hold a client WebSocket to
// ws://127.0.0.1:4200. But the gateway runs in the SAME process, so a loopback
// socket would be pure overhead AND force the bridge to JSON.parse the whole
// firehose (a gap the critic flagged). Instead the main `broadcast()` emits each
// already-structured WsMessage here; the gateway's WS bridge subscribes and does
// per-subscription filtering + redaction on plain objects. REST still forwards
// via a real loopback HTTP request (so it re-enters requireAuth and never hits
// the SPA catch-all) — only the WS path uses this bus.

export class MobileEventBus extends EventEmitter {
  /** Emit a broadcast copy to any subscribed gateway sockets. Never throws into
   *  the caller (the main broadcast loop must not be perturbed by a mobile bug). */
  publish(msg: WsMessage): void {
    try {
      this.emit('message', msg)
    } catch {
      /* swallow — a misbehaving mobile listener must not break the main bus */
    }
  }

  onMessage(cb: (msg: WsMessage) => void): () => void {
    this.on('message', cb)
    return () => this.off('message', cb)
  }
}

// EventEmitter defaults to 10 listeners; the gateway attaches one shared listener
// that fans out to many sockets, so the default is plenty — but lift it anyway
// to be safe against future multi-listener designs.
const bus = new MobileEventBus()
bus.setMaxListeners(64)

/** Process-wide singleton bus. */
export function getMobileEventBus(): MobileEventBus {
  return bus
}
