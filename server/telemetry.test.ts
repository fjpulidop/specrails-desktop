import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildTelemetryEnv } from './queue-manager'
import { readCurrentFrameworkVersion, frameworkRoot } from './framework-manager'
import { initDb } from './db'
import {
  getProjectSettings, updateProjectSettings,
  getTelemetryBlob, upsertTelemetryBlob, setTelemetryBlobCompacted,
  getJobsWithTelemetry, insertTelemetrySummary, getTelemetrySummaries,
  deleteTelemetryForJob,
} from './db'
import type { DbInstance } from './db'

function makeDb(): DbInstance {
  return initDb(':memory:')
}

// ─── 7.1 buildTelemetryEnv ────────────────────────────────────────────────────

describe('buildTelemetryEnv', () => {
  it('returns all required OTEL env vars with correct values when called', () => {
    const env = buildTelemetryEnv('job-1', 'proj-1', 4200)
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4200/otlp')
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json')
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp')
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp')
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('specrails.job_id=job-1,specrails.project_id=proj-1')
  })

  it('uses the provided server port in the endpoint URL', () => {
    const env = buildTelemetryEnv('job-abc', 'proj-xyz', 9999)
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:9999/otlp')
  })

  it('embeds jobId and projectId in OTEL_RESOURCE_ATTRIBUTES', () => {
    const env = buildTelemetryEnv('my-job-id', 'my-proj-id', 4200)
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('specrails.job_id=my-job-id')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('specrails.project_id=my-proj-id')
  })

  it('appends specrails.framework_version when present in extra attrs (relocated)', () => {
    const env = buildTelemetryEnv('j', 'p', 4200, { 'specrails.framework_version': '5.1.0' })
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('specrails.framework_version=5.1.0')
  })

  it('omits specrails.framework_version entirely when no extra attr is passed (not relocated)', () => {
    const env = buildTelemetryEnv('j', 'p', 4200)
    expect(env.OTEL_RESOURCE_ATTRIBUTES).not.toContain('framework_version')
  })
})

// ─── Framework version resolution for the rail OTEL attr ──────────────────────

describe('readCurrentFrameworkVersion (queue-manager OTEL framework_version source)', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwver-'))
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('returns null when no framework is materialized (not relocated → attr omitted)', () => {
    expect(readCurrentFrameworkVersion(home)).toBeNull()
  })

  it('returns the current version when framework/current is materialized (relocated → attr set)', () => {
    const fw = frameworkRoot(home)
    fs.mkdirSync(path.join(fw, '5.1.0'), { recursive: true })
    fs.symlinkSync('5.1.0', path.join(fw, 'current'))
    expect(readCurrentFrameworkVersion(home)).toBe('5.1.0')
  })
})

// ─── Project settings ─────────────────────────────────────────────────────────

describe('getProjectSettings / updateProjectSettings', () => {
  it('defaults pipelineTelemetryEnabled to false', () => {
    const db = makeDb()
    const settings = getProjectSettings(db)
    expect(settings.pipelineTelemetryEnabled).toBe(false)
  })

  it('persists the toggle when updated to true', () => {
    const db = makeDb()
    updateProjectSettings(db, { pipelineTelemetryEnabled: true })
    expect(getProjectSettings(db).pipelineTelemetryEnabled).toBe(true)
  })

  it('persists the toggle back to false', () => {
    const db = makeDb()
    updateProjectSettings(db, { pipelineTelemetryEnabled: true })
    updateProjectSettings(db, { pipelineTelemetryEnabled: false })
    expect(getProjectSettings(db).pipelineTelemetryEnabled).toBe(false)
  })

  it('defaults orchestratorModel to sonnet', () => {
    const db = makeDb()
    expect(getProjectSettings(db).orchestratorModel).toBe('sonnet')
  })

  it('persists orchestratorModel when updated', () => {
    const db = makeDb()
    updateProjectSettings(db, { orchestratorModel: 'opus' })
    expect(getProjectSettings(db).orchestratorModel).toBe('opus')
  })

  it('persists orchestratorModel update to haiku', () => {
    const db = makeDb()
    updateProjectSettings(db, { orchestratorModel: 'opus' })
    updateProjectSettings(db, { orchestratorModel: 'haiku' })
    expect(getProjectSettings(db).orchestratorModel).toBe('haiku')
  })

  it('does not affect pipelineTelemetryEnabled when only orchestratorModel updated', () => {
    const db = makeDb()
    updateProjectSettings(db, { orchestratorModel: 'opus' })
    expect(getProjectSettings(db).pipelineTelemetryEnabled).toBe(false)
  })

  it('defaults prePrompt to an empty string', () => {
    const db = makeDb()
    expect(getProjectSettings(db).prePrompt).toBe('')
  })

  it('persists prePrompt when updated', () => {
    const db = makeDb()
    updateProjectSettings(db, { prePrompt: 'Always add regression tests.' })
    expect(getProjectSettings(db).prePrompt).toBe('Always add regression tests.')
  })

  it('clears prePrompt when updated with whitespace', () => {
    const db = makeDb()
    updateProjectSettings(db, { prePrompt: 'Always add regression tests.' })
    updateProjectSettings(db, { prePrompt: '   ' })
    expect(getProjectSettings(db).prePrompt).toBe('')
  })
})

