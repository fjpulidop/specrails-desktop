import fs from 'fs'
import path from 'path'
import os from 'os'
import zlib from 'zlib'
import { Router, Request, Response } from 'express'
import type { ProjectRegistry } from './project-registry'
import { getJob } from './db'
import { getTelemetryBlob, upsertTelemetryBlob } from './db'

// 10 MB uncompressed cap per job blob
const BLOB_SIZE_CAP = 10 * 1024 * 1024
// B2: the soft cap above only dropped `logs`, so traces/metrics could grow a
// per-job blob without bound (disk-fill DoS). This hard cap bounds the TOTAL
// blob across ALL signals while still letting traces/metrics outlive logs.
const BLOB_HARD_CAP = 50 * 1024 * 1024

// Bounded in-memory append queue per (projectId, jobId) key — protects the
// Express event loop from a burst of OTLP payloads all trying to gzip-append
// simultaneously. Drops events (with a warning) when the queue exceeds this.
const QUEUE_CAP = 10_000

// ─── Types ────────────────────────────────────────────────────────────────────

type OtlpSignal = 'traces' | 'metrics' | 'logs'

interface OtlpAttribute {
  key: string
  value: { stringValue?: string; intValue?: string | number; [k: string]: unknown }
}

interface OtlpResourceSpans {
  resource?: {
    attributes?: OtlpAttribute[]
  }
  [k: string]: unknown
}

// ─── Per-blob write state ─────────────────────────────────────────────────────

interface BlobState {
  /** Accumulated uncompressed byte count for cap enforcement */
  uncompressedSize: number
  /** True once we have written the logs_truncated control marker */
  truncationMarkerWritten: boolean
  /** Bounded queue of pending write tasks */
  queue: Array<() => void>
  /** Whether a write is currently in-flight */
  writing: boolean
}

const _blobState = new Map<string, BlobState>()

function getBlobState(key: string): BlobState {
  let s = _blobState.get(key)
  if (!s) {
    s = { uncompressedSize: 0, truncationMarkerWritten: false, queue: [], writing: false }
    _blobState.set(key, s)
  }
  return s
}

function blobKey(projectId: string, jobId: string): string {
  return `${projectId}:${jobId}`
}

/**
 * Await full append-queue quiescence (every blob: idle writer + empty queue).
 * Test seam: the ingest handler ACKs 200 while queued gzip appends are still
 * in flight; a suite that removes the telemetry dir in afterEach races them —
 * the orphaned append then console.errors DURING vitest environment teardown
 * ("Closing rpc while onUserConsoleLog was pending", flaked in CI 2026-07-27).
 * Bounded so a wedged writer can never hang a suite.
 */
