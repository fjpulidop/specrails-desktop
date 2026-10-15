import type { BrowserInputEvent } from '../modules/browser/runtime/browser-capture-types'

// Companion app preview: one WebRTC DataChannel per browser session, labelled
// `preview:<sessionId>`, opened by Desktop on the device's EXISTING peer (a new
// channel on an established SCTP association needs no SDP renegotiation). It is
// separate from the `mobile` RPC channel so JPEG frames never queue ahead of RPC.
//
// Wire format (Desktop → Companion):
//   - text:   JSON control (`ready`, `nav`, `popup`, `closed`) — always small.
//   - binary: screencast frame fragments, each `u32 frameSeq | u16 index |
//             u16 count` (big-endian) + payload. A frame renders only once all
//             of its fragments arrived; a newer `frameSeq` discards an older
//             incomplete one.
// Wire format (Companion → Desktop): JSON text `{type:'input', event}` and
// `{type:'navigate', action, url?}`.

export const PREVIEW_CHANNEL_PREFIX = 'preview:'
export const PREVIEW_CHUNK_HEADER_BYTES = 8
/** Same per-message budget the `mobile` channel's text chunking proved safe
 *  across werift, libwebrtc (native companion) and browsers (web companion). */
export const PREVIEW_MAX_MESSAGE_BYTES = 16000
const MAX_CHUNKS = 0xffff
const WS_OPEN = 1
const WS_CLOSED = 3
/** Mirrors the PTY-tuned cap of `/ws/browser/:id` (BUG-MOBILE-07). */
export const PREVIEW_INBOUND_MAX_PER_MINUTE = 6000
export const PREVIEW_INBOUND_MAX_BYTES = 64 * 1024

/** Minimal structural view of a werift DataChannel used for previews. */
export interface PreviewChannelLike {
  readonly label: string
  readonly readyState: string // 'connecting' | 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number
  send(data: string | Buffer): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: string | Buffer) => void): void
  onClose(cb: () => void): void
}

/** Split one JPEG frame into header-prefixed binary fragments. */
export function encodeFrameChunks(frameSeq: number, frame: Buffer, maxMessageBytes = PREVIEW_MAX_MESSAGE_BYTES): Buffer[] {
  const payload = maxMessageBytes - PREVIEW_CHUNK_HEADER_BYTES
  if (payload <= 0) throw new RangeError('maxMessageBytes too small')
  const count = Math.max(1, Math.ceil(frame.length / payload))
  if (count > MAX_CHUNKS) throw new RangeError('frame too large')
  const seq = frameSeq >>> 0
  const chunks: Buffer[] = []
  for (let index = 0; index < count; index++) {
    const part = frame.subarray(index * payload, (index + 1) * payload)
    const chunk = Buffer.allocUnsafe(PREVIEW_CHUNK_HEADER_BYTES + part.length)
    chunk.writeUInt32BE(seq, 0)
    chunk.writeUInt16BE(index, 4)
    chunk.writeUInt16BE(count, 6)
    part.copy(chunk, PREVIEW_CHUNK_HEADER_BYTES)
    chunks.push(chunk)
  }
  return chunks
}

/**
 * Presents a preview DataChannel to `BrowserCaptureManager` as a
 * `BrowserWsClient`, so attach/detach, popup state and the newest-wins
 * screencast fan-out (which checks `bufferedAmount` BEFORE handing over a
 * frame) are reused unchanged. A frame is always sent whole: conflation runs
 * per frame, never per fragment, so a partial frame never goes out.
 */
export class PreviewChannelClient {
  private frameSeq = 0
  constructor(private readonly channel: PreviewChannelLike) {}

  get readyState(): number {
    return this.channel.readyState === 'open' ? WS_OPEN : WS_CLOSED
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount
  }

  send(data: string | Buffer): void {
    if (typeof data === 'string') {
      this.channel.send(data)
      return
    }
    const seq = this.frameSeq
    this.frameSeq = (this.frameSeq + 1) >>> 0
    for (const chunk of encodeFrameChunks(seq, data)) this.channel.send(chunk)
  }

