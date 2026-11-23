import fs from 'fs'
import zlib from 'zlib'
import type { ServerResponse } from 'http'
import type { JobRow, EventRow } from '../../../types'
import type { TelemetryBlobRow, TelemetrySummaryRow } from '../../../db'

import { buildZip, type ZipEntry } from '../../../util/zip'

// ─── NDJSON reader ────────────────────────────────────────────────────────────

function decompressNdjson(filePath: string): string {
  try {
    const compressed = fs.readFileSync(filePath)
    return zlib.gunzipSync(compressed).toString('utf-8')
  } catch {
    return ''
  }
}

function hasTruncationMarker(filePath: string): boolean {
  const content = decompressNdjson(filePath)
  return content.includes('"logs_truncated"')
}

// ─── Summary markdown ─────────────────────────────────────────────────────────

function buildSummaryFromRaw(
  filePath: string,
  job: JobRow,
  truncated: boolean
): string {
  const lines: string[] = []

  if (truncated) {
    lines.push('> **truncated: true** — The 10 MB raw telemetry cap was hit during this run.')
    lines.push('> Log payloads were dropped after the cap. Traces and metrics are complete.')
    lines.push('')
  }

  lines.push(`# Diagnostic Summary — Job ${job.id}`)
  lines.push('')
  lines.push(`- **Command**: \`${job.command}\``)
  lines.push(`- **Status**: ${job.status}`)
  lines.push(`- **Started**: ${job.started_at}`)
  lines.push(`- **Finished**: ${job.finished_at ?? 'N/A'}`)
  if (job.duration_ms != null) lines.push(`- **Duration**: ${job.duration_ms}ms`)
  if (job.total_cost_usd != null) lines.push(`- **Cost**: $${job.total_cost_usd.toFixed(4)}`)
  if (job.tokens_in != null) lines.push(`- **Tokens in**: ${job.tokens_in}`)
  if (job.tokens_out != null) lines.push(`- **Tokens out**: ${job.tokens_out}`)
  lines.push('')
  lines.push('Raw telemetry is available in `telemetry.ndjson`.')

  return lines.join('\n')
}