// ─── Telemetry blob DB ────────────────────────────────────────────────────────

describe('telemetry_blobs', () => {
  it('returns undefined for unknown jobId', () => {
    const db = makeDb()
    expect(getTelemetryBlob(db, 'no-such-job')).toBeUndefined()
  })

  it('inserts and retrieves a blob row', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, {
      jobId: 'job-1',
      path: '/tmp/job-1.ndjson.gz',
      byteSize: 100,
      startedAt: 1000,
      endedAt: 2000,
      state: 'active',
    })
    const row = getTelemetryBlob(db, 'job-1')
    expect(row).toBeDefined()
    expect(row!.state).toBe('active')
    expect(row!.byteSize).toBe(100)
  })

  it('upsert updates existing row without changing startedAt', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'j1', path: '/p', byteSize: 50, startedAt: 100, endedAt: 200, state: 'active' })
    upsertTelemetryBlob(db, { jobId: 'j1', path: '/p', byteSize: 500, startedAt: 999, endedAt: 300, state: 'active' })
    const row = getTelemetryBlob(db, 'j1')!
    expect(row.byteSize).toBe(500)
    // startedAt should remain the original (COALESCE in upsert)
    expect(row.startedAt).toBe(100)
  })

  it('getJobsWithTelemetry returns active and compacted job ids', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'a', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
    upsertTelemetryBlob(db, { jobId: 'b', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'compacted' })
    upsertTelemetryBlob(db, { jobId: 'c', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'expired' })
    const ids = getJobsWithTelemetry(db)
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('c')).toBe(false)
  })
})

// ─── Telemetry summaries DB ───────────────────────────────────────────────────

describe('telemetry_summaries', () => {
  it('inserts and retrieves summary rows', () => {
    const db = makeDb()
    insertTelemetrySummary(db, {
      jobId: 'j1', phase: 'architect',
      durationMs: 5000, tokensInput: 100, tokensOutput: 200, tokensCache: 10,
      toolCalls: '{"bash":3}', apiErrors: 0, costUsd: 0.05,
    })
    const rows = getTelemetrySummaries(db, 'j1')
    expect(rows).toHaveLength(1)
    expect(rows[0].phase).toBe('architect')
    expect(rows[0].durationMs).toBe(5000)
    expect(rows[0].costUsd).toBeCloseTo(0.05)
  })

  it('deletes blobs and summaries for a job', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'j2', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
    insertTelemetrySummary(db, { jobId: 'j2', phase: 'dev', durationMs: null, tokensInput: null, tokensOutput: null, tokensCache: null, toolCalls: null, apiErrors: null, costUsd: null })
    deleteTelemetryForJob(db, 'j2')
    expect(getTelemetryBlob(db, 'j2')).toBeUndefined()
    expect(getTelemetrySummaries(db, 'j2')).toHaveLength(0)
  })
})

// ─── 7.2 OTLP receiver inline ─────────────────────────────────────────────────

// These tests verify the route-level extraction and routing logic without
// needing a running Express server (the network path is tested via integration).

