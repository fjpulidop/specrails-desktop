import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import {
  readEnvFromLoginShell,
  readEnvFromLoginShellSyncDetailed,
  resolveLoginShellProbeTimeoutMs,
  type LoginShellEnvProbe,
} from './path-resolver'

// ─── Project runtime environment: login-shell recovery + status ──────────────
// Values stay in the owning project's memory, never process.env or SQLite.
// Each configured name has a value-free status record; the status route, the
// settings UI, the MCP `env` tool and the run-log warning all derive from it.

/** Resolution state of one configured name. Never carries a value. */
export type WorktreeEnvResolutionStatus =
  | 'inherited'
  | 'recovered'
  | 'not-defined'
  | 'probe-timeout'
  | 'probe-failed'

export interface WorktreeEnvNameStatus {
  name: string
  /** `pending` only while a configured name has never been checked yet. */
  status: WorktreeEnvResolutionStatus | 'pending'
  /** Login shell used for the check; null for inherited/unchecked names. */
  shell: string | null
  /** ISO time of the last check (or of this read for inherited names). */
  checkedAt: string | null
  /** Shell exit status recorded as a diagnostic only. */
  exitCode: number | null
}

export interface WorktreeEnvStatusReport {
  /** False on Windows, where only the inherited environment is used. */
  loginShellRecovery: boolean
  /** Asynchronous probe budget in ms (`SPECRAILS_LOGIN_SHELL_TIMEOUT_MS`). */
  timeoutMs: number
  /** A probe is currently running for this project. */
  checking: boolean
  names: WorktreeEnvNameStatus[]
}

/** Successful recoveries stay valid for 10 minutes; the background refresh
 *  rotates them well inside that window. */
export const PROJECT_ENV_SUCCESS_TTL_MS = 10 * 60_000
/** Failed or empty lookups are retried after 30 seconds. */
export const PROJECT_ENV_FAILURE_TTL_MS = 30_000
/** The background refresh runs this long before a success expires. */
const PROJECT_ENV_REFRESH_LEAD_MS = 60_000

type ShellStatus = Exclude<WorktreeEnvResolutionStatus, 'inherited'>

interface ShellRecord {
  status: ShellStatus
  shell: string | null
  checkedAt: number
  expiresAt: number
  exitCode: number | null
}

interface ProjectEnvState {
  /** Shell context the records were computed for (SHELL/HOME/ZDOTDIR). */
  identity: string
  records: Map<string, ShellRecord>
  /** Recovered values, held in memory only and never serialized. */
  values: Map<string, string>
  inflight: Promise<void> | null
  /** One follow-up probe queued behind the in-flight one. */
  queued: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  /** Background warm-up/refresh is enabled while the project is loaded. */
  active: boolean
}

const states = new WeakMap<DbInstance, ProjectEnvState>()

function shellIdentity(): string {
  return JSON.stringify([process.env.SHELL, process.env.HOME, process.env.ZDOTDIR])
}

function stateFor(db: DbInstance): ProjectEnvState {
  const identity = shellIdentity()
  let state = states.get(db)
  if (!state) {
    state = { identity, records: new Map(), values: new Map(), inflight: null, queued: null, timer: null, active: false }
    states.set(db, state)
  } else if (state.identity !== identity) {
    state.identity = identity
    state.records.clear()
    state.values.clear()
  }
  return state
}

function configuredNames(db: DbInstance): string[] {
  try {
    return getProjectSettings(db).worktreeEnvPassthrough
  } catch {
    // A closed/unloaded project connection has no configured names.
    return []
  }
}

function missingNames(names: readonly string[]): string[] {
  return names.filter(name => !process.env[name])
}

/** Drop records for names no longer configured or now inherited. */
function prune(state: ProjectEnvState, names: readonly string[]): void {
  for (const name of [...state.records.keys()]) {
    if (!names.includes(name) || process.env[name]) {
      state.records.delete(name)
      state.values.delete(name)
    }
  }
}

function isValid(record: ShellRecord | undefined, now: number): record is ShellRecord {
  return Boolean(record && now < record.expiresAt)
}

