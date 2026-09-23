import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createCodexOtelBridge, type PosterFn } from './codex-otel-bridge'
import '../../../providers'
import { getAdapter } from '../../../providers/registry'
import type { AdapterEvent } from '../../../providers/types'

function deterministicRb(seed: number) {
  return ((n: number) => {
    const buf = Buffer.alloc(n)
    for (let i = 0; i < n; i++) buf[i] = (seed + i) & 0xff
    return buf
  }) as typeof import('crypto').randomBytes
}

function deterministicClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => {
      const v = t
      t += 100
      return v
    },
  }
}

function recordingPoster() {
  const calls: Array<{ url: string; body: unknown }> = []
  const poster: PosterFn = async (url, body) => {
    calls.push({ url, body: JSON.parse(body) })
    return { ok: true, status: 200 }
  }
  return { calls, poster }
}

describe('createCodexOtelBridge — finalize emits all three signals', () => {
  it('posts traces + metrics + logs to the receiver with required resource attrs', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J1',
      projectId: 'P1',
      desktopPort: 4200,
      model: 'gpt-5.4-mini',
      cliVersion: '0.128.0',
      poster,
      clock: deterministicClock(),
      randomBytes: deterministicRb(42),
    })

    bridge.consumeEvent({ kind: 'session-started', sessionId: 'T-AAA' })
    bridge.consumeEvent({ kind: 'text-delta', text: 'hello' })
    bridge.consumeEvent({
      kind: 'result',
      payload: {
        type: 'turn.completed',
        usage: { input_tokens: 200, output_tokens: 50, cached_input_tokens: 10, reasoning_output_tokens: 5 },
      },
    })

    await bridge.finalize({ exitCode: 0 })

    expect(calls).toHaveLength(3)

    const urls = calls.map((c) => c.url).sort()
    expect(urls).toEqual([
      'http://127.0.0.1:4200/otlp/v1/logs',
      'http://127.0.0.1:4200/otlp/v1/metrics',
      'http://127.0.0.1:4200/otlp/v1/traces',
    ])

    const traces = calls.find((c) => c.url.endsWith('/traces'))!.body as { resourceSpans: unknown[] }
    const tracesResource = (traces.resourceSpans[0] as { resource: { attributes: { key: string; value: { stringValue: string } }[] } }).resource
    const attrMap: Record<string, string> = {}
    for (const a of tracesResource.attributes) attrMap[a.key] = a.value.stringValue
    expect(attrMap['specrails.job_id']).toBe('J1')
    expect(attrMap['specrails.project_id']).toBe('P1')
    expect(attrMap['specrails.provider']).toBe('codex')
    expect(attrMap['specrails.codex.thread_id']).toBe('T-AAA')
    expect(attrMap['specrails.codex.cli_version']).toBe('0.128.0')
    expect(attrMap['specrails.codex.model']).toBe('gpt-5.4-mini')

    const span = (traces.resourceSpans[0] as { scopeSpans: Array<{ spans: Array<{ name: string; attributes: { key: string; value: { intValue?: string; stringValue?: string } }[] }> }> })
      .scopeSpans[0].spans[0]
    expect(span.name).toBe('specrails.codex.turn')
    const spanAttrMap: Record<string, string> = {}
    for (const a of span.attributes) {
      spanAttrMap[a.key] = a.value.intValue ?? a.value.stringValue ?? ''
    }
    expect(spanAttrMap['codex.tokens.input']).toBe('200')
    expect(spanAttrMap['codex.tokens.output']).toBe('55') // 50 + 5 reasoning
    expect(spanAttrMap['codex.tokens.cache_read']).toBe('10')
    expect(spanAttrMap['codex.exit_code']).toBe('0')

    const metrics = calls.find((c) => c.url.endsWith('/metrics'))!.body as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }> }
    const metricNames = metrics.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name)
    expect(metricNames).toContain('specrails.codex.tokens.input')
    expect(metricNames).toContain('specrails.codex.tokens.output')
    expect(metricNames).toContain('specrails.codex.tokens.cache_read')
    expect(metricNames).toContain('specrails.codex.duration_ms')

    const logs = calls.find((c) => c.url.endsWith('/logs'))!.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }> }> }
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).toBe('hello')
  })

  it('emits tool-use events as span events', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster,
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })
    bridge.consumeEvent({ kind: 'tool-use', name: 'shell', inputPreview: 'ls -la' })
    bridge.consumeEvent({ kind: 'result', payload: { type: 'turn.completed' } })
    await bridge.finalize({ exitCode: 0 })

    const traces = calls.find((c) => c.url.endsWith('/traces'))!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ events: Array<{ name: string; attributes: { key: string; value: { stringValue: string } }[] }> }> }> }> }
    const events = traces.resourceSpans[0].scopeSpans[0].spans[0].events
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('codex.tool_use')
    const attrMap: Record<string, string> = {}
    for (const a of events[0].attributes) attrMap[a.key] = a.value.stringValue
    expect(attrMap['codex.tool.name']).toBe('shell')
    expect(attrMap['codex.tool.input_preview']).toBe('ls -la')
  })

  it('logs cap: emits truncation marker exactly once and stops appending', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster,
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })

    // Push enough text-delta to exceed the 10 MB cap. We push 12 MB worth of
    // 1 MB chunks so the 11th chunk crosses the cap.
    const oneMb = 'a'.repeat(1024 * 1024)
    for (let i = 0; i < 12; i++) {
      bridge.consumeEvent({ kind: 'text-delta', text: oneMb })
    }
    bridge.consumeEvent({ kind: 'result', payload: { type: 'turn.completed' } })
    await bridge.finalize({ exitCode: 0 })

    expect(bridge._debugTruncated()).toBe(true)

    const logs = calls.find((c) => c.url.endsWith('/logs'))!.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }> }> }
    const records = logs.resourceLogs[0].scopeLogs[0].logRecords
    const truncationMarkers = records.filter((r) => r.body.stringValue.includes('truncated'))
    expect(truncationMarkers).toHaveLength(1)
  })

  it('survives a poster that throws (best-effort)', async () => {
    const poster: PosterFn = async () => { throw new Error('network down') }
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster,
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })
    bridge.consumeEvent({ kind: 'session-started', sessionId: 'T' })
    bridge.consumeEvent({ kind: 'result', payload: { type: 'turn.completed' } })
    await expect(bridge.finalize({ exitCode: 0 })).resolves.toBeUndefined()
  })

  it('failed run produces error status code on the span', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster,
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })
    bridge.consumeEvent({ kind: 'result', payload: { type: 'turn.completed' } })
    await bridge.finalize({ exitCode: 1, stderr: 'oops' })

    const traces = calls.find((c) => c.url.endsWith('/traces'))!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number; message: string } }> }> }> }
    const status = traces.resourceSpans[0].scopeSpans[0].spans[0].status
    expect(status.code).toBe(2)
    expect(status.message).toBe('oops')
  })

  it('ignores other-kind events silently', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster,
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })
    bridge.consumeEvent({ kind: 'other', type: 'turn.started', raw: {} })
    bridge.consumeEvent({ kind: 'result', payload: { type: 'turn.completed' } })
    await bridge.finalize({ exitCode: 0 })

    const traces = calls.find((c) => c.url.endsWith('/traces'))!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ events: unknown[] }> }> }> }
    expect(traces.resourceSpans[0].scopeSpans[0].spans[0].events).toEqual([])
  })
})