export async function awaitTelemetryAppendQuiescence(maxWaitMs = 2000): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  const busy = (): boolean => {
    for (const state of _blobState.values()) {
      if (state.writing || state.queue.length > 0) return true
    }
    return false
  }
  while (busy() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Evict the in-memory BlobState for one job (bounds the per-(project,job) leak —
 *  the map otherwise grew for the whole process lifetime). */
export function dropBlobState(projectId: string, jobId: string): void {
  _blobState.delete(blobKey(projectId, jobId))
}

/** Evict every BlobState belonging to a project (called on project removal). */
export function dropBlobStatesForProject(projectId: string): void {
  const prefix = `${projectId}:`
  for (const key of _blobState.keys()) {
    if (key.startsWith(prefix)) _blobState.delete(key)
  }
}

// ─── Blob path ────────────────────────────────────────────────────────────────

function telemetryDir(projectSlug: string): string {
  return path.join(os.homedir(), '.specrails', 'projects', projectSlug, 'telemetry')
}

function blobPath(projectSlug: string, jobId: string): string {
  return path.join(telemetryDir(projectSlug), `${jobId}.ndjson.gz`)
}

// ─── Extract resource attributes ─────────────────────────────────────────────

function extractAttr(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  if (!attributes) return undefined
  const attr = attributes.find((a) => a.key === key)
  if (!attr) return undefined
  const v = attr.value
  if (typeof v.stringValue === 'string') return v.stringValue
  if (v.intValue != null) return String(v.intValue)
  return undefined
}

function extractJobAndProject(body: unknown): { jobId: string; projectId: string } | null {
  if (typeof body !== 'object' || body === null) return null

  // OTLP/JSON: resourceSpans | resourceMetrics | resourceLogs
  const b = body as Record<string, unknown>
  const resourceItems: OtlpResourceSpans[] = [
    ...(Array.isArray(b.resourceSpans) ? b.resourceSpans as OtlpResourceSpans[] : []),
    ...(Array.isArray(b.resourceMetrics) ? b.resourceMetrics as OtlpResourceSpans[] : []),
    ...(Array.isArray(b.resourceLogs) ? b.resourceLogs as OtlpResourceSpans[] : []),
  ]

  for (const rs of resourceItems) {
    const attrs = rs.resource?.attributes
    const jobId = extractAttr(attrs, 'specrails.job_id')
    const projectId = extractAttr(attrs, 'specrails.project_id')
    if (jobId && projectId) return { jobId, projectId }
  }
  return null
}

// ─── Gzip append ─────────────────────────────────────────────────────────────

function appendToGzip(filePath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(line + '\n', 'utf-8')
    // Append a gzip member to the file. gzip is a concatenated format:
    // a reader decompresses member by member, giving correct NDJSON.
    const gz = zlib.createGzip()
    const chunks: Buffer[] = []
    gz.on('data', (c: Buffer) => chunks.push(c))
    gz.on('end', () => {
      const compressed = Buffer.concat(chunks)
      fs.appendFile(filePath, compressed, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    gz.on('error', reject)
    gz.end(data)
  })
}

// ─── Enqueue write task ───────────────────────────────────────────────────────

function enqueueWrite(state: BlobState, task: () => Promise<void>): void {
  if (state.queue.length >= QUEUE_CAP) {
    // Drop with a warning — we don't want to stall the event loop
    console.warn('[telemetry-receiver] append queue full — dropping telemetry event')
    return
  }

  const wrappedTask = (): void => {
    task().then(drain, drain)
  }

  function drain(): void {
    state.writing = false
    const next = state.queue.shift()
    if (next) {
      state.writing = true
      next()
    }
  }

  state.queue.push(wrappedTask)
  if (!state.writing) {
    state.writing = true
    const next = state.queue.shift()!
    next()
  }
}

// ─── Ingest handler ───────────────────────────────────────────────────────────

async function handleIngest(
  signal: OtlpSignal,
  body: unknown,
  registry: ProjectRegistry,
  res: Response
): Promise<void> {
  const ids = extractJobAndProject(body)
  if (!ids) {
    res.status(400).json({ error: 'Missing specrails.job_id or specrails.project_id in resource.attributes' })
    return
  }

  const { jobId, projectId } = ids

  const projectCtx = registry.getContext(projectId)
  if (!projectCtx) {
    res.status(404).json({ error: 'Project not found' })
    return
  }

  const { db, project } = projectCtx
  const job = getJob(db, jobId)
  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }

  const key = blobKey(projectId, jobId)
  const state = getBlobState(key)
  const filePath = blobPath(project.slug, jobId)
  const now = Date.now()

  // Cap enforcement: drop logs once the 10 MB soft cap is reached (B2: and drop
  // ANY signal — traces/metrics included — once the 50 MB hard cap is reached, so
  // a job streaming endless spans can't fill the disk).
  if (state.uncompressedSize >= BLOB_HARD_CAP || (state.uncompressedSize >= BLOB_SIZE_CAP && signal === 'logs')) {
    res.status(200).json({ ok: true, dropped: true })
    return
  }

  // Determine raw line size for cap tracking (uncompressed JSON length)
  const payloadStr = JSON.stringify(body)
  const lineObj = { signal, receivedAt: new Date().toISOString(), payload: body }
  const lineStr = JSON.stringify(lineObj)
  const lineSize = Buffer.byteLength(lineStr, 'utf-8')

  // Ensure directory and blob pointer row exist before we enqueue the write
  const dir = telemetryDir(project.slug)
  fs.mkdirSync(dir, { recursive: true })

  const existingBlob = getTelemetryBlob(db, jobId)
  if (!existingBlob) {
    // Create the pointer row at byteSize=0; the real size is advanced only once
    // the bytes actually land on disk (inside the enqueued task below).
    upsertTelemetryBlob(db, {
      jobId,
      path: filePath,
      byteSize: 0,
      startedAt: now,
      endedAt: now,
      state: 'active',
    })
  }
  const blobStartedAt = existingBlob?.startedAt ?? now

  // BUG-WEBHOOK-03: advance `state.uncompressedSize` and the DB `byteSize` ONLY
  // after `appendToGzip` actually lands the bytes. Doing it synchronously here
  // over-reported byteSize whenever the async append later rejected (ENOSPC /
  // EACCES) — the swallowed rejection left the counter advanced as though the
  // bytes had been written. We now compute the cap decision and bump the size
  // inside the enqueued task so a failed append leaves the size untouched.
  enqueueWrite(state, async () => {
    // Re-evaluate the cap against the CURRENT (post-prior-writes) size, since
    // several requests may have enqueued before this task runs.
    const prevSize = state.uncompressedSize
    const willExceedCap = prevSize + lineSize > BLOB_SIZE_CAP

    if (willExceedCap && signal === 'logs' && !state.truncationMarkerWritten) {
      // Write the truncation marker once, before dropping this log event
      const marker = JSON.stringify({ signal: 'control', event: 'logs_truncated', at: new Date().toISOString() })
      await appendToGzip(filePath, marker)
      // Mark only after the marker actually landed.
      state.truncationMarkerWritten = true
    }

    // Drop further logs after cap
    if (prevSize >= BLOB_SIZE_CAP && signal === 'logs') return

    try {
      await appendToGzip(filePath, lineStr)
    } catch (err) {
      // The bytes did NOT land — do NOT advance uncompressedSize/byteSize, so
      // the counter and the DB row keep reflecting real on-disk content.
      console.error('[telemetry-receiver] append failed — not advancing byteSize:', err)
      return
    }

    // Only now that the append resolved do we advance the size + DB byteSize.
    state.uncompressedSize += lineSize
    upsertTelemetryBlob(db, {
      jobId,
      path: filePath,
      byteSize: state.uncompressedSize,
      startedAt: blobStartedAt,
      endedAt: Date.now(),
      state: 'active',
    })
  })

  // Suppress unused-variable warning for payloadStr — it's used above for size calc
  void payloadStr

  res.status(200).json({ ok: true })
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createTelemetryRouter(registry: ProjectRegistry): Router {
  const router = Router()

  const handle = (signal: OtlpSignal) =>
    (req: Request, res: Response): void => {
      handleIngest(signal, req.body, registry, res).catch((err) => {
        console.error(`[telemetry-receiver] error handling ${signal}:`, err)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' })
        }
      })
    }

  router.post('/v1/traces', handle('traces'))
  router.post('/v1/metrics', handle('metrics'))
  router.post('/v1/logs', handle('logs'))

  return router
}
