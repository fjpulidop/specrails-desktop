/**
 * Diagnostics — pure domain.
 *
 * Vocabulary and rules behind three resilience features:
 * - crash markers the desktop host leaves when the server sidecar exits
 *   unexpectedly (written by `src-tauri/src/sidecar_supervisor.rs`), and which of
 *   them the interface has not explained yet;
 * - event-loop stalls measured by the server's own probe;
 * - the "Report a problem" bundle: which files it contains and what each holds.
 *
 * No IO and no imports. Redaction is injected (`TextRedactor`) so the rules
 * that assemble a report stay testable with any redactor.
 */

// ─── Crash markers ───────────────────────────────────────────────────────────

export type CrashOutcome = 'restarted' | 'stopped'

/** One unexpected sidecar exit, as written by the desktop host (schema version 1). */
export interface CrashMarker {
  version: number
  id: string
  atMs: number
  at: string
  pid: number
  exitCode: number | null
  signal: number | null
  uptimeMs: number
  wasReady: boolean
  outcome: CrashOutcome
  recentRestarts: number
  maxRestarts: number
  windowSecs: number
  /** Raw stderr. Never shown or exported without redaction. */
  stderrTail: string[]
}

/** What the interface shows about a crash: no stderr, no paths. */
export interface CrashNotice {
  id: string
  atMs: number
  outcome: CrashOutcome
  exitCode: number | null
  signal: number | null
  uptimeMs: number
  wasReady: boolean
  recentRestarts: number
  maxRestarts: number
}

const MAX_TAIL_LINES = 200
const MAX_TAIL_LINE = 4_000

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** Validate a marker read from disk; anything malformed is ignored, never trusted. */
export function parseCrashMarker(raw: unknown): CrashMarker | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const atMs = int(value.atMs)
  const pid = int(value.pid)
  if (typeof value.id !== 'string' || !/^[0-9]{1,16}-[0-9]{1,10}$/.test(value.id)) return null
  if (atMs === null || atMs <= 0 || pid === null) return null
  if (value.outcome !== 'restarted' && value.outcome !== 'stopped') return null
  const tail = Array.isArray(value.stderrTail) ? value.stderrTail : []
  return {
    version: int(value.version) ?? 1,
    id: value.id,
    atMs,
    at: typeof value.at === 'string' ? value.at.slice(0, 40) : new Date(atMs).toISOString(),
    pid,
    exitCode: int(value.exitCode),
    signal: int(value.signal),
    uptimeMs: Math.max(0, int(value.uptimeMs) ?? 0),
    wasReady: value.wasReady === true,
    outcome: value.outcome,
    recentRestarts: Math.max(0, int(value.recentRestarts) ?? 0),
    maxRestarts: Math.max(0, int(value.maxRestarts) ?? 0),
    windowSecs: Math.max(0, int(value.windowSecs) ?? 0),
    stderrTail: tail.filter((line): line is string => typeof line === 'string').slice(-MAX_TAIL_LINES).map(line => line.slice(0, MAX_TAIL_LINE)),
  }
}

/** Oldest first. */
export function sortCrashMarkers(markers: CrashMarker[]): CrashMarker[] {
  return [...markers].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))
}

export function toCrashNotice(marker: CrashMarker): CrashNotice {
  const { id, atMs, outcome, exitCode, signal, uptimeMs, wasReady, recentRestarts, maxRestarts } = marker
  return { id, atMs, outcome, exitCode, signal, uptimeMs, wasReady, recentRestarts, maxRestarts }
}

/** Markers newer than the acknowledgement, oldest first. */
export function unacknowledgedCrashes(markers: CrashMarker[], acknowledgedThroughMs: number): CrashNotice[] {
  return sortCrashMarkers(markers).filter(marker => marker.atMs > acknowledgedThroughMs).map(toCrashNotice)
}

/** An acknowledgement only moves forward and never past the newest known marker. */
export function nextAcknowledgement(current: number, requested: unknown, markers: CrashMarker[]): number {
  const wanted = int(requested)
  if (wanted === null || wanted <= current) return current
  const newest = markers.reduce((max, marker) => Math.max(max, marker.atMs), 0)
  return Math.max(current, Math.min(wanted, newest))
}