function statusFromProbe(probe: LoginShellEnvProbe, value: string | undefined): ShellStatus {
  if (value) return 'recovered'
  if (probe.status === 'timeout') return 'probe-timeout'
  if (probe.status === 'failed') return 'probe-failed'
  // `ok` without a value, or `skipped` (Windows / no login-shell recovery).
  return 'not-defined'
}

function recordProbe(state: ProjectEnvState, probe: LoginShellEnvProbe, names: readonly string[], now: number): void {
  for (const name of names) {
    const value = probe.values[name]
    const status = statusFromProbe(probe, value)
    const previous = state.records.get(name)
    // A transient probe failure never discards a still-valid recovered value.
    if (status !== 'recovered' && previous?.status === 'recovered' && isValid(previous, now) && probe.status !== 'ok') continue
    state.records.set(name, {
      status,
      shell: probe.shell,
      checkedAt: now,
      expiresAt: now + (status === 'recovered' ? PROJECT_ENV_SUCCESS_TTL_MS : PROJECT_ENV_FAILURE_TTL_MS),
      exitCode: probe.exitCode,
    })
    if (value) state.values.set(name, value)
    else state.values.delete(name)
  }
}

function scheduleRefresh(db: DbInstance, state: ProjectEnvState): void {
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
  if (!state.active || states.get(db) !== state) return
  let earliest = Infinity
  for (const record of state.records.values()) {
    if (record.status === 'recovered') earliest = Math.min(earliest, record.expiresAt)
  }
  if (earliest === Infinity) return
  const now = Date.now()
  const at = Math.max(now + PROJECT_ENV_FAILURE_TTL_MS, earliest - PROJECT_ENV_REFRESH_LEAD_MS)
  state.timer = setTimeout(() => {
    state.timer = null
    if (state.active && states.get(db) === state) void refreshProjectEnv(db)
  }, at - now)
  state.timer.unref?.()
}

/** Probe the login shell asynchronously for every configured name missing from
 *  the process environment and update this project's records. De-duplicated
 *  while a probe is in flight: a call during a probe resolves after one more
 *  probe that starts when the current one ends, so a settings change or an
 *  explicit recheck is never answered with stale results. Never rejects. */
export function refreshProjectEnv(db: DbInstance): Promise<void> {
  const state = stateFor(db)
  if (state.inflight) {
    // A request during a probe (settings change, recheck) gets a fresh probe
    // after the current one; concurrent requests share that single follow-up.
    if (!state.queued) {
      state.queued = state.inflight.then(() => {
        state.queued = null
        return refreshProjectEnv(db)
      })
    }
    return state.queued
  }
  const names = configuredNames(db)
  prune(state, names)
  const missing = missingNames(names)
  if (missing.length === 0) {
    scheduleRefresh(db, state)
    return Promise.resolve()
  }
  const run = readEnvFromLoginShell(missing, { timeoutMs: resolveLoginShellProbeTimeoutMs() })
    .then(probe => {
      if (states.get(db) !== state) return
      const current = configuredNames(db)
      prune(state, current)
      // Only names still configured and still missing are recorded.
      const stillMissing = missingNames(current)
      recordProbe(state, probe, missing.filter(name => stillMissing.includes(name)), Date.now())
    })
    .catch(() => { /* a probe failure is recorded as status, never thrown */ })
    .finally(() => {
      state.inflight = null
      scheduleRefresh(db, state)
    })
  state.inflight = run
  return run
}

/** Probe only when a configured missing name has no valid record yet. */
export function ensureProjectEnvFresh(db: DbInstance): Promise<void> {
  const state = stateFor(db)
  if (state.inflight) return state.inflight
  const names = configuredNames(db)
  prune(state, names)
  const now = Date.now()
  const stale = missingNames(names).some(name => !isValid(state.records.get(name), now))
  return stale ? refreshProjectEnv(db) : Promise.resolve()
}

/** Start background warm-up for a loaded project: probe now, then refresh
 *  before successful results expire, until `stopProjectEnvWarmup`. */
export function startProjectEnvWarmup(db: DbInstance): void {
  const state = stateFor(db)
  state.active = true
  void refreshProjectEnv(db)
}

/** Stop the background refresh and forget this project's recovered values. */
export function stopProjectEnvWarmup(db: DbInstance): void {
  const state = states.get(db)
  if (!state) return
  state.active = false
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
  states.delete(db)
}

