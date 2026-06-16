import { describe, it, expect, vi } from 'vitest'
import { DataChannelPeer, type DataChannelLike, type WelcomeResult } from './mobile-datachannel'
import { MobileWsBridge } from './mobile-ws'
import type { WsMessage } from '../types'

const flush = () => new Promise<void>((r) => setImmediate(r))

class FakeChannel implements DataChannelLike {
  readyState = 'open'
  sent: string[] = []
  private _msg?: (d: string) => void
  private _close?: () => void

  send(d: string): void {
    this.sent.push(d)
  }
  onMessage(cb: (d: string) => void): void {
    this._msg = cb
  }
  onClose(cb: () => void): void {
    this._close = cb
  }

  recv(obj: unknown): void {
    this._msg?.(JSON.stringify(obj))
  }
  drop(): void {
    this._close?.()
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

function deps(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  return makeDeps(over)
}

function makeDeps(over: {
  registerOk?: boolean
  rpc?: (i: { method: string; path: string; body?: unknown; token: string }) => Promise<{ status: number; json: unknown }>
} = {}) {
  const welcome: WelcomeResult = { ok: true, deviceId: 'dev-1', token: 'tok-1', hubName: 'Mac', hubInstanceId: 'inst-1' }
  const attach = vi.fn()
  const registerDevice = vi.fn(async (i: { secret: string; deviceName: string; platform: string }) =>
    i.secret === 'good' && over.registerOk !== false ? welcome : { ok: false as const },
  )
  const rpcDispatch = vi.fn(
    over.rpc ?? (async () => ({ status: 200, json: { ok: true } })),
  )
  return { bridge: { attach }, registerDevice, rpcDispatch, attach }
}

describe('DataChannelPeer', () => {
  it('a valid hello registers the device, sends welcome, and attaches to the bridge', async () => {
    const ch = new FakeChannel()
    const d = deps()
    new DataChannelPeer(ch, d)
    ch.recv({ type: 'hello', sec: 'good', deviceName: 'iPhone', platform: 'web' })
    await flush()

    const welcome = ch.json().find((f) => f.type === 'welcome')
    expect(welcome).toMatchObject({ deviceId: 'dev-1', token: 'tok-1', hubName: 'Mac', hubInstanceId: 'inst-1' })
    expect(d.attach).toHaveBeenCalledWith(expect.anything(), 'dev-1')
  })

  it('a wrong-secret hello is denied and does not attach', async () => {
    const ch = new FakeChannel()
    const d = deps()
    new DataChannelPeer(ch, d)
    ch.recv({ type: 'hello', sec: 'nope', deviceName: 'x', platform: 'web' })
    await flush()

    expect(ch.json().some((f) => f.type === 'pair_denied')).toBe(true)
    expect(d.attach).not.toHaveBeenCalled()
  })

  it('rejects rpc before pairing with 401', async () => {
    const ch = new FakeChannel()
    new DataChannelPeer(ch, deps())
    ch.recv({ type: 'rpc', id: 'r0', method: 'GET', path: '/v1/projects' })
    await flush()
    const res = ch.json().find((f) => f.type === 'rpc_result')
    expect(res).toMatchObject({ id: 'r0', status: 401 })
  })

  it('dispatches rpc after pairing and echoes the result with its id', async () => {
    const ch = new FakeChannel()
    const rpc = vi.fn(async () => ({ status: 201, json: { created: true } }))
    const d = deps({ rpc })
    new DataChannelPeer(ch, d)
    ch.recv({ type: 'hello', sec: 'good', deviceName: 'iPhone', platform: 'web' })
    await flush()
    ch.recv({ type: 'rpc', id: 'r1', method: 'POST', path: '/v1/projects/p/tickets/from-prompt', body: { prompt: 'hi' } })
    await flush()

    expect(rpc).toHaveBeenCalledWith({ method: 'POST', path: '/v1/projects/p/tickets/from-prompt', body: { prompt: 'hi' }, token: 'tok-1' })
    const res = ch.json().find((f) => f.type === 'rpc_result' && f.id === 'r1')
    expect(res).toMatchObject({ id: 'r1', status: 201, json: { created: true } })
  })

  it('reuses MobileWsBridge: a subscribed push frame reaches the channel (redacted)', async () => {
    const ch = new FakeChannel()
    const bridge = new MobileWsBridge()
    const register = async () => ({ ok: true as const, deviceId: 'dev-1', token: 'tok-1', hubName: 'Mac', hubInstanceId: 'inst-1' })
    new DataChannelPeer(ch, { bridge, registerDevice: register, rpcDispatch: async () => ({ status: 200, json: {} }) })

    ch.recv({ type: 'hello', sec: 'good', deviceName: 'iPhone', platform: 'web' })
    await flush()
    ch.recv({ type: 'subscribe', projects: ['p1'], topics: ['queue'] })
    await flush()

    bridge.dispatch({ type: 'queue', projectId: 'p1', jobs: [], paused: false, activeJobId: null } as unknown as WsMessage)

    expect(ch.json().some((f) => f.type === 'queue' && f.projectId === 'p1')).toBe(true)
  })

  it('drops cleanly when the channel closes', async () => {
    const ch = new FakeChannel()
    const bridge = new MobileWsBridge()
    const register = async () => ({ ok: true as const, deviceId: 'dev-1', token: 'tok-1', hubName: 'Mac', hubInstanceId: 'inst-1' })
    new DataChannelPeer(ch, { bridge, registerDevice: register, rpcDispatch: async () => ({ status: 200, json: {} }) })
    ch.recv({ type: 'hello', sec: 'good', deviceName: 'iPhone', platform: 'web' })
    await flush()
    expect(bridge.socketCount).toBe(1)
    ch.drop()
    expect(bridge.socketCount).toBe(0)
  })
})
