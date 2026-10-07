import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { CoreHostLauncher, type LaunchedHost } from '../adapters/host-process'
import { StdioSessionHostClient } from '../adapters/rpc-client'
import { isSessionRequestError } from '../domain/errors'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('StdioSessionHostClient', () => {
  function pair(options: { timeoutMs?: number } = {}) {
    const stdin = new PassThrough(), stdout = new PassThrough()
    const written: Array<Record<string, unknown>> = []
    stdin.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((line) => written.push(JSON.parse(line))))
    const client = new StdioSessionHostClient({ stdin, stdout }, options)
    const reply = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`)
    return { client, written, reply, stdout }
  }

  it('correlates responses and maps error data to typed errors', async () => {
    const { client, written, reply } = pair()
    const ok = client.request('session.list')
    const bad = client.request('session.snapshot', { sessionId: 'x' })
    await tick()
    reply({ jsonrpc: '2.0', id: written[1]!.id, error: { code: -32000, message: 'Unknown session x', data: { code: 'session_not_found', retryable: false } } })
    reply({ jsonrpc: '2.0', id: written[0]!.id, result: { sessions: [] } })
    await expect(ok).resolves.toEqual({ sessions: [] })
    const error = await bad.catch((caught) => caught)
    expect(isSessionRequestError(error, 'session_not_found')).toBe(true)
    expect(error).toMatchObject({ retryable: false, rpcCode: -32000 })
  })

  it('dispatches events and lag notices, and closes on lease loss', async () => {
    const { client, reply } = pair()
    const events: unknown[] = [], lags: unknown[] = [], closes: string[] = []
    client.onEvent((envelope) => events.push(envelope))
    client.onLagged((sessionId, seq) => lags.push([sessionId, seq]))
    client.onClose((reason) => closes.push(reason))
    const pending = client.request('host.ping').catch((error) => error)
    reply({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's', seq: 3, event: { type: 'session.phase', phase: 'turn', at: 'x' } } })
    reply({ jsonrpc: '2.0', method: 'session.lagged', params: { sessionId: 's', deliveredSeq: 3 } })
    reply('not json at all')
    reply({ jsonrpc: '2.0', method: 'host.leaseLost', params: {} })
    await tick()
    expect(events).toEqual([{ sessionId: 's', seq: 3, event: { type: 'session.phase', phase: 'turn', at: 'x' } }])
    expect(lags).toEqual([['s', 3]])
    expect(closes).toEqual(['Another session host took over this scope'])
    expect(await pending).toMatchObject({ code: 'host_unavailable' })
    await expect(client.request('host.ping')).rejects.toMatchObject({ code: 'host_unavailable' })
    const late: string[] = []
    client.onClose((reason) => late.push(reason))
    expect(late).toHaveLength(1)
  })

  it('times out unanswered requests and closes when the host output ends', async () => {
    const { client, stdout } = pair({ timeoutMs: 20 })
    await expect(client.request('host.ping')).rejects.toMatchObject({ code: 'host_timeout' })
    stdout.end()
    await tick()
    expect(client.closed).toBe(true)
  })
})

describe('CoreHostLauncher against the local Core build', () => {
  const coreCli = path.resolve(__dirname, '../../../../../specrails-core/dist/agent-runtime/cli.js')
  const homes: string[] = []
  const hosts: LaunchedHost[] = []
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const hasSessions = existsSync(coreCli) && existsSync(path.resolve(coreCli, '../session/index.js'))

  it.skipIf(!hasSessions)('launches the host, negotiates the protocol and shuts it down gracefully', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'desktop session host ')); homes.push(home)
    const launcher = new CoreHostLauncher({ cli: () => coreCli, node: () => process.execPath, env: { ...process.env, SPECRAILS_REGISTRY_HOME: home }, host: { name: 'desktop-test', version: '0' } })
    const host = await launcher.launch('desktop-test')
    hosts.push(host)
    expect(host.initialize).toMatchObject({ protocolVersion: 1, scope: 'desktop-test', capabilities: { sessions: 1 } })
    expect(host.initialize.drivers.map((driver) => driver.id)).toEqual(['claude', 'codex', 'gemini', 'kimi'])
    expect(await host.request('session.list')).toEqual({ sessions: [] })
    const invalid = await host.request('session.open', { driver: 'claude' }).catch((error) => error)
    expect(isSessionRequestError(invalid, 'invalid_params')).toBe(true)
    expect(existsSync(path.join(home, '.specrails', 'sessions', 'desktop-test', 'sessions.sqlite'))).toBe(true)
    await host.close()
    expect((host as unknown as { closed: boolean }).closed).toBe(true)
  })

  it('reports a Core without the agent runtime CLI', async () => {
    await expect(new CoreHostLauncher({ cli: () => null }).launch('x')).rejects.toMatchObject({ code: 'driver_unavailable' })
  })
})
