import fs from 'fs'
import path from 'path'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { newId as uuidv4 } from './ids'
import { windowsSpawnEnv } from './util/win-spawn'
import type { WebSocket } from 'ws'
import type { DbInstance } from './db'
import { OscParser, type OscMarkEvent } from './terminal-osc-parser'
import {
  appendMark,
  closeOpenMark,
  markOpenAsKilled,
  getOpenMark,
} from './terminal-marks-store'
import {
  composeShellIntegrationSpawn,
  cleanupSessionShim,
  type ShellIntegrationSpawn,
} from './terminal-shell-integration'
import type { TerminalSettings } from './terminal-settings'

export const TERMINAL_SCROLLBACK_BYTES = 262_144
export const TERMINAL_KILL_GRACE_MS = 2_000
export const TERMINAL_MAX_PER_PROJECT = 10
export const TERMINAL_NAME_MAX = 64
export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
const WS_OPEN = 1

// ─── Spawn-helper permission fix ──────────────────────────────────────────────
// node-pty's prebuilds occasionally lose the executable bit during npm extraction
// on some systems. Best-effort chmod so the first Terminal spawn does not fail
// with `posix_spawnp failed`.
function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ptyPkgPath = require.resolve('node-pty/package.json')
    const ptyPkgDir = path.dirname(ptyPkgPath)
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
    const platform = process.platform
    const helperPath = path.join(ptyPkgDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
    if (fs.existsSync(helperPath)) {
      const stat = fs.statSync(helperPath)
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(helperPath, 0o755)
      }
    }
  } catch {
    // Best effort only — if the helper is missing or unreachable, node-pty will
    // surface a clearer error on the first spawn call.
  }
}
ensureSpawnHelperExecutable()

// ─── Shell resolution ─────────────────────────────────────────────────────────

export function resolveShell(): string {
  return resolveShellFor(
    process.platform,
    process.env,
    (p) => { try { return fs.existsSync(p) } catch { return false } },
  )
}

/**
 * Pure, injectable shell resolver (testable on any platform).
 * Order: explicit `$SHELL` → platform default.
 * On Windows the default prefers PowerShell over cmd.exe: PowerShell 7 (`pwsh.exe`
 * on PATH) → Windows PowerShell (`powershell.exe`, always present on Win10/11 at a
 * known absolute path) → `COMSPEC`/cmd.exe as a last resort. cmd.exe is a poor
 * default and has no shell-integration shim.
 */