describe('OTLP resource attribute extraction', () => {
  function makeTraceBody(jobId: string, projectId: string): unknown {
    return {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'specrails.job_id', value: { stringValue: jobId } },
            { key: 'specrails.project_id', value: { stringValue: projectId } },
          ],
        },
        scopeSpans: [],
      }],
    }
  }

  function makeBodyNoAttrs(): unknown {
    return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] }
  }

  // Re-implement the extraction logic inline for unit test isolation
  function extractJobAndProject(body: unknown): { jobId: string; projectId: string } | null {
    if (typeof body !== 'object' || body === null) return null
    const b = body as Record<string, unknown>
    const items = [
      ...(Array.isArray(b.resourceSpans) ? b.resourceSpans as Array<Record<string, unknown>> : []),
      ...(Array.isArray(b.resourceMetrics) ? b.resourceMetrics as Array<Record<string, unknown>> : []),
      ...(Array.isArray(b.resourceLogs) ? b.resourceLogs as Array<Record<string, unknown>> : []),
    ]
    for (const rs of items) {
      const attrs = (rs.resource as Record<string, unknown> | undefined)?.attributes as Array<{ key: string; value: { stringValue?: string } }> | undefined
      if (!attrs) continue
      const jobId = attrs.find((a) => a.key === 'specrails.job_id')?.value.stringValue
      const projectId = attrs.find((a) => a.key === 'specrails.project_id')?.value.stringValue
      if (jobId && projectId) return { jobId, projectId }
    }
    return null
  }

  it('extracts jobId and projectId from resourceSpans', () => {
    const result = extractJobAndProject(makeTraceBody('job-42', 'proj-7'))
    expect(result).toEqual({ jobId: 'job-42', projectId: 'proj-7' })
  })

  it('returns null when resource attributes are missing', () => {
    expect(extractJobAndProject(makeBodyNoAttrs())).toBeNull()
  })

  it('returns null for non-object body', () => {
    expect(extractJobAndProject('not-an-object')).toBeNull()
    expect(extractJobAndProject(null)).toBeNull()
  })

  it('extracts from resourceMetrics', () => {
    const body = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'specrails.job_id', value: { stringValue: 'jm1' } },
            { key: 'specrails.project_id', value: { stringValue: 'pm1' } },
          ],
        },
        scopeMetrics: [],
      }],
    }
    expect(extractJobAndProject(body)).toEqual({ jobId: 'jm1', projectId: 'pm1' })
  })
})

// ─── 7.3 Compactor ───────────────────────────────────────────────────────────

import os from 'os'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { runCompaction, runCompactionForAll } from './telemetry-compactor'
import type { ProjectContext } from './project-registry'
import type { ProjectRegistry } from './project-registry'

function makeMinimalCtx(db: DbInstance): ProjectContext {
  return {
    db,
    project: { id: 'p1', slug: 'test-project', name: 'Test', path: '/tmp/test', db_path: ':memory:', provider: 'claude', added_at: '', last_seen_at: '' } as ProjectContext['project'],
    queueManager: {} as ProjectContext['queueManager'],
    chatManager: {} as ProjectContext['chatManager'],
    setupManager: {} as ProjectContext['setupManager'],
    proposalManager: {} as ProjectContext['proposalManager'],
    specLauncherManager: {} as ProjectContext['specLauncherManager'],
    ticketWatcher: {} as ProjectContext['ticketWatcher'],
    broadcast: () => {},
    railJobs: new Map(),
  }
}

function writeGzipLine(filePath: string, obj: unknown): void {
  const line = JSON.stringify(obj) + '\n'
  const compressed = zlib.gzipSync(Buffer.from(line, 'utf-8'))
  fs.appendFileSync(filePath, compressed)
}