describe('createCodexOtelBridge — fixture-driven end-to-end', () => {
  it('consumes a real codex fixture and emits expected token sums', async () => {
    const { calls, poster } = recordingPoster()
    const bridge = createCodexOtelBridge({
      jobId: 'J', projectId: 'P', desktopPort: 4200, poster, model: 'gpt-5.4-mini',
      clock: deterministicClock(), randomBytes: deterministicRb(1),
    })

    const fixturePath = join(require('node:path').resolve(__dirname, '../../..'), 'providers', '__fixtures__', 'codex', '0.128.0', 'say-bye.jsonl')
    const lines = readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter(Boolean)
    const adapter = getAdapter('codex')
    for (const line of lines) {
      const ev = adapter.parseStreamLine(line)
      if (ev) bridge.consumeEvent(ev)
    }
    await bridge.finalize({ exitCode: 0 })

    const traces = calls.find((c) => c.url.endsWith('/traces'))!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: { key: string; value: { intValue?: string } }[] }> }> }> }
    const spanAttrs: Record<string, string> = {}
    for (const a of traces.resourceSpans[0].scopeSpans[0].spans[0].attributes) {
      if (a.value.intValue) spanAttrs[a.key] = a.value.intValue
    }
    // Fixture: input=11923, output=45, reasoning=42, cached=2432
    expect(spanAttrs['codex.tokens.input']).toBe('11923')
    expect(spanAttrs['codex.tokens.output']).toBe(String(45 + 42))
    expect(spanAttrs['codex.tokens.cache_read']).toBe('2432')
  })
})