export function resolveShellFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string {
  // Honor $SHELL only on POSIX. On Windows $SHELL is not native but is commonly
  // exported by Git Bash/MSYS2 as a Unix path (e.g. /usr/bin/bash) that ConPTY
  // cannot spawn — so on win32 ignore it and fall through to pwsh→powershell→cmd.
  const envShell = env.SHELL?.trim()
  if (platform !== 'win32' && envShell && exists(envShell)) return envShell
  if (platform === 'win32') {
    for (const dir of (env.PATH ?? '').split(';')) {
      if (!dir) continue
      const pwsh = `${dir.replace(/[\\/]$/, '')}\\pwsh.exe`
      if (exists(pwsh)) return pwsh
    }
    const sysRoot = (env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
    const winPosh = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    if (exists(winPosh)) return winPosh
    return env.COMSPEC || 'cmd.exe'
  }
  // POSIX: existence-gate the fallback chain. A host without /bin/zsh (most
  // Linux) would otherwise get an unspawnable shell. /bin/sh is POSIX-mandated.
  for (const candidate of ['/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    if (exists(candidate)) return candidate
  }
  return '/bin/sh'
}

export function shellArgs(shell: string): string[] {
  // Normalize so Windows paths (C:\foo\bar.exe) work even when running cross-platform tests.
  const normalized = shell.replace(/\\/g, '/')
  const base = path.posix.basename(normalized).toLowerCase()
  if (base === 'zsh' || base === 'bash') return ['-l', '-i']
  if (base === 'fish') return ['-i']
  if (base === 'powershell.exe' || base === 'pwsh' || base === 'pwsh.exe' || base === 'powershell') return ['-NoLogo']
  if (base === 'cmd.exe' || base === 'cmd') return []
  return ['-i']
}

// ─── Ring buffer ──────────────────────────────────────────────────────────────

export class RingBuffer {
  private chunks: Buffer[] = []
  private total = 0
  constructor(readonly capacity: number) {}
  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.total += chunk.length
    // Drop whole chunks from the front until we fit (except the last, which we trim)
    while (this.total > this.capacity && this.chunks.length > 1) {
      const drop = this.chunks.shift() as Buffer
      this.total -= drop.length
    }
    if (this.total > this.capacity && this.chunks.length === 1) {
      const head = this.chunks[0]
      const excess = this.total - this.capacity
      this.chunks[0] = head.subarray(excess)
      this.total = this.chunks[0].length
    }
  }
  snapshot(): Buffer {
    if (this.total === 0) return Buffer.alloc(0)
    return Buffer.concat(this.chunks, this.total)
  }
  size(): number { return this.total }
  clear(): void { this.chunks = []; this.total = 0 }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TerminalSessionMeta {
  id: string
  projectId: string
  name: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
}

interface TerminalSession extends TerminalSessionMeta {
  pty: IPty
  buffer: RingBuffer
  clients: Set<WebSocket>
  killTimer?: NodeJS.Timeout
  exited: boolean
  /** Per-session OSC parser; only present when shell integration is enabled. */
  oscParser: OscParser | null
  /** Latest CWD reported by OSC 1337 (used for "Open this directory" UI). */
  currentCwd: string | null
  /** Project slug for shim cleanup. */
  projectSlug: string
  /** Project DB for command-mark persistence. Optional — when null, marks only broadcast. */
  projectDb: DbInstance | null
  /** Shell-integration spawn metadata (for cleanup). */
  shellIntegration: ShellIntegrationSpawn
}

export class TerminalLimitExceededError extends Error {
  readonly limit = TERMINAL_MAX_PER_PROJECT
  constructor() { super('terminal_limit_exceeded'); this.name = 'TerminalLimitExceededError' }
}
export class TerminalNotFoundError extends Error {
  constructor() { super('terminal_not_found'); this.name = 'TerminalNotFoundError' }
}
export class TerminalNameInvalidError extends Error {
  constructor() { super('terminal_name_invalid'); this.name = 'TerminalNameInvalidError' }
}
/** Thrown when node-pty fails to spawn the shell (e.g. the host is out of file
 *  descriptors). Lets the REST layer return a concrete, actionable error instead
 *  of an opaque 500. */
export class TerminalSpawnError extends Error {
  constructor(readonly reason: 'spawn-failed' | 'out-of-file-descriptors', detail?: string) {
    super(`terminal_spawn_failed:${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'TerminalSpawnError'
  }
}

/** Map a node-pty spawn exception to a typed TerminalSpawnError. EMFILE/ENFILE
 *  (the host is out of file descriptors — the failure mode that broke terminals
 *  under the chokidar fd leak) get a distinct reason the client can act on. */
export function mapSpawnError(err: unknown): TerminalSpawnError {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'EMFILE' || e?.code === 'ENFILE') {
    return new TerminalSpawnError('out-of-file-descriptors', e.message)
  }
  return new TerminalSpawnError('spawn-failed', e?.message ?? String(err))
}

/** Short-lived record of a session that already exited, so a WS that attaches
 *  just after an immediate/early exit can be told WHY instead of seeing a bare
 *  404 / silent dead terminal. Keyed by sessionId, evicted after a TTL. */
interface SessionTombstone {
  projectId: string
  exitedAt: number
  code: number | null
  signal: number | null
  /** True when the shell died within the early-exit window (a likely failed
   *  spawn rather than a user-initiated `exit`). */
  early: boolean
}

/** A session that exits within this window of being created is treated as an
 *  "early exit" (probable failed spawn — e.g. no controlling tty under fd
 *  pressure) so the client can surface a clear failure instead of a blank pane. */
export const TERMINAL_EARLY_EXIT_MS = 1_500
const TOMBSTONE_TTL_MS = 30_000

// ─── Manager ──────────────────────────────────────────────────────────────────

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private byProject = new Map<string, Set<string>>()
  private tombstones = new Map<string, SessionTombstone>()
  private tombstoneTimers = new Map<string, NodeJS.Timeout>()

  listForProject(projectId: string): TerminalSessionMeta[] {
    const set = this.byProject.get(projectId)
    if (!set) return []
    const out: TerminalSessionMeta[] = []
    for (const id of set) {
      const s = this.sessions.get(id)
      if (s) out.push(this.toMeta(s))
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Scoped lookup: returns session only if both id AND projectId match. */
  get(projectId: string, sessionId: string): TerminalSession | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    if (s.projectId !== projectId) return undefined
    return s
  }

  /** Unscoped lookup — used by the WS upgrade handler to validate cross-project access. */
  getUnsafe(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  create(
    projectId: string,
    opts: {
      cwd: string
      cols?: number
      rows?: number
      name?: string
      /** Project slug — used to scope shell-integration shim files. */
      projectSlug?: string
      /** Project DB — when provided, completed command marks are persisted here. */
      projectDb?: DbInstance | null
      /** Resolved terminal settings (shell-integration toggle is the only field consumed today). */
      settings?: Pick<TerminalSettings, 'shellIntegrationEnabled'>
    },
  ): TerminalSessionMeta {
    const currentCount = this.byProject.get(projectId)?.size ?? 0
    if (currentCount >= TERMINAL_MAX_PER_PROJECT) throw new TerminalLimitExceededError()

    const shell = resolveShell()
    const baseArgs = shellArgs(shell)
    const cols = clampDim(opts.cols ?? TERMINAL_DEFAULT_COLS, 2, 1000)
    const rows = clampDim(opts.rows ?? TERMINAL_DEFAULT_ROWS, 2, 1000)
    // Build the PTY env from a SystemRoot-backfilled base so PowerShell/cmd can
    // start even when the packaged sidecar inherited a stripped env (no
    // SystemRoot/ComSpec → ConPTY spawn fails and the panel never opens). No-op
    // on POSIX. (process.env is also backfilled globally at startup; this is the
    // explicit guard at the PTY boundary.)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(windowsSpawnEnv(process.env))) {
      if (typeof v === 'string') env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    const id = uuidv4()
    const projectSlug = opts.projectSlug ?? projectId

    // Shell-integration: compose extra args/env when the resolved settings allow it.
    const shellIntegration = composeShellIntegrationSpawn(
      shell,
      id,
      projectSlug,
      opts.settings ?? { shellIntegrationEnabled: false },
    )
    for (const [k, v] of Object.entries(shellIntegration.env)) env[k] = v
    const args = shellIntegration.args.length > 0
      ? [...shellIntegration.args, ...baseArgs]
      : baseArgs

    let pty: IPty
    try {
      pty = ptySpawn(shell, args, {
        cwd: opts.cwd,
        cols, rows,
        env,
        name: 'xterm-256color',
      })
    } catch (err) {
      throw mapSpawnError(err)
    }

    const name = validateName(opts.name) ?? this.autoName(projectId, shell)

    const session: TerminalSession = {
      id, projectId, name, shell, cwd: opts.cwd, cols, rows,
      createdAt: Date.now(),
      pty, buffer: new RingBuffer(TERMINAL_SCROLLBACK_BYTES),
      clients: new Set<WebSocket>(),
      exited: false,
      oscParser: shellIntegration.shimPath ? new OscParser() : null,
      currentCwd: null,
      projectSlug,
      projectDb: opts.projectDb ?? null,
      shellIntegration,
    }

    pty.onData((chunk: string) => {
      const buf = Buffer.from(chunk, 'utf8')
      session.buffer.append(buf)
      // Forward bytes to attached clients (binary, untouched).
      for (const ws of session.clients) {
        if (ws.readyState === WS_OPEN) {
          try { ws.send(buf, { binary: true }) } catch { /* ignore */ }
        }
      }
      // Then optionally parse for OSC marks and broadcast structured frames.
      if (session.oscParser) {
        const events = session.oscParser.feed(buf)
        if (events.length > 0) this.handleMarkEvents(session, events)
      }
    })
    pty.onExit((e: { exitCode: number; signal?: number }) => {
      session.exited = true
      const now = Date.now()
      const early = now - session.createdAt < TERMINAL_EARLY_EXIT_MS
      // Any open mark gets recorded as killed.
      if (session.projectDb) {
        try { markOpenAsKilled(session.projectDb, session.id, now) } catch { /* ignore */ }
      }
      // Record a tombstone unless this is a deliberate kill (killSession removes
      // the session from the registry first, so `!this.sessions.has` distinguishes
      // an unexpected pty death from an intentional kill).
      if (this.sessions.has(session.id)) {
        this.recordTombstone(session.id, session.projectId, e?.exitCode ?? null, e?.signal ?? null, early)
        // Tell attached clients WHY the session ended before closing the socket,
        // so the UI shows a reason instead of a silent black pane.
        const frame = JSON.stringify({ type: 'exit', code: e?.exitCode ?? null, signal: e?.signal ?? null, early })
        for (const ws of session.clients) {
          if (ws.readyState === WS_OPEN) { try { ws.send(frame) } catch { /* ignore */ } }
        }
      }
      for (const ws of session.clients) {
        try { ws.close(1000, early ? 'pty_exit_early' : 'pty_exit') } catch { /* ignore */ }
      }
      cleanupSessionShim(session.projectSlug, session.id)
      this.removeFromRegistry(session)
    })

    this.sessions.set(id, session)
    let set = this.byProject.get(projectId)
    if (!set) { set = new Set<string>(); this.byProject.set(projectId, set) }
    set.add(id)

    return this.toMeta(session)
  }

  /**
   * Attach a WebSocket to the session: sends snapshot + ready frame, then wires live output.
   * Caller is responsible for having verified projectId scope.
   */
  attach(sessionId: string, ws: WebSocket): TerminalSessionMeta | null {
    const s = this.sessions.get(sessionId)
    if (!s || s.exited) return null
    try {
      const snapshot = s.buffer.snapshot()
      if (snapshot.length > 0) ws.send(snapshot, { binary: true })
      ws.send(JSON.stringify({ type: 'ready', id: s.id, name: s.name, cols: s.cols, rows: s.rows }))
    } catch {
      return null
    }
    s.clients.add(ws)
    return this.toMeta(s)
  }

  detach(sessionId: string, ws: WebSocket): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.clients.delete(ws)
  }

  /** Returns the tombstone for a recently-exited session, scoped to projectId,
   *  or undefined. Used by the WS upgrade/attach path to report why a session a
   *  client is trying to reach has already gone. */
  getTombstone(sessionId: string, projectId: string): SessionTombstone | undefined {
    const t = this.tombstones.get(sessionId)
    if (!t || t.projectId !== projectId) return undefined
    return t
  }

  private recordTombstone(
    sessionId: string, projectId: string, code: number | null, signal: number | null, early: boolean,
  ): void {
    this.tombstones.set(sessionId, { projectId, exitedAt: Date.now(), code, signal, early })
    const prev = this.tombstoneTimers.get(sessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.tombstones.delete(sessionId)
      this.tombstoneTimers.delete(sessionId)
    }, TOMBSTONE_TTL_MS)
    // Don't keep the event loop alive solely for tombstone eviction.
    if (typeof timer.unref === 'function') timer.unref()
    this.tombstoneTimers.set(sessionId, timer)
  }

  write(sessionId: string, data: Buffer | string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.exited) return
    const str = typeof data === 'string' ? data : data.toString('utf8')
    try { s.pty.write(str) } catch { /* pty may have died between checks */ }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.exited) return
    const c = clampDim(cols, 2, 1000)
    const r = clampDim(rows, 2, 1000)
    try { s.pty.resize(c, r) } catch { /* ignore */ }
    s.cols = c; s.rows = r
  }

  rename(projectId: string, sessionId: string, name: string): TerminalSessionMeta {
    const s = this.get(projectId, sessionId)
    if (!s) throw new TerminalNotFoundError()
    const validated = validateName(name)
    if (!validated) throw new TerminalNameInvalidError()
    s.name = validated
    const msg = JSON.stringify({ type: 'renamed', id: s.id, name: s.name })
    for (const ws of s.clients) {
      if (ws.readyState === WS_OPEN) {
        try { ws.send(msg) } catch { /* ignore */ }
      }
    }
    return this.toMeta(s)
  }

  kill(projectId: string, sessionId: string): boolean {
    const s = this.get(projectId, sessionId)
    if (!s) return false
    this.killSession(s)
    return true
  }

  killAllForProject(projectId: string): number {
    const set = this.byProject.get(projectId)
    if (!set) return 0
    const ids = Array.from(set)
    let killed = 0
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (s) { this.killSession(s); killed++ }
    }
    return killed
  }

  async shutdown(): Promise<void> {
    const all = Array.from(this.sessions.values())
    for (const s of all) {
      try { s.pty.kill('SIGTERM') } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, TERMINAL_KILL_GRACE_MS))
    for (const s of Array.from(this.sessions.values())) {
      try { s.pty.kill('SIGKILL') } catch { /* ignore */ }
      this.removeFromRegistry(s)
    }
    for (const timer of this.tombstoneTimers.values()) clearTimeout(timer)
    this.tombstoneTimers.clear()
    this.tombstones.clear()
  }

  sessionCount(): number { return this.sessions.size }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Process an OSC parser event: persist command marks where appropriate and
   * broadcast a JSON control frame `{type:"mark",kind,...}` on every attached
   * WebSocket. Bytes are forwarded to xterm separately.
   */
  private handleMarkEvents(session: TerminalSession, events: OscMarkEvent[]): void {
    const ts = Date.now()
    for (const ev of events) {
      // Persist where applicable.
      if (session.projectDb) {
        try {
          if (ev.kind === 'pre-exec') {
            // Open a new mark; if a previous one is still open (no D before next C),
            // close it as killed-by-prompt.
            const dangling = getOpenMark(session.projectDb, session.id)
            if (dangling) {
              closeOpenMark(session.projectDb, session.id, ts, null, null, session.currentCwd ?? null)
            }
            appendMark(session.projectDb, {
              sessionId: session.id,
              startedAt: ts,
              cwd: session.currentCwd ?? null,
            })
          } else if (ev.kind === 'post-exec') {
            closeOpenMark(
              session.projectDb,
              session.id,
              ts,
              ev.exitCode ?? null,
              null,
              session.currentCwd ?? null,
            )
          } else if (ev.kind === 'cwd') {
            session.currentCwd = ev.payload ?? null
          }
        } catch { /* persistence is best-effort */ }
      } else if (ev.kind === 'cwd') {
        session.currentCwd = ev.payload ?? null
      }

      // Broadcast control frame.
      const payload: Record<string, unknown> = { type: 'mark', kind: ev.kind, ts }
      if (ev.exitCode !== undefined) payload.payload = { exitCode: ev.exitCode }
      if (ev.kind === 'cwd' && ev.payload) payload.payload = { path: ev.payload }
      const json = JSON.stringify(payload)
      for (const ws of session.clients) {
        if (ws.readyState === WS_OPEN) {
          try { ws.send(json) } catch { /* ignore */ }
        }
      }
    }
  }


  /**
   * Kill semantics: remove the session from the public registry immediately so
   * subsequent lookups (REST, WS attach) return 404, then SIGTERM in the
   * background, then SIGKILL after a grace period if needed. The onExit handler
   * installed at creation becomes a no-op for already-removed sessions.
   */
  private killSession(s: TerminalSession): void {
    // Idempotent: if already removed from registry, skip.
    if (!this.sessions.has(s.id)) return
    this.detachFromRegistry(s)
    if (!s.exited) {
      try { s.pty.kill('SIGTERM') } catch { /* ignore */ }
      s.killTimer = setTimeout(() => {
        if (!s.exited) {
          try { s.pty.kill('SIGKILL') } catch { /* ignore */ }
        }
      }, TERMINAL_KILL_GRACE_MS)
    }
    // Close any open command mark with the session's death timestamp.
    if (s.projectDb) {
      try { markOpenAsKilled(s.projectDb, s.id, Date.now()) } catch { /* ignore */ }
    }
    cleanupSessionShim(s.projectSlug, s.id)
    // Close clients so the WS upgrade handlers detach cleanly
    for (const ws of s.clients) {
      try { ws.close(1000, 'session_closed') } catch { /* ignore */ }
    }
    s.clients.clear()
    s.buffer.clear()
  }

  private detachFromRegistry(s: TerminalSession): void {
    this.sessions.delete(s.id)
    const set = this.byProject.get(s.projectId)
    if (set) {
      set.delete(s.id)
      if (set.size === 0) this.byProject.delete(s.projectId)
    }
  }

  private removeFromRegistry(s: TerminalSession): void {
    if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = undefined }
    this.detachFromRegistry(s)
    for (const ws of s.clients) {
      try { ws.close(1000, 'session_closed') } catch { /* ignore */ }
    }
    s.clients.clear()
    s.buffer.clear()
  }

  private autoName(projectId: string, shell: string): string {
    const base = path.basename(shell)
    const metas = this.listForProject(projectId)
    const matching = metas.filter((m) => m.name === base || m.name.startsWith(base + ' ('))
    if (matching.length === 0) return base
    return `${base} (${matching.length + 1})`
  }

  private toMeta(s: TerminalSession): TerminalSessionMeta {
    return {
      id: s.id, projectId: s.projectId, name: s.name, shell: s.shell,
      cwd: s.cwd, cols: s.cols, rows: s.rows, createdAt: s.createdAt,
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clampDim(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  const v = Math.trunc(n)
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

function validateName(name?: string): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > TERMINAL_NAME_MAX) return null
  return trimmed
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: TerminalManager | null = null

/**
 * Returns the process-wide TerminalManager. Lazy-initialised so that test suites
 * that don't touch terminals pay no cost.
 */
export function getTerminalManager(): TerminalManager {
  if (!_instance) _instance = new TerminalManager()
  return _instance
}

/** Reset the singleton. Tests only. */
export function _resetTerminalManagerForTest(): void {
  if (_instance) {
    // Best-effort sync cleanup — tests call this in beforeEach
    void _instance.shutdown()
  }
  _instance = null
}
