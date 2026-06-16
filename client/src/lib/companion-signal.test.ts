import { describe, it, expect } from 'vitest'
import { encodeSignal, decodeSignal, encodeOffer, decodeAnswer } from './companion-signal'

describe('companion-signal codec', () => {
  it('round-trips text through deflate-raw + base64url', async () => {
    for (const s of ['', 'hi', '{"a":1}', 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n'.repeat(30)]) {
      expect(await decodeSignal(await encodeSignal(s))).toBe(s)
    }
  })

  it('compresses a realistic SDP (tag D, smaller token)', async () => {
    const sdp = 'a=candidate:1 1 udp 2122260223 192.168.1.50 54321 typ host\r\n'.repeat(20)
    const token = await encodeSignal(sdp)
    expect(token[0]).toBe('D')
    expect(token.length).toBeLessThan(sdp.length)
  })

  it('encodeOffer produces an offer the phone can read back', async () => {
    const token = await encodeOffer({ hubInstanceId: 'inst-1', hubName: 'Mac', sdp: 'v=0\r\nSDP', secret: 'sec' })
    const m = JSON.parse(await decodeSignal(token))
    expect(m).toMatchObject({ k: 'offer', v: 2, hub: 'inst-1', name: 'Mac', sdp: 'v=0\r\nSDP', sec: 'sec' })
  })

  it('decodeAnswer parses an answer token and rejects non-answers', async () => {
    const answer = await encodeSignal(JSON.stringify({ k: 'answer', v: 2, sdp: 'ANS', dev: 'iPhone', plat: 'web', sec: 's' }))
    expect(await decodeAnswer(answer)).toEqual({ sdp: 'ANS', deviceName: 'iPhone', platform: 'web', secret: 's' })

    const offer = await encodeOffer({ hubInstanceId: 'h', hubName: 'n', sdp: 's', secret: 'x' })
    expect(await decodeAnswer(offer)).toBeNull()
    expect(await decodeAnswer('garbage')).toBeNull()
  })
})
