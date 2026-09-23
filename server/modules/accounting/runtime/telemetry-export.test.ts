import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { createDiagnosticZip, redactSecrets } from './telemetry-export'
import type { DiagnosticZipOpts } from './telemetry-export'
import type { JobRow, EventRow } from '../../../types'
import type { TelemetryBlobRow } from '../../../db'
import { ServerResponse, IncomingMessage } from 'http'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-test',
    command: 'architect',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:05:00.000Z',
    status: 'success',
    exit_code: 0,
    queue_position: null,
    priority: 'normal',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_cache_read: 50,
    tokens_cache_create: 10,
    total_cost_usd: 0.0123,
    num_turns: 5,
    model: 'claude-opus-4-8',
    duration_ms: 300000,
    duration_api_ms: 250000,
    session_id: 'sess-abc',
    depends_on_job_id: null,
    pipeline_id: null,
    skip_reason: null,
    ...overrides,
  }
}

function makeBlob(overrides: Partial<TelemetryBlobRow> = {}): TelemetryBlobRow {
  return {
    jobId: 'job-test',
    path: null,
    byteSize: 0,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    state: 'active',
    ...overrides,
  }
}

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    job_id: 'job-test',
    seq: 1,
    event_type: 'log',
    source: 'stdout',
    payload: JSON.stringify({ line: 'hello world' }),
    timestamp: '2026-01-01T00:00:01.000Z',
    ...overrides,
  }
}

/** Capture zip buffer by collecting res.end() call */
function captureZip(opts: DiagnosticZipOpts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const res = new ServerResponse(new IncomingMessage(undefined as never))
    const origEnd = res.end.bind(res)
    res.end = (data?: unknown) => {
      if (Buffer.isBuffer(data)) chunks.push(data)
      else if (typeof data === 'string') chunks.push(Buffer.from(data))
      resolve(Buffer.concat(chunks))
      return res
    }
    createDiagnosticZip(res, opts).catch(reject)
  })
}

/** Check that a buffer starts with ZIP local file header magic */
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 &&
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createDiagnosticZip — compacted blob', () => {
  it('returns a valid ZIP buffer', async () => {
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted', path: null }),
      summaries: [],
      events: [],
    })
    expect(isZip(buf)).toBe(true)
  })

  it('includes job-metadata.json with correct fields', async () => {
    const job = makeJob()
    const buf = await captureZip({
      job,
      blob: makeBlob({ state: 'compacted' }),
      summaries: [],
      events: [],
    })
    // Find job-metadata.json: it follows the local header
    // Simplest approach: search buffer for JSON content
    const str = buf.toString('utf-8')
    expect(str).toContain('job-test')
    expect(str).toContain('architect')
    expect(str).toContain('success')
  })

  it('includes compacted header in telemetry.ndjson', async () => {
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries: [],
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('compacted')
  })

  it('includes summary.md from rows when compacted', async () => {
    const summaries = [{
      id: 1,
      jobId: 'job-test',
      phase: 'architect',
      durationMs: 5000,
      tokensInput: 100,
      tokensOutput: 200,
      tokensCache: 10,
      toolCalls: '{"bash":3}',
      apiErrors: 0,
      costUsd: 0.05,
    }]
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries,
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('architect')
    expect(str).toContain('Phase Summaries')
  })

  it('handles empty events with placeholder log line', async () => {
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries: [],
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('No events recorded')
  })

  it('formats non-empty events into logs.txt', async () => {
    const events: EventRow[] = [
      makeEvent({ payload: JSON.stringify({ line: 'step 1 output' }) }),
      makeEvent({ id: 2, seq: 2, payload: JSON.stringify({ message: 'done' }), source: 'stderr' }),
      makeEvent({ id: 3, seq: 3, payload: 'plain text payload', event_type: 'system', source: null }),
    ]
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries: [],
      events,
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('step 1 output')
    expect(str).toContain('done')
    expect(str).toContain('plain text payload')
  })
})