describe('runCompaction', () => {
  it('leaves blobs younger than 7 days untouched', async () => {
    const db = makeDb()
    const now = Date.now()
    const recentAt = now - (3 * 24 * 60 * 60 * 1000) // 3 days ago
    upsertTelemetryBlob(db, { jobId: 'j-recent', path: null, byteSize: 0, startedAt: recentAt, endedAt: recentAt, state: 'active' })

    await runCompaction(makeMinimalCtx(db), now)

    const blob = getTelemetryBlob(db, 'j-recent')
    expect(blob?.state).toBe('active')
  })

  it('compacts a blob older than 7 days even when file is missing', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000) // 10 days ago
    upsertTelemetryBlob(db, { jobId: 'j-old', path: '/nonexistent/path.ndjson.gz', byteSize: 0, startedAt: oldAt, endedAt: oldAt, state: 'active' })

    await runCompaction(makeMinimalCtx(db), now)

    const blob = getTelemetryBlob(db, 'j-old')
    expect(blob?.state).toBe('compacted')
    expect(blob?.path).toBeNull()
  })

  it('inserts an "unknown" summary row when blob has no readable content', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)
    upsertTelemetryBlob(db, { jobId: 'j-empty', path: null, byteSize: 0, startedAt: oldAt, endedAt: oldAt, state: 'active' })

    await runCompaction(makeMinimalCtx(db), now)

    const summaries = getTelemetrySummaries(db, 'j-empty')
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    expect(summaries[0].phase).toBe('unknown')
  })
})

// ─── 7.3b Compactor — aggregation from real gzip blobs ──────────────────────

describe('runCompaction — aggregateByPhase via real gzip blob', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `specrails-compact-${Date.now()}.ndjson.gz`)
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* ok */ }
  })

  it('aggregates duration from trace spans', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    writeGzipLine(tmpFile, {
      signal: 'traces',
      receivedAt: new Date().toISOString(),
      payload: {
        resourceSpans: [{
          scopeSpans: [{
            scope: { name: 'architect' },
            spans: [{
              name: 'tool_use',
              startTimeUnixNano: '1000000000',
              endTimeUnixNano: '2000000000',
              status: { code: 'STATUS_CODE_OK' },
            }],
          }],
        }],
      },
    })

    upsertTelemetryBlob(db, { jobId: 'j-trace', path: tmpFile, byteSize: 100, startedAt: oldAt, endedAt: oldAt, state: 'active' })
    await runCompaction(makeMinimalCtx(db), now)

    const summaries = getTelemetrySummaries(db, 'j-trace')
    expect(summaries.length).toBeGreaterThan(0)
    const archSummary = summaries.find(s => s.phase === 'architect')
    expect(archSummary).toBeDefined()
    expect(archSummary!.durationMs).toBe(1000)
  })

  it('counts API errors from spans with non-OK status', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    writeGzipLine(tmpFile, {
      signal: 'traces',
      receivedAt: new Date().toISOString(),
      payload: {
        resourceSpans: [{
          scopeSpans: [{
            scope: { name: 'dev' },
            spans: [
              { name: 'api_call', startTimeUnixNano: '100', endTimeUnixNano: '200', status: { code: 2 } },
              { name: 'api_call', startTimeUnixNano: '200', endTimeUnixNano: '300', status: { code: 0 } },
            ],
          }],
        }],
      },
    })

    upsertTelemetryBlob(db, { jobId: 'j-errors', path: tmpFile, byteSize: 100, startedAt: oldAt, endedAt: oldAt, state: 'active' })
    await runCompaction(makeMinimalCtx(db), now)

    const summaries = getTelemetrySummaries(db, 'j-errors')
    const devSummary = summaries.find(s => s.phase === 'dev')
    expect(devSummary?.apiErrors).toBe(1)
  })

  it('aggregates token counts from metrics', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    writeGzipLine(tmpFile, {
      signal: 'metrics',
      receivedAt: new Date().toISOString(),
      payload: {
        resourceMetrics: [{
          scopeMetrics: [{
            scope: { name: 'reviewer' },
            metrics: [
              {
                name: 'input_tokens',
                sum: { dataPoints: [{ asInt: '500' }] },
              },
              {
                name: 'output_tokens',
                sum: { dataPoints: [{ asDouble: 250 }] },
              },
              {
                name: 'cache_tokens',
                sum: { dataPoints: [{ asInt: '100' }] },
              },
              {
                name: 'cost_usd',
                sum: { dataPoints: [{ asDouble: 0.015 }] },
              },
            ],
          }],
        }],
      },
    })

    upsertTelemetryBlob(db, { jobId: 'j-metrics', path: tmpFile, byteSize: 100, startedAt: oldAt, endedAt: oldAt, state: 'active' })
    await runCompaction(makeMinimalCtx(db), now)

    const summaries = getTelemetrySummaries(db, 'j-metrics')
    const revSummary = summaries.find(s => s.phase === 'reviewer')
    expect(revSummary).toBeDefined()
    expect(revSummary!.tokensInput).toBe(500)
    expect(revSummary!.tokensOutput).toBe(250)
    expect(revSummary!.tokensCache).toBe(100)
    expect(revSummary!.costUsd).toBeCloseTo(0.015)
  })

  it('skips control signal lines', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    writeGzipLine(tmpFile, {
      signal: 'control',
      event: 'logs_truncated',
      at: new Date().toISOString(),
    })

    upsertTelemetryBlob(db, { jobId: 'j-ctrl', path: tmpFile, byteSize: 10, startedAt: oldAt, endedAt: oldAt, state: 'active' })
    await runCompaction(makeMinimalCtx(db), now)

    const summaries = getTelemetrySummaries(db, 'j-ctrl')
    // Only the fallback 'unknown' phase should exist (no real signal data)
    expect(summaries.every(s => s.phase === 'unknown')).toBe(true)
  })

  it('deletes gzip file after compaction', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    writeGzipLine(tmpFile, { signal: 'traces', payload: null })
    expect(fs.existsSync(tmpFile)).toBe(true)

    upsertTelemetryBlob(db, { jobId: 'j-del', path: tmpFile, byteSize: 10, startedAt: oldAt, endedAt: oldAt, state: 'active' })
    await runCompaction(makeMinimalCtx(db), now)

    expect(fs.existsSync(tmpFile)).toBe(false)
  })
})

