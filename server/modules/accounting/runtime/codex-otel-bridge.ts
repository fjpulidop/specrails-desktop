// Synthetic OTEL bridge for codex (and any future provider whose CLI does not
// honour `OTEL_EXPORTER_OTLP_*` environment variables natively).
//
// Lifecycle:
//
//   const bridge = createCodexOtelBridge({ jobId, projectId, desktopPort, model, threadId? })
//   for each parsed AdapterEvent → bridge.consumeEvent(event)
//   on child close → await bridge.finalize({ exitCode, stderr? })
//
// On finalize, the bridge composes one OTLP/JSON payload per signal (traces,
// metrics, logs) and POSTs them to the in-process receiver at
// http://127.0.0.1:<desktopPort>/otlp/v1/{traces,metrics,logs}. The receiver
// already routes by resource attributes, enforces the 10 MB cap, gzips the
// NDJSON, and updates `telemetry_blobs` — the bridge does not bypass any of
// that.
//
// Spec: openspec/changes/add-multi-provider-support/specs/pipeline-telemetry/spec.md
//   - "Synthetic OTEL bridge for providers without native OTEL env support"

import { randomBytes } from 'crypto'
import type { AdapterEvent } from '../../../providers/types'

export interface BridgeOptions {
  jobId: string
  projectId: string
  desktopPort: number
  /** Model the codex spawn used. Captured as a span attribute. */
  model?: string
  /** codex --version. Captured as `specrails.codex.cli_version` resource attr. */
  cliVersion?: string
  /** Override the in-process POST function. Default uses `globalThis.fetch`. */
  poster?: PosterFn
  /** Override Date.now / process.hrtime / randomBytes for deterministic tests. */
  clock?: { now(): number }
  randomBytes?: typeof randomBytes
}

export type PosterFn = (url: string, body: string) => Promise<PostResult>

interface PostResult {
  ok: boolean
  status: number
  body?: unknown
}

export interface FinaliseInput {
  exitCode: number | null
  stderr?: string
}

export interface CodexOtelBridge {
  /** Feed every parsed AdapterEvent in real time. */
  consumeEvent(event: AdapterEvent): void
  /** Compose payloads and POST them. Resolves when all 3 POSTs settle. */
  finalize(input: FinaliseInput): Promise<void>
  /** Number of bytes the bridge has queued for the logs payload (test hook). */
  _debugLogBytes(): number
  /** Whether the truncation marker has been emitted (test hook). */
  _debugTruncated(): boolean
}

const LOGS_CAP_BYTES = 10 * 1024 * 1024 // 10 MB — mirrors telemetry-receiver cap

// ─── OTLP shape helpers ───────────────────────────────────────────────────────

function attr(key: string, value: string): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value } }
}

function intAttr(key: string, value: number): { key: string; value: { intValue: string } } {
  return { key, value: { intValue: String(value) } }
}

function makeResource(opts: BridgeOptions, threadId: string | undefined) {
  const attrs = [
    attr('specrails.job_id', opts.jobId),
    attr('specrails.project_id', opts.projectId),
    attr('specrails.provider', 'codex'),
    attr('service.name', 'specrails-desktop.codex-bridge'),
  ]
  if (opts.model) attrs.push(attr('specrails.codex.model', opts.model))
  if (opts.cliVersion) attrs.push(attr('specrails.codex.cli_version', opts.cliVersion))
  if (threadId) attrs.push(attr('specrails.codex.thread_id', threadId))
  return { attributes: attrs }
}

// ─── Bridge factory ───────────────────────────────────────────────────────────