describe('createDiagnosticZip — active blob with temp file', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `specrails-test-${Date.now()}.ndjson.gz`)
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* ok */ }
  })

  function writeGzLine(filePath: string, obj: unknown): void {
    const line = JSON.stringify(obj) + '\n'
    const compressed = zlib.gzipSync(Buffer.from(line, 'utf-8'))
    fs.appendFileSync(filePath, compressed)
  }

  it('includes decompressed NDJSON in telemetry.ndjson for active blob', async () => {
    writeGzLine(tmpFile, { signal: 'traces', receivedAt: '2026-01-01', payload: { test: true } })

    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'active', path: tmpFile }),
      summaries: [],
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('"test":true')
  })

  it('builds summary from raw file when blob is active', async () => {
    writeGzLine(tmpFile, { signal: 'traces', receivedAt: '2026-01-01', payload: {} })

    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'active', path: tmpFile }),
      summaries: [],
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('Diagnostic Summary')
    expect(str).toContain('architect')
  })

  it('includes truncation warning in summary when logs_truncated marker present', async () => {
    writeGzLine(tmpFile, { signal: 'control', event: 'logs_truncated', at: '2026-01-01' })

    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'active', path: tmpFile }),
      summaries: [],
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('truncated')
  })

  it('handles missing active blob file gracefully', async () => {
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'active', path: '/nonexistent/path/blob.ndjson.gz' }),
      summaries: [],
      events: [],
    })
    expect(isZip(buf)).toBe(true)
  })

  it('handles null path on active blob', async () => {
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'active', path: null }),
      summaries: [],
      events: [],
    })
    expect(isZip(buf)).toBe(true)
  })
})

describe('createDiagnosticZip — optional job fields', () => {
  it('works when nullable job fields are null', async () => {
    const job = makeJob({
      finished_at: null,
      duration_ms: null,
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
    })
    const buf = await captureZip({
      job,
      blob: makeBlob({ state: 'compacted' }),
      summaries: [],
      events: [],
    })
    expect(isZip(buf)).toBe(true)
    const str = buf.toString('utf-8')
    expect(str).toContain('N/A')
  })

  it('includes tool calls and API errors in per-phase summary', async () => {
    const summaries = [{
      id: 1,
      jobId: 'job-test',
      phase: 'dev',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensCache: null,
      toolCalls: '{"read":5,"bash":2}',
      apiErrors: 3,
      costUsd: null,
    }]
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries,
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('read×5')
    expect(str).toContain('API errors: 3')
  })

  it('handles malformed toolCalls JSON gracefully', async () => {
    const summaries = [{
      id: 1,
      jobId: 'job-test',
      phase: 'dev',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensCache: null,
      toolCalls: 'NOT_JSON',
      apiErrors: null,
      costUsd: null,
    }]
    const buf = await captureZip({
      job: makeJob(),
      blob: makeBlob({ state: 'compacted' }),
      summaries,
      events: [],
    })
    const str = buf.toString('utf-8')
    expect(str).toContain('NOT_JSON')
  })
})

describe('redactSecrets (B52)', () => {
  it('redacts KEY=VALUE secrets', () => {
    expect(redactSecrets('export ANTHROPIC_API_KEY=sk-ant-abc123xyz')).toContain('[REDACTED]')
    expect(redactSecrets('export ANTHROPIC_API_KEY=sk-ant-abc123xyz')).not.toContain('abc123xyz')
    expect(redactSecrets('GITHUB_TOKEN: ghp_aaaaaaaaaaaaaaaaaaaa')).toContain('[REDACTED]')
  })
  it('redacts provider key prefixes and bearer tokens', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrstu used')).toContain('sk-[REDACTED]')
    expect(redactSecrets('Authorization: Bearer abcdef0123456789xyz')).toContain('Bearer [REDACTED]')
    expect(redactSecrets('token ghp_0123456789abcdef0123')).toContain('gh_[REDACTED]')
  })
  it('leaves ordinary log text untouched', () => {
    const line = 'Running phase architect on ticket #42 (2 turns)'
    expect(redactSecrets(line)).toBe(line)
  })
})