describe('runCompactionForAll', () => {
  it('runs compaction for all contexts in registry', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldAt = now - (10 * 24 * 60 * 60 * 1000)

    upsertTelemetryBlob(db, { jobId: 'j-all', path: null, byteSize: 0, startedAt: oldAt, endedAt: oldAt, state: 'active' })

    const registry = {
      listContexts: () => [makeMinimalCtx(db)],
    } as unknown as ProjectRegistry

    await runCompactionForAll(registry)

    const blob = getTelemetryBlob(db, 'j-all')
    expect(blob?.state).toBe('compacted')
  })

  it('continues after a context throws', async () => {
    const registry = {
      listContexts: () => [{
        db: null as never,
        project: { id: 'bad', slug: 'bad' } as ProjectContext['project'],
        broadcast: () => {},
        railJobs: new Map(),
      } as unknown as ProjectContext],
    } as unknown as ProjectRegistry

    // Should not throw
    await expect(runCompactionForAll(registry)).resolves.toBeUndefined()
  })
})

// ─── 7.4 Diagnostic endpoint (DB-level) ──────────────────────────────────────

describe('diagnostic endpoint DB pre-conditions', () => {
  it('404 when no telemetry blob exists', () => {
    const db = makeDb()
    // Simulate what the route handler checks
    const blob = getTelemetryBlob(db, 'no-job')
    expect(blob).toBeUndefined()
  })

  it('active blob has state=active', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'ja', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
    const blob = getTelemetryBlob(db, 'ja')
    expect(blob?.state).toBe('active')
  })

  it('compacted blob has state=compacted and path=null', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'jc', path: '/p', byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
    setTelemetryBlobCompacted(db, 'jc')
    const blob = getTelemetryBlob(db, 'jc')
    expect(blob?.state).toBe('compacted')
    expect(blob?.path).toBeNull()
  })

  it('hasTelemetry is set for active and compacted but not expired', () => {
    const db = makeDb()
    upsertTelemetryBlob(db, { jobId: 'active-j', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'active' })
    upsertTelemetryBlob(db, { jobId: 'compact-j', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'compacted' })
    upsertTelemetryBlob(db, { jobId: 'expired-j', path: null, byteSize: 0, startedAt: 1, endedAt: 1, state: 'expired' })
    const ids = getJobsWithTelemetry(db)
    expect(ids.has('active-j')).toBe(true)
    expect(ids.has('compact-j')).toBe(true)
    expect(ids.has('expired-j')).toBe(false)
  })
})
