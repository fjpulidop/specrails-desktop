import fs from 'fs'
import zlib from 'zlib'
import type { ProjectContext } from './project-registry'
import type { ProjectRegistry } from './project-registry'
import {
  listActiveTelemetryBlobs,
  setTelemetryBlobCompacted,
  insertTelemetrySummary,
  deleteTelemetryForJob,
} from './db'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// ─── NDJSON reader ────────────────────────────────────────────────────────────

interface TelemetryLine {
  signal: 'traces' | 'metrics' | 'logs' | 'control'
  receivedAt?: string
  payload?: unknown
  event?: string
  at?: string
}

function readNdjsonGz(filePath: string): TelemetryLine[] {
  try {
    const compressed = fs.readFileSync(filePath)
    // Decompress all concatenated gzip members
    const raw = zlib.gunzipSync(compressed).toString('utf-8')
    const lines: TelemetryLine[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        lines.push(JSON.parse(trimmed) as TelemetryLine)
      } catch {
        // Skip malformed lines
      }
    }
    return lines
  } catch {
    return []
  }
}

// ─── Aggregate helpers ────────────────────────────────────────────────────────

interface PhaseAggregates {
  durationMs: number
  tokensInput: number
  tokensOutput: number
  tokensCache: number
  toolCallCounts: Record<string, number>
  apiErrors: number
  costUsd: number
}

function emptyAgg(): PhaseAggregates {
  return { durationMs: 0, tokensInput: 0, tokensOutput: 0, tokensCache: 0, toolCallCounts: {}, apiErrors: 0, costUsd: 0 }
}

/** Read a string attribute value off an OTLP metric data point (`attributes`
 *  is `[{key, value:{stringValue}}]`). Returns undefined when absent. */
function dpAttr(dp: Record<string, unknown>, key: string): string | undefined {
  const attrs = dp.attributes as Array<Record<string, unknown>> | undefined
  for (const a of attrs ?? []) {
    if (a.key === key) {
      const v = a.value as { stringValue?: unknown } | undefined
      return typeof v?.stringValue === 'string' ? v.stringValue : undefined
    }
  }
  return undefined
}

/**
 * Extract per-phase aggregates from telemetry lines.
 * We use the `scope.name` or a best-effort fallback to group by phase.
 * If no phase can be determined we bucket everything into "unknown".
 */
