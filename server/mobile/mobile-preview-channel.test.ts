import { describe, expect, it } from 'vitest'
import {
  PREVIEW_CHUNK_HEADER_BYTES,
  PREVIEW_MAX_MESSAGE_BYTES,
  PreviewChannelClient,
  PreviewInboundLimiter,
  encodeFrameChunks,
  parsePreviewInbound,
  type PreviewChannelLike,
} from './mobile-preview-channel'

function decode(chunks: Buffer[]) {
  return chunks.map((chunk) => ({
    seq: chunk.readUInt32BE(0), index: chunk.readUInt16BE(4), count: chunk.readUInt16BE(6),
    payload: chunk.subarray(PREVIEW_CHUNK_HEADER_BYTES),
  }))
}

function fakeChannel(state = 'open'): PreviewChannelLike & { sent: Array<string | Buffer>; closed: boolean; bufferedAmount: number } {
  return {
    label: 'preview:s1', readyState: state, bufferedAmount: 0, sent: [], closed: false,
    send(data) { this.sent.push(data) },
    close() { this.closed = true },
    onOpen() { /* noop */ }, onMessage() { /* noop */ }, onClose() { /* noop */ },
  }
}

describe('encodeFrameChunks', () => {
  it('keeps every fragment within the message budget and reassembles byte-exact', () => {
    const frame = Buffer.alloc(100_000)
    for (let i = 0; i < frame.length; i++) frame[i] = i % 251
    const chunks = encodeFrameChunks(7, frame)
    expect(chunks.every((chunk) => chunk.length <= PREVIEW_MAX_MESSAGE_BYTES)).toBe(true)
    const parts = decode(chunks)
    expect(parts.map((p) => p.index)).toEqual(parts.map((_, i) => i))
    expect(new Set(parts.map((p) => `${p.seq}/${p.count}`))).toEqual(new Set([`7/${chunks.length}`]))
    expect(Buffer.concat(parts.map((p) => p.payload)).equals(frame)).toBe(true)
  })

  it('handles exact boundaries, empty frames and sequence wrap', () => {
    const payload = PREVIEW_MAX_MESSAGE_BYTES - PREVIEW_CHUNK_HEADER_BYTES
    expect(encodeFrameChunks(1, Buffer.alloc(payload))).toHaveLength(1)
    expect(encodeFrameChunks(1, Buffer.alloc(payload + 1))).toHaveLength(2)
    expect(decode(encodeFrameChunks(1, Buffer.alloc(0)))[0]).toMatchObject({ index: 0, count: 1 })
    expect(decode(encodeFrameChunks(2 ** 32 + 5, Buffer.alloc(1)))[0].seq).toBe(5)
    expect(() => encodeFrameChunks(1, Buffer.alloc(1), 8)).toThrow(RangeError)
  })
})

describe('PreviewChannelClient', () => {
  it('sends control as text and each frame as a complete fragment run with an increasing sequence', () => {
    const channel = fakeChannel()
    const client = new PreviewChannelClient(channel)
    client.send('{"type":"ready"}')
    client.send(Buffer.alloc(40_000, 1))
    client.send(Buffer.alloc(10, 2))
    expect(channel.sent[0]).toBe('{"type":"ready"}')
    const frames = decode(channel.sent.slice(1) as Buffer[])
    expect(frames.filter((f) => f.seq === 0)).toHaveLength(frames[0].count)
    expect(frames.at(-1)).toMatchObject({ seq: 1, index: 0, count: 1 })
  })

  it('maps channel state and buffered amount for the manager’s conflation', () => {
    const channel = fakeChannel('connecting')
    const client = new PreviewChannelClient(channel)
    expect(client.readyState).toBe(3)
    channel.bufferedAmount = 2_000_000
    expect(client.bufferedAmount).toBe(2_000_000)
  })

  it('tells the viewer why it closed, then closes the channel', () => {
    const channel = fakeChannel()
    new PreviewChannelClient(channel).close(1000, 'session_closed')
    expect(JSON.parse(channel.sent[0] as string)).toEqual({ type: 'closed', reason: 'session_closed' })
    expect(channel.closed).toBe(true)
  })
})

describe('parsePreviewInbound', () => {
  it('accepts well-formed input and navigation', () => {
    expect(parsePreviewInbound(JSON.stringify({ type: 'input', event: { type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 } })))
      .toEqual({ type: 'input', event: { type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 } })
    expect(parsePreviewInbound(JSON.stringify({ type: 'input', event: { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 99999 } })))
      .toMatchObject({ event: { deltaY: 10000 } })
    expect(parsePreviewInbound(JSON.stringify({ type: 'input', event: { type: 'key', action: 'down', key: 'a', text: 'a' } })))
      .toMatchObject({ event: { type: 'key', key: 'a', text: 'a' } })
    expect(parsePreviewInbound(JSON.stringify({ type: 'input', event: { type: 'resize', width: 390, height: 844, deviceScaleFactor: 3 } })))
      .toMatchObject({ event: { type: 'resize', width: 390 } })
    expect(parsePreviewInbound(JSON.stringify({ type: 'navigate', action: 'back' }))).toEqual({ type: 'navigate', action: 'back' })
    expect(parsePreviewInbound(JSON.stringify({ type: 'navigate', url: 'http://localhost:5173/x' }))).toEqual({ type: 'navigate', action: 'goto', url: 'http://localhost:5173/x' })
  })

  it.each([
    'not json',
    '{"type":"capture"}',
    '{"type":"input","event":{"type":"mouse","action":"down","x":-1,"y":0}}',
    '{"type":"input","event":{"type":"mouse","action":"drag","x":1,"y":0}}',
    '{"type":"input","event":{"type":"key","action":"down","key":""}}',
    '{"type":"input","event":{"type":"resize","width":0,"height":10}}',
    '{"type":"navigate","action":"goto"}',
    '{"type":"navigate","action":"eval"}',
  ])('drops malformed %s', (text) => {
    expect(parsePreviewInbound(text)).toBeNull()
  })

  it('drops oversized messages', () => {
    expect(parsePreviewInbound(JSON.stringify({ type: 'navigate', url: `http://localhost:1/${'x'.repeat(70_000)}` }))).toBeNull()
  })
})

describe('PreviewInboundLimiter', () => {
  it('caps messages per minute and resets on the next window', () => {
    let now = 0
    const limiter = new PreviewInboundLimiter(() => now, 3)
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false])
    now = 60_000
    expect(limiter.take()).toBe(true)
  })
})
