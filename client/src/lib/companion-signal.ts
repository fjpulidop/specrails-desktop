// Browser-side signaling codec for the serverless WebRTC web companion.
// Byte-compatible with the Flutter companion's SignalCodec
// (specrails-companion/lib/core/signaling.dart): a 1-char codec tag
// (`D` = raw DEFLATE / `R` = raw UTF-8) + unpadded base64url. Raw DEFLATE here is
// `CompressionStream('deflate-raw')`, which produces/consumes the same RFC-1951
// stream as Dart's `archive` Deflate/Inflate — so an offer encoded here decodes
// on the phone, and the phone's answer decodes here.

function b64uEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(token: string): Uint8Array {
  const pad = token.length % 4
  const s = (token + (pad ? '='.repeat(4 - pad) : '')).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pipe(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  // Drive the (de)compression stream directly — avoids Blob.stream()/Response,
  // which jsdom (the test env) doesn't fully implement.
  const writer = transform.writable.getWriter()
  void writer.write(bytes as BufferSource)
  void writer.close()
  const reader = (transform.readable as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export async function encodeSignal(text: string): Promise<string> {
  const raw = new TextEncoder().encode(text)
  const deflated = await pipe(raw, new CompressionStream('deflate-raw'))
  return deflated.length < raw.length ? 'D' + b64uEncode(deflated) : 'R' + b64uEncode(raw)
}

export async function decodeSignal(token: string): Promise<string> {
  const t = token.trim()
  if (!t) throw new Error('empty signal token')
  const body = b64uDecode(t.slice(1))
  if (t[0] === 'D') return new TextDecoder().decode(await pipe(body, new DecompressionStream('deflate-raw')))
  if (t[0] === 'R') return new TextDecoder().decode(body)
  throw new Error(`unknown signal codec tag: ${t[0]}`)
}

export interface OfferInput {
  hubInstanceId: string
  hubName: string
  sdp: string
  secret: string
}

/** Encode the desktop's offer into the token rendered as the first QR. */
export async function encodeOffer(o: OfferInput): Promise<string> {
  return encodeSignal(JSON.stringify({ k: 'offer', v: 2, hub: o.hubInstanceId, name: o.hubName, sdp: o.sdp, sec: o.secret }))
}

export interface AnswerParsed {
  sdp: string
  deviceName: string
  platform: string
  secret: string
}

/** Decode the companion's scanned answer QR. Returns null if it isn't one. */
export async function decodeAnswer(token: string): Promise<AnswerParsed | null> {
  try {
    const m = JSON.parse(await decodeSignal(token.trim())) as Record<string, unknown>
    if (m.k !== 'answer' || typeof m.sdp !== 'string') return null
    return {
      sdp: m.sdp,
      deviceName: typeof m.dev === 'string' ? m.dev : 'Mobile device',
      platform: typeof m.plat === 'string' ? m.plat : 'web',
      secret: typeof m.sec === 'string' ? m.sec : '',
    }
  } catch {
    return null
  }
}