function aggregateByPhase(lines: TelemetryLine[]): Map<string, PhaseAggregates> {
  const phases = new Map<string, PhaseAggregates>()

  function getAgg(phase: string): PhaseAggregates {
    let agg = phases.get(phase)
    if (!agg) { agg = emptyAgg(); phases.set(phase, agg) }
    return agg
  }

  for (const line of lines) {
    if (line.signal === 'control') continue

    const payload = line.payload as Record<string, unknown> | undefined
    if (!payload) continue

    // ── Traces: extract duration and tool call info ──────────────────────────
    if (line.signal === 'traces') {
      const resourceSpans = payload.resourceSpans as Array<Record<string, unknown>> | undefined
      for (const rs of resourceSpans ?? []) {
        const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>> | undefined
        for (const ss of scopeSpans ?? []) {
          const scope = ss.scope as Record<string, unknown> | undefined
          const phase = (typeof scope?.name === 'string' ? scope.name : undefined) ?? 'unknown'
          const agg = getAgg(phase)
          const spans = ss.spans as Array<Record<string, unknown>> | undefined
          for (const span of spans ?? []) {
            // Duration in nanoseconds → convert to ms
            const startNs = typeof span.startTimeUnixNano === 'string' ? BigInt(span.startTimeUnixNano) : null
            const endNs = typeof span.endTimeUnixNano === 'string' ? BigInt(span.endTimeUnixNano) : null
            if (startNs && endNs && endNs > startNs) {
              agg.durationMs += Number((endNs - startNs) / BigInt(1_000_000))
            }
            // Count tool calls by name
            const name = typeof span.name === 'string' ? span.name : null
            if (name) {
              agg.toolCallCounts[name] = (agg.toolCallCounts[name] ?? 0) + 1
            }
            // API errors: status code != 0 in OTEL spans
            const status = span.status as Record<string, unknown> | undefined
            if (status && status.code !== 0 && status.code !== 'STATUS_CODE_OK') {
              agg.apiErrors++
            }
          }
        }
      }
    }

    // ── Metrics: extract token counts and cost ────────────────────────────────
    if (line.signal === 'metrics') {
      const resourceMetrics = payload.resourceMetrics as Array<Record<string, unknown>> | undefined
      for (const rm of resourceMetrics ?? []) {
        const scopeMetrics = rm.scopeMetrics as Array<Record<string, unknown>> | undefined
        for (const sm of scopeMetrics ?? []) {
          const scope = sm.scope as Record<string, unknown> | undefined
          const phase = (typeof scope?.name === 'string' ? scope.name : undefined) ?? 'unknown'
          const agg = getAgg(phase)
          const metrics = sm.metrics as Array<Record<string, unknown>> | undefined
          for (const metric of metrics ?? []) {
            const metricName = typeof metric.name === 'string' ? metric.name : ''
            const sum = metric.sum as Record<string, unknown> | undefined
            const dataPoints = sum?.dataPoints as Array<Record<string, unknown>> | undefined
            for (const dp of dataPoints ?? []) {
              const value = typeof dp.asInt === 'string' ? parseInt(dp.asInt, 10)
                : typeof dp.asDouble === 'number' ? dp.asDouble : 0
              // Claude Code emits ONE token metric `claude_code.token.usage` and
              // buckets via a per-data-point `type` attribute (input/output/
              // cacheRead/cacheCreation); cost is `claude_code.cost.usage`. The
              // old substring matches (`input_tokens`/`cost_usd`) never hit
              // these names → aggregates were always zero.
              if (metricName === 'claude_code.token.usage') {
                const type = dpAttr(dp, 'type')
                if (type === 'input') agg.tokensInput += value
                else if (type === 'output') agg.tokensOutput += value
                else if (type === 'cacheRead' || type === 'cacheCreation') agg.tokensCache += value
                continue
              }
              if (metricName === 'claude_code.cost.usage') { agg.costUsd += value; continue }
              // Codex bridge emits `specrails.codex.tokens.{input,output,cache_read}`.
              // Keep legacy substring fallbacks for any other producer.
              if (metricName.includes('tokens.input') || metricName.includes('input_tokens') || metricName.includes('tokens_in')) {
                agg.tokensInput += value
              } else if (metricName.includes('tokens.output') || metricName.includes('output_tokens') || metricName.includes('tokens_out')) {
                agg.tokensOutput += value
              } else if (metricName.includes('tokens.cache') || metricName.includes('cache_tokens') || metricName.includes('tokens_cache')) {
                agg.tokensCache += value
              } else if (metricName.includes('cost_usd') || metricName.includes('total_cost') || metricName.includes('cost.usage')) {
                agg.costUsd += value
              }
            }
          }
        }
      }
    }
  }

  // Default to 'unknown' phase if nothing was bucketed
  if (phases.size === 0) phases.set('unknown', emptyAgg())

  return phases
}

// ─── Core compaction ──────────────────────────────────────────────────────────

export async function runCompaction(ctx: ProjectContext, now: number = Date.now()): Promise<void> {
  const { db } = ctx
  const blobs = listActiveTelemetryBlobs(db)

  for (const blob of blobs) {
    const age = blob.endedAt ?? blob.startedAt
    if (!age) continue
    if (now - age < SEVEN_DAYS_MS) continue

    // Blob is older than 7 days — compact it
    const lines = blob.path ? readNdjsonGz(blob.path) : []
    const phaseAggs = aggregateByPhase(lines)

    for (const [phase, agg] of phaseAggs) {
      insertTelemetrySummary(db, {
        jobId: blob.jobId,
        phase,
        durationMs: agg.durationMs || null,
        tokensInput: agg.tokensInput || null,
        tokensOutput: agg.tokensOutput || null,
        tokensCache: agg.tokensCache || null,
        toolCalls: Object.keys(agg.toolCallCounts).length > 0
          ? JSON.stringify(agg.toolCallCounts)
          : null,
        apiErrors: agg.apiErrors || null,
        costUsd: agg.costUsd || null,
      })
    }

    // Delete the blob file
    if (blob.path) {
      try { fs.unlinkSync(blob.path) } catch { /* already gone */ }
    }

    // Mark the pointer row as compacted
    setTelemetryBlobCompacted(db, blob.jobId)
  }
}

/** Run compaction for every loaded project. Called at server startup. */
export async function runCompactionForAll(registry: ProjectRegistry): Promise<void> {
  const now = Date.now()
  for (const ctx of registry.listContexts()) {
    try {
      await runCompaction(ctx, now)
    } catch (err) {
      console.error(`[telemetry-compactor] compaction failed for project ${ctx.project.id}:`, err)
    }
  }
}
