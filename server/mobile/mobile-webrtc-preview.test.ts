import { describe, expect, it } from 'vitest'
import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { MobileWebrtcGateway } from './mobile-webrtc-peer'
import { PreviewChannelClient } from './mobile-preview-channel'

// End-to-end over two real werift peers on loopback: the Desktop gateway
// (offerer) pairs a fake companion (answerer), then opens an extra preview
// channel on the established connection — no SDP renegotiation — and streams
// a fragmented binary frame plus JSON control.

function waitFor<T>(probe: () => T | undefined | null, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = probe()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('MobileWebrtcGateway preview channels', () => {
  it('opens a preview channel on the paired peer and delivers binary fragments', async () => {
    const gateway = new MobileWebrtcGateway({
      registerDevice: async () => ({ ok: true, deviceId: 'dev-1', token: 'tok', hubName: 'Mac', hubInstanceId: 'inst' }),
      rpcDispatch: async () => ({ status: 200, json: {} }),
      bridge: { attach: () => { /* push fan-out not under test */ } },
    })
    const companion = new RTCPeerConnection({ iceServers: [] })
    const channels: RTCDataChannel[] = []
    companion.onDataChannel.subscribe((dc) => channels.push(dc))
    try {
      expect(gateway.openChannel('dev-1', 'preview:early')).toBeNull()

      const { sdp } = await gateway.createOffer('secret')
      await companion.setRemoteDescription({ type: 'offer', sdp })
      await companion.setLocalDescription(await companion.createAnswer())
      await waitFor(() => companion.iceGatheringState === 'complete' || undefined)
      expect((await gateway.acceptAnswer(companion.localDescription!.sdp)).ok).toBe(true)

      const mobile = await waitFor(() => channels.find((dc) => dc.label === 'mobile' && dc.readyState === 'open'))
      const welcome = new Promise<string>((resolve) => mobile.onMessage.subscribe((d) => resolve(String(d))))
      mobile.send(JSON.stringify({ type: 'hello', sec: 'secret', deviceName: 'Phone', platform: 'ios' }))
      expect(JSON.parse(await welcome).type).toBe('welcome')

      const channel = await waitFor(() => gateway.openChannel('dev-1', 'preview:s1'))
      expect(gateway.openChannel('someone-else', 'preview:s1')).toBeNull()
      const opened = new Promise<void>((resolve) => channel.onOpen(resolve))
      const remote = await waitFor(() => channels.find((dc) => dc.label === 'preview:s1'))
      const received: Array<string | Buffer> = []
      remote.onMessage.subscribe((d) => received.push(d))
      await opened

      const frame = Buffer.alloc(50_000)
      for (let i = 0; i < frame.length; i++) frame[i] = i % 256
      const client = new PreviewChannelClient(channel)
      client.send('{"type":"ready"}')
      client.send(frame)

      await waitFor(() => received.length >= 5 || undefined)
      expect(received[0]).toBe('{"type":"ready"}')
      const chunks = received.slice(1) as Buffer[]
      expect(chunks.every(Buffer.isBuffer)).toBe(true)
      const count = chunks[0].readUInt16BE(6)
      expect(chunks).toHaveLength(count)
      expect(Buffer.concat(chunks.map((c) => c.subarray(8))).equals(frame)).toBe(true)
    } finally {
      gateway.stop()
      await companion.close()
    }
  }, 30_000)
})