function recoverProjectEnv(db: DbInstance, names: string[]): NodeJS.ProcessEnv {
  const state = stateFor(db)
  prune(state, names)
  const missing = missingNames(names)
  if (!missing.length) return {}
  const now = Date.now()
  // Cold fallback: a name with no record (or an expired success) gets the
  // short synchronous probe. Expired failures are retried asynchronously.
  const cold = missing.filter(name => {
    const record = state.records.get(name)
    return !record || (record.status === 'recovered' && !isValid(record, now))
  })
  let retry = missing.some(name => {
    const record = state.records.get(name)
    return record !== undefined && record.status !== 'recovered' && !isValid(record, now)
  })
  if (cold.length) {
    const probe = readEnvFromLoginShellSyncDetailed(cold)
    recordProbe(state, probe, cold, now)
    // The async probe has a larger budget than the cold sync one.
    if (probe.status === 'timeout' || probe.status === 'failed') retry = true
  }
  if (retry) void refreshProjectEnv(db)
  const out: NodeJS.ProcessEnv = {}
  for (const name of missing) {
    const value = state.values.get(name)
    if (value && isValid(state.records.get(name), now)) out[name] = value
  }
  return out
}

/** Resolve the per-project env passthrough overlay for a spawn.
 *
 * The project setting stores names only. Values are read from `sourceEnv` at
 * spawn time so credentials can rotate without touching SQLite. When the
 * source is `process.env`, missing configured names come from the project's
 * warm login-shell cache; the short synchronous probe runs only when cold.
 * Unresolved names remain absent.
 */
export function resolveWorktreeEnvPassthrough(
  db: DbInstance,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const names = configuredNames(db)
  const recovered = sourceEnv === process.env ? recoverProjectEnv(db, names) : {}
  for (const name of names) {
    const value = sourceEnv[name] || recovered[name] || sourceEnv[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

export function applyWorktreeEnvPassthrough(
  db: DbInstance,
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const passthrough = resolveWorktreeEnvPassthrough(db, sourceEnv)
  return Object.keys(passthrough).length === 0 ? env : { ...env, ...passthrough }
}

/** Value-free status of every configured name for this project. */
export function getProjectEnvStatus(db: DbInstance): WorktreeEnvStatusReport {
  const state = stateFor(db)
  const names = configuredNames(db)
  prune(state, names)
  const nowIso = new Date(Date.now()).toISOString()
  return {
    loginShellRecovery: process.platform !== 'win32',
    timeoutMs: resolveLoginShellProbeTimeoutMs(),
    checking: state.inflight !== null,
    names: names.map((name): WorktreeEnvNameStatus => {
      if (process.env[name]) return { name, status: 'inherited', shell: null, checkedAt: nowIso, exitCode: null }
      const record = state.records.get(name)
      if (!record) return { name, status: 'pending', shell: null, checkedAt: null, exitCode: null }
      return {
        name,
        status: record.status,
        shell: record.shell,
        checkedAt: new Date(record.checkedAt).toISOString(),
        exitCode: record.exitCode,
      }
    }),
  }
}

/** One aggregated, value-free run-log line naming every configured name that
 *  is absent from `env`, or null when all configured names resolved. */
export function worktreeEnvPassthroughWarning(db: DbInstance, env: NodeJS.ProcessEnv): string | null {
  const names = configuredNames(db)
  const unresolved = names.filter(name => !env[name])
  if (!unresolved.length) return null
  const state = states.get(db)
  const now = Date.now()
  const parts = unresolved.map(name => {
    const record = state?.records.get(name)
    // An expired success no longer counts as recovered; failures keep their cause.
    const status: ShellStatus = !record ? 'not-defined' : record.status === 'recovered' && now >= record.expiresAt ? 'not-defined' : record.status
    return { name, status }
  })
  const hint = process.platform === 'win32'
    ? 'set it in the environment Specrails starts with'
    : 'configure it in the login shell or launch from a terminal'
  if (parts.length === 1) return `[environment] ${parts[0].name} not available (${parts[0].status}); ${hint}`
  return `[environment] ${parts.map(p => `${p.name} (${p.status})`).join(', ')} not available; ${hint.replace(' it ', ' them ')}`
}