function buildSummaryFromRows(
  summaries: TelemetrySummaryRow[],
  job: JobRow
): string {
  const lines: string[] = []

  lines.push(`# Diagnostic Summary — Job ${job.id}`)
  lines.push('')
  lines.push(`- **Command**: \`${job.command}\``)
  lines.push(`- **Status**: ${job.status}`)
  lines.push(`- **Started**: ${job.started_at}`)
  lines.push(`- **Finished**: ${job.finished_at ?? 'N/A'}`)
  lines.push('')
  lines.push('> Raw telemetry has been compacted (older than 7 days). Per-phase summary below.')
  lines.push('')
  lines.push('## Phase Summaries')
  lines.push('')

  for (const s of summaries) {
    lines.push(`### Phase: ${s.phase}`)
    if (s.durationMs != null) lines.push(`- Duration: ${s.durationMs}ms`)
    if (s.tokensInput != null) lines.push(`- Tokens in: ${s.tokensInput}`)
    if (s.tokensOutput != null) lines.push(`- Tokens out: ${s.tokensOutput}`)
    if (s.tokensCache != null) lines.push(`- Cache tokens: ${s.tokensCache}`)
    if (s.costUsd != null) lines.push(`- Cost: $${s.costUsd.toFixed(4)}`)
    if (s.apiErrors) lines.push(`- API errors: ${s.apiErrors}`)
    if (s.toolCalls) {
      try {
        const tc = JSON.parse(s.toolCalls) as Record<string, number>
        lines.push(`- Tool calls: ${Object.entries(tc).map(([k, v]) => `${k}×${v}`).join(', ')}`)
      } catch {
        lines.push(`- Tool calls: ${s.toolCalls}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Log extraction ────────────────────────────────────────────────────────────

// App log output is never written to a flat file — it is streamed over
// WebSocket and persisted per-event in the `events` table. Reconstruct a
// readable logs.txt by formatting every event row in seq order.
function buildLogsFromEvents(events: EventRow[]): string {
  if (events.length === 0) {
    return '(No events recorded for this job.)\n'
  }

  const lines: string[] = []
  for (const ev of events) {
    const ts = ev.timestamp
    const src = ev.source ?? ev.event_type
    let text = ev.payload

    // Most log events carry { line: string }; other event types may carry
    // structured JSON. Extract the line field when present, else stringify.
    try {
      const parsed = JSON.parse(ev.payload) as { line?: string; message?: string } & Record<string, unknown>
      if (typeof parsed.line === 'string') text = parsed.line
      else if (typeof parsed.message === 'string') text = parsed.message
      else text = JSON.stringify(parsed)
    } catch {
      // Payload isn't JSON — use raw string as-is
    }

    lines.push(`[${ts}] [${src}] ${redactSecrets(text)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Best-effort redaction of obvious secrets from diagnostic log text (B52). The
 * exported ZIP is meant to be shared (support, bug reports), but the CLI event
 * log can echo `export ANTHROPIC_API_KEY=...`, Bearer tokens, or provider keys.
 * This scrubs the common shapes without destroying the log's diagnostic value.
 */
export function redactSecrets(text: string): string {
  return text
    // KEY=VALUE / TOKEN: VALUE for anything ending in API_KEY/TOKEN/SECRET/PASSWORD/ACCESS_KEY
    .replace(/\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY))(\s*[=:]\s*)(["']?)[^\s"']+\3/gi, '$1$2[REDACTED]')
    // Provider key prefixes (Anthropic/OpenAI sk-..., GitHub gh*_...)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_[REDACTED]')
    // Authorization: Bearer <token>
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi, '$1 [REDACTED]')
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DiagnosticZipOpts {
  job: JobRow
  blob: TelemetryBlobRow
  summaries: TelemetrySummaryRow[]
  events: EventRow[]
  /** Optional profile snapshot the job ran with (from job_profiles). */
  profile?: { name: string; json: string } | null
  /** Optional plugin snapshot path (`~/.specrails/.../plugins.json`). */
  pluginSnapshotPath?: string | null
}

export async function createDiagnosticZip(
  res: ServerResponse,
  opts: DiagnosticZipOpts
): Promise<void> {
  const { job, blob, summaries, events, profile, pluginSnapshotPath } = opts
  const entries: ZipEntry[] = []

  // plugins.json — per-job plugin snapshot, if present.
  let pluginsSummary: { active: Array<{ name: string; version: string }>; degraded: Array<{ name: string; reason: string }> } | null = null
  if (pluginSnapshotPath && fs.existsSync(pluginSnapshotPath)) {
    try {
      const raw = fs.readFileSync(pluginSnapshotPath, 'utf8')
      pluginsSummary = JSON.parse(raw)
      entries.push({ name: 'plugins.json', data: Buffer.from(raw, 'utf-8') })
    } catch {
      // ignore malformed snapshot — diagnostic still useful without it
    }
  }

  // job-metadata.json
  const metadata = {
    id: job.id,
    command: job.command,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    duration_ms: job.duration_ms,
    total_cost_usd: job.total_cost_usd,
    tokens_in: job.tokens_in,
    tokens_out: job.tokens_out,
    tokens_cache_read: job.tokens_cache_read,
    tokens_cache_create: job.tokens_cache_create,
    num_turns: job.num_turns,
    model: job.model,
    session_id: job.session_id,
  }
  entries.push({
    name: 'job-metadata.json',
    data: Buffer.from(JSON.stringify({ ...metadata, profile_name: profile?.name ?? null }, null, 2), 'utf-8'),
  })

  // profile.json — the snapshot the job ran under (if any)
  if (profile && profile.json) {
    entries.push({
      name: 'profile.json',
      data: Buffer.from(profile.json, 'utf-8'),
    })
  }

  // telemetry.ndjson
  let truncated = false
  if (blob.state === 'active' && blob.path && fs.existsSync(blob.path)) {
    truncated = hasTruncationMarker(blob.path)
    const ndjsonContent = decompressNdjson(blob.path)
    entries.push({
      name: 'telemetry.ndjson',
      data: Buffer.from(ndjsonContent, 'utf-8'),
    })
  } else {
    // Compacted: include a header note
    const header = '# Telemetry data has been compacted (raw blob older than 7 days).\n# See summary.md for per-phase aggregates.\n'
    entries.push({
      name: 'telemetry.ndjson',
      data: Buffer.from(header, 'utf-8'),
    })
  }

  // logs.txt — reconstructed from persisted events
  const logsContent = buildLogsFromEvents(events)
  entries.push({
    name: 'logs.txt',
    data: Buffer.from(logsContent, 'utf-8'),
  })

  // summary.md
  let summaryContent: string
  if (blob.state === 'active' && blob.path) {
    summaryContent = buildSummaryFromRaw(blob.path, job, truncated)
  } else {
    summaryContent = buildSummaryFromRows(summaries, job)
  }
  if (pluginsSummary) {
    const lines = ['', '## Plugins']
    if (pluginsSummary.active.length > 0) {
      lines.push('', '### Active', ...pluginsSummary.active.map((p) => `- ${p.name}@${p.version}`))
    }
    if (pluginsSummary.degraded.length > 0) {
      lines.push('', '### Degraded', ...pluginsSummary.degraded.map((p) => `- ${p.name} (${p.reason})`))
    }
    summaryContent += '\n' + lines.join('\n') + '\n'
  }
  entries.push({
    name: 'summary.md',
    data: Buffer.from(summaryContent, 'utf-8'),
  })

  const zipBuf = buildZip(entries)
  res.end(zipBuf)
}