export function createCodexOtelBridge(opts: BridgeOptions): CodexOtelBridge {
  const clock = opts.clock ?? { now: () => Date.now() }
  const rb = opts.randomBytes ?? randomBytes
  const poster = opts.poster ?? defaultPoster

  const startedAtMs = clock.now()
  const startedAtUnixNs = String(BigInt(startedAtMs) * 1_000_000n)
  const traceId = rb(16).toString('hex')
  const rootSpanId = rb(8).toString('hex')

  let threadId: string | undefined
  let logsBytes = 0
  let truncated = false
  const logRecords: Array<{ timeUnixNano: string; body: { stringValue: string } }> = []
  const spanEvents: Array<{ timeUnixNano: string; name: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> = []
  let resultPayload: Record<string, unknown> | null = null

  function consumeEvent(event: AdapterEvent): void {
    const nowMs = clock.now()
    const nowNs = String(BigInt(nowMs) * 1_000_000n)

    switch (event.kind) {
      case 'session-started':
        threadId = event.sessionId
        break
      case 'tool-use': {
        const tail = {
          timeUnixNano: nowNs,
          name: 'codex.tool_use',
          attributes: [
            attr('codex.tool.name', event.name),
            attr('codex.tool.input_preview', event.inputPreview),
          ],
        }
        spanEvents.push(tail)
        break
      }
      case 'text-delta': {
        const recordSize = Buffer.byteLength(event.text, 'utf-8') + 64 // overhead estimate
        if (logsBytes + recordSize > LOGS_CAP_BYTES) {
          if (!truncated) {
            truncated = true
            logRecords.push({
              timeUnixNano: nowNs,
              body: { stringValue: '[specrails.codex-bridge] logs truncated (10 MB cap)' },
            })
          }
          break
        }
        logsBytes += recordSize
        logRecords.push({ timeUnixNano: nowNs, body: { stringValue: event.text } })
        break
      }
      case 'result':
        resultPayload = event.payload
        break
      case 'other':
        // Ignore — these are progress markers, not actionable telemetry.
        break
    }
  }

  async function finalize(input: FinaliseInput): Promise<void> {
    const endedAtMs = clock.now()
    const endedAtUnixNs = String(BigInt(endedAtMs) * 1_000_000n)

    const resource = makeResource(opts, threadId)
    const scopeKey = { name: 'specrails-desktop.codex-bridge' }

    // ── Spans ──────────────────────────────────────────────────────────────
    const usage = (resultPayload?.usage as Record<string, number> | undefined) ?? {}
    const tokensIn = usage.input_tokens ?? 0
    const tokensOut = (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0)
    const tokensCacheRead = usage.cached_input_tokens ?? 0

    const spanAttrs: Array<{ key: string; value: { intValue?: string; stringValue?: string } }> = [
      intAttr('codex.tokens.input', tokensIn),
      intAttr('codex.tokens.output', tokensOut),
      intAttr('codex.tokens.cache_read', tokensCacheRead),
      intAttr('codex.exit_code', input.exitCode ?? -1),
    ]
    if (opts.model) spanAttrs.push(attr('codex.model', opts.model))

    const tracesPayload = {
      resourceSpans: [{
        resource,
        scopeSpans: [{
          scope: scopeKey,
          spans: [{
            traceId,
            spanId: rootSpanId,
            name: 'specrails.codex.turn',
            kind: 1, // INTERNAL
            startTimeUnixNano: startedAtUnixNs,
            endTimeUnixNano: endedAtUnixNs,
            attributes: spanAttrs,
            events: spanEvents,
            status: {
              code: input.exitCode === 0 ? 1 : 2, // OK=1, ERROR=2
              message: input.exitCode === 0 ? '' : (input.stderr?.slice(-300) ?? ''),
            },
          }],
        }],
      }],
    }

    // ── Metrics ────────────────────────────────────────────────────────────
    function tokenMetric(name: string, value: number) {
      return {
        name,
        unit: 'tokens',
        sum: {
          aggregationTemporality: 1, // DELTA
          isMonotonic: true,
          dataPoints: [{
            timeUnixNano: endedAtUnixNs,
            startTimeUnixNano: startedAtUnixNs,
            asInt: String(value),
          }],
        },
      }
    }

    const durationMs = endedAtMs - startedAtMs

    const metricsPayload = {
      resourceMetrics: [{
        resource,
        scopeMetrics: [{
          scope: scopeKey,
          metrics: [
            tokenMetric('specrails.codex.tokens.input', tokensIn),
            tokenMetric('specrails.codex.tokens.output', tokensOut),
            tokenMetric('specrails.codex.tokens.cache_read', tokensCacheRead),
            {
              name: 'specrails.codex.duration_ms',
              unit: 'ms',
              gauge: {
                dataPoints: [{
                  timeUnixNano: endedAtUnixNs,
                  asInt: String(durationMs),
                }],
              },
            },
          ],
        }],
      }],
    }

    // ── Logs ───────────────────────────────────────────────────────────────
    const logsPayload = {
      resourceLogs: [{
        resource,
        scopeLogs: [{
          scope: scopeKey,
          logRecords: logRecords.map((r) => ({
            timeUnixNano: r.timeUnixNano,
            severityNumber: 9, // INFO
            severityText: 'INFO',
            body: r.body,
          })),
        }],
      }],
    }

    const url = (signal: 'traces' | 'metrics' | 'logs') =>
      `http://127.0.0.1:${opts.desktopPort}/otlp/v1/${signal}`

    const results = await Promise.allSettled([
      poster(url('traces'), JSON.stringify(tracesPayload)),
      poster(url('metrics'), JSON.stringify(metricsPayload)),
      poster(url('logs'), JSON.stringify(logsPayload)),
    ])

    // Log POST failures but never throw — telemetry is best-effort.
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[codex-otel-bridge] poster rejected:', r.reason)
      } else if (!r.value.ok) {
        console.warn(`[codex-otel-bridge] poster non-ok status ${r.value.status}`)
      }
    }
  }

  return {
    consumeEvent,
    finalize,
    _debugLogBytes: () => logsBytes,
    _debugTruncated: () => truncated,
  }
}

// ─── Default poster (uses globalThis.fetch) ─────────────────────────────────

const defaultPoster: PosterFn = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message }
  }
}