  close(_code?: number, reason?: string): void {
    try {
      if (this.channel.readyState === 'open') this.channel.send(JSON.stringify({ type: 'closed', reason: reason ?? 'session_closed' }))
    } catch { /* the channel is already going away */ }
    try { this.channel.close() } catch { /* ignore */ }
  }
}

export type PreviewInbound =
  | { type: 'input'; event: BrowserInputEvent }
  | { type: 'navigate'; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const modifiers = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 15 ? value as number : undefined
const BUTTONS = new Set(['left', 'middle', 'right'])

function parseEvent(raw: unknown): BrowserInputEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  switch (e.type) {
    case 'mouse': {
      if (!['move', 'down', 'up'].includes(e.action as string) || !finite(e.x) || !finite(e.y) || e.x < 0 || e.y < 0) return null
      const button = typeof e.button === 'string' && BUTTONS.has(e.button) ? e.button as 'left' | 'middle' | 'right' : undefined
      const clickCount = Number.isInteger(e.clickCount) && (e.clickCount as number) >= 1 && (e.clickCount as number) <= 3 ? e.clickCount as number : undefined
      return { type: 'mouse', action: e.action as 'move' | 'down' | 'up', x: e.x, y: e.y, ...(button ? { button } : {}), ...(clickCount ? { clickCount } : {}), ...(modifiers(e.modifiers) !== undefined ? { modifiers: modifiers(e.modifiers) } : {}) }
    }
    case 'wheel': {
      if (!finite(e.x) || !finite(e.y) || !finite(e.deltaX) || !finite(e.deltaY) || e.x < 0 || e.y < 0) return null
      const clamp = (v: number) => Math.max(-10_000, Math.min(10_000, v))
      return { type: 'wheel', x: e.x, y: e.y, deltaX: clamp(e.deltaX), deltaY: clamp(e.deltaY), ...(modifiers(e.modifiers) !== undefined ? { modifiers: modifiers(e.modifiers) } : {}) }
    }
    case 'key': {
      if (!['down', 'up'].includes(e.action as string) || typeof e.key !== 'string' || e.key.length === 0 || e.key.length > 32) return null
      const code = typeof e.code === 'string' && e.code.length <= 32 ? e.code : undefined
      const text = typeof e.text === 'string' && e.text.length <= 8 ? e.text : undefined
      return { type: 'key', action: e.action as 'down' | 'up', key: e.key, ...(code ? { code } : {}), ...(text !== undefined ? { text } : {}), ...(modifiers(e.modifiers) !== undefined ? { modifiers: modifiers(e.modifiers) } : {}) }
    }
    case 'resize': {
      if (!finite(e.width) || !finite(e.height) || e.width <= 0 || e.height <= 0) return null
      return { type: 'resize', width: e.width, height: e.height, ...(finite(e.deviceScaleFactor) ? { deviceScaleFactor: e.deviceScaleFactor } : {}) }
    }
    default:
      return null
  }
}

/** Validate one inbound control message; anything malformed is dropped. */
export function parsePreviewInbound(text: string): PreviewInbound | null {
  if (text.length > PREVIEW_INBOUND_MAX_BYTES) return null
  let msg: Record<string, unknown>
  try { msg = JSON.parse(text) as Record<string, unknown> } catch { return null }
  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'input') {
    const event = parseEvent(msg.event)
    return event ? { type: 'input', event } : null
  }
  if (msg.type === 'navigate') {
    const action = msg.action ?? 'goto'
    if (!['goto', 'back', 'forward', 'reload'].includes(action as string)) return null
    if (action === 'goto' && (typeof msg.url !== 'string' || msg.url.length > 2048)) return null
    return { type: 'navigate', action: action as 'goto' | 'back' | 'forward' | 'reload', ...(action === 'goto' ? { url: msg.url as string } : {}) }
  }
  return null
}

/** Sliding one-minute message budget for one channel. */
export class PreviewInboundLimiter {
  private windowStart = 0
  private count = 0
  constructor(private readonly now: () => number = Date.now, private readonly maxPerMinute = PREVIEW_INBOUND_MAX_PER_MINUTE) {}

  take(): boolean {
    const at = this.now()
    if (at - this.windowStart >= 60_000) { this.windowStart = at; this.count = 0 }
    if (this.count >= this.maxPerMinute) return false
    this.count += 1
    return true
  }
}