// ─── Event-loop stalls ───────────────────────────────────────────────────────

export interface StallRecord {
  /** Epoch ms when the stall was observed (its end). */
  atMs: number
  durationMs: number
  /** The request whose synchronous work blocked the loop, when one did. */
  operation: string | null
  /** Event-loop utilization of the window that contained the stall (0..1). */
  utilization: number | null
}

export interface StallSnapshot {
  thresholdMs: number
  /** Whether fine-grained delay sampling is currently armed (it is off while idle). */
  sampling: boolean
  sinceMs: number
  total: number
  longestMs: number
  /** Newest first, bounded. */
  recent: StallRecord[]
}

export const DEFAULT_STALL_THRESHOLD_MS = 200
export const MAX_RECENT_STALLS = 50

/** Append a stall, keeping the newest `max` (oldest dropped). */
export function appendStall(stalls: StallRecord[], stall: StallRecord, max = MAX_RECENT_STALLS): StallRecord[] {
  const next = [...stalls, stall]
  return next.length > max ? next.slice(next.length - max) : next
}

const ID_SEGMENT = /^(?:[0-9]+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{21,})$/i

/**
 * A request as a short, non-identifying label: method plus path without query
 * string, with ids, hashes and long tokens replaced by `:id`.
 */
export function operationLabel(method: string, url: string): string {
  const path = (url.split(/[?#]/)[0] ?? '/').slice(0, 512)
  const segments = path.split('/').map(segment => {
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch { /* keep raw */ }
    return ID_SEGMENT.test(decoded) ? ':id' : decoded.replace(/[^\w.:@-]/g, '_').slice(0, 48)
  })
  return `${method.toUpperCase().slice(0, 8)} ${segments.join('/') || '/'}`
}

// ─── Redaction helpers ───────────────────────────────────────────────────────

export type TextRedactor = (text: string) => string

export const REDACTED = '[REDACTED]'

/** Keys whose values never leave the machine, at any depth of a settings value. */
const SECRET_KEY = /(?:passw(?:or)?d|passphrase|secret|token(?!s|iz)|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?:orization)?$|cookie|session[_-]?(?:token|key|secret)|^env$|^environment$|^headers?$|webhook)/i

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))
}

/**
 * `"apiKey": "v"` / `"github_token":"v"` inside free text (JSON log lines): the
 * value of a quoted secret-named field. Prose redaction only covers `name=value`.
 */
const QUOTED_SECRET_FIELD = /("[A-Za-z0-9_.-]{0,64}(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|passphrase|access[_-]?key|private[_-]?key|credentials?|authorization|cookie)"\s*:\s*)"(?:[^"\\\n]|\\.){0,4096}"/gi

export function redactQuotedSecretFields(text: string): string {
  return text.replace(QUOTED_SECRET_FIELD, (_match, prefix: string) => `${prefix}"${REDACTED}"`)
}

/**
 * Deep copy of a JSON-like value with secret-named entries replaced and every
 * other string passed through `redact`. Depth is bounded.
 */
export function redactStructured(value: unknown, redact: TextRedactor, depth = 0): unknown {
  if (typeof value === 'string') return redact(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 16) return REDACTED
  if (Array.isArray(value)) return value.map(item => redactStructured(item, redact, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? (item === null || item === '' ? item : REDACTED) : redactStructured(item, redact, depth + 1)
  }
  return out
}

/** `desktop_settings` rows → one object; JSON values are parsed so nested secrets are found. */
export function redactSettings(rows: Array<{ key: string; value: string }>, redact: TextRedactor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, value } of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
    if (isSecretKey(key)) { out[key] = REDACTED; continue }
    let parsed: unknown = value
    try { parsed = JSON.parse(value) } catch { /* plain text value */ }
    out[key] = redactStructured(parsed, redact)
  }
  return out
}

// ─── Log tails ───────────────────────────────────────────────────────────────

/** The last `maxBytes` (UTF-16 units) of `text`, starting at a line boundary. */
export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(text.length - maxChars)
  const newline = cut.indexOf('\n')
  return newline >= 0 ? cut.slice(newline + 1) : cut
}

/** Sidecar log lines that come from stderr, the host or an exit (stdout chatter dropped). */
export function sidecarStderrLines(log: string): string {
  return log.split('\n').filter(line => /\[(?:ERR|EXIT|TAURI_ERR|HOST)\]/.test(line)).join('\n')
}

// ─── Problem report ──────────────────────────────────────────────────────────

export interface ReportVersions {
  app: string | null
  core: string | null
  api: number | string | null
  contractSchema: number | string | null
}

export interface ReportSystem {
  platform: string
  release: string
  arch: string
  node: string
  uptimeSec: number
  rssBytes: number
  cpuCount: number
  totalMemoryBytes: number
}

/** Raw material for a report. Everything textual is redacted by `buildReportFiles`. */
export interface ReportSources {
  createdAtMs: number
  versions: ReportVersions
  system: ReportSystem
  desktopHost: boolean
  projectCount: number
  settings: Array<{ key: string; value: string }>
  serverLog: string
  sidecarLog: string | null
  desktopLog: string | null
  crashes: CrashMarker[]
  stalls: StallSnapshot
}

export interface ReportFile {
  name: string
  /** One line saying what the file is (shown in the preview). */
  description: string
  content: string
}

/** Per-file cap: a report stays small enough to read in the preview. */
export const MAX_REPORT_FILE_CHARS = 512 * 1024

export function reportFileName(createdAtMs: number): string {
  const stamp = new Date(createdAtMs).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `specrails-report-${stamp}.zip`
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * The exact files of a report, already redacted. The preview shows these
 * strings and the ZIP stores the same strings, so what the person reads is
 * what they save.
 */
export function buildReportFiles(sources: ReportSources, redact: TextRedactor): ReportFile[] {
  const clean = (text: string) => tailText(redactQuotedSecretFields(redact(text)), MAX_REPORT_FILE_CHARS)
  const files: ReportFile[] = []
  const crashes = sortCrashMarkers(sources.crashes).map(marker => ({ ...marker, stderrTail: marker.stderrTail.map(line => redact(line)) }))

  files.push({
    name: 'system.json',
    description: 'App and Core versions, operating system, Node runtime and memory.',
    content: clean(json({
      createdAt: new Date(sources.createdAtMs).toISOString(),
      versions: sources.versions,
      system: sources.system,
      desktopHost: sources.desktopHost,
      projectCount: sources.projectCount,
    })),
  })
  files.push({
    name: 'settings.json',
    description: 'App settings. Tokens, keys, passwords, environment values and headers are removed.',
    content: clean(json(redactSettings(sources.settings, redact))),
  })
  files.push({
    name: 'server.log',
    description: 'Output of the running local server since it started.',
    content: clean(sources.serverLog || '(no output yet)\n'),
  })
  if (sources.sidecarLog !== null) {
    files.push({
      name: 'sidecar-stderr.log',
      description: 'Recent error output of the local server, including earlier runs that stopped.',
      content: clean(sidecarStderrLines(sources.sidecarLog) || '(no error output)\n'),
    })
  }
  if (sources.desktopLog !== null) {
    files.push({
      name: 'desktop.log',
      description: 'Desktop app events: server starts, exits and automatic restarts.',
      content: clean(sources.desktopLog || '(empty)\n'),
    })
  }
  files.push({
    name: 'crashes.json',
    description: 'Times the local server stopped unexpectedly, with its last error lines.',
    content: clean(json(crashes)),
  })
  files.push({
    name: 'stalls.json',
    description: 'Moments the local server was unresponsive (event-loop stalls).',
    content: clean(json(sources.stalls)),
  })
  files.unshift({
    name: 'README.txt',
    description: 'What this report is and what each file contains.',
    content: [
      'Specrails problem report',
      `Created: ${new Date(sources.createdAtMs).toISOString()}`,
      '',
      'This file was created on your computer and was not sent anywhere.',
      'Share it only with someone helping you with a problem.',
      'Tokens, keys, passwords and credentials in URLs are replaced with [REDACTED],',
      'and your home folder is shown as ~. Review the files before sharing.',
      '',
      'Contents:',
      ...files.map(file => `- ${file.name}: ${file.description}`),
      '',
    ].join('\n'),
  })
  return files
}
