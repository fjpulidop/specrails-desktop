import { SessionEventPump, type PumpListener } from '../application/session-event-pump'
import { SessionRequestError, isSessionRequestError } from '../domain/errors'
import {
  DEFAULT_SUPERVISION,
  INITIAL_HOST_STATE,
  acceptsSessions,
  onDemand,
  onFailure,
  onFatal,
  onReady,
  onRestartDue,
  onRetry,
  onStop,
  type HostState,
  type HostStatus,
  type HostSupervisionPolicy,
} from '../domain/host-state'
import type { InitializeResult } from '../domain/protocol'
import type { Clock, HostProcessLauncher, ProjectionSink, SessionHostClient, TimerHandle } from '../ports'

interface Tracked {
  sessionId: string
  sink: ProjectionSink
  listener: PumpListener
  pump: SessionEventPump | null
}

interface ScopeEntry {
  state: HostState
  client: (SessionHostClient & { initialize?: InitializeResult }) | null
  starting: Promise<SessionHostClient> | null
  restartTimer: TimerHandle | null
  tracked: Map<string, Tracked>
  unsubscribe: Array<() => void>
  degradedReason: string | null
  /** Why the scope degraded when the cause is known (`journal_locked`, `protocol_mismatch`, …). */
  degradedCode: string | null
}

/** Failures a restart cannot fix: the scope degrades at once instead of looping. */
const FATAL_CODES: ReadonlySet<string> = new Set(['journal_locked', 'protocol_mismatch', 'driver_unavailable'])

export interface HostStatusView {
  scope: string
  status: HostStatus
  detail: string | null
  code: string | null
}

export interface SessionHostRegistryOptions {
  launcher: HostProcessLauncher
  clock: Clock
  policy?: HostSupervisionPolicy
  /** Observability hook (logs, UI notices). */
  onStatus?: (scope: string, status: HostStatus, detail?: string, code?: string) => void
}

/**
 * One supervised Core session host per scope (project key or `global`).
 * Hosts start lazily, restart with backoff after unexpected exits, re-open and
 * replay tracked sessions, and become degraded after repeated failures so
 * callers can fall back to legacy transports for new turns.
 */
export class SessionHostRegistry {
  private readonly scopes = new Map<string, ScopeEntry>()
  private stopped = false

  constructor(private readonly options: SessionHostRegistryOptions) {}

  status(scope: string): HostStatus {
    return this.scopes.get(scope)?.state.status ?? 'absent'
  }

  /** Every known scope with its status (operator view, UI notices). */
  hosts(): HostStatusView[] {
    return [...this.scopes].map(([scope, entry]) => ({ scope, status: entry.state.status, detail: entry.degradedReason, code: entry.degradedCode }))
  }

  /** Why a degraded scope is unavailable, when known. */
  degradedCode(scope: string): string | null {
    return this.scopes.get(scope)?.degradedCode ?? null
  }

  /** Whether new turns in this scope should use Core sessions now. */
  available(scope: string): boolean {
    return !this.stopped && acceptsSessions(this.scopes.get(scope)?.state ?? INITIAL_HOST_STATE)
  }

  /** A ready client for the scope, starting the host when needed. */
  async acquire(scope: string): Promise<SessionHostClient & { initialize?: InitializeResult }> {
    if (this.stopped) throw new SessionRequestError('Session hosts are shutting down', { code: 'busy', retryable: true })
    const entry = this.entry(scope)
    if (entry.client && !this.isClosed(entry.client)) return entry.client
    if (entry.state.status === 'degraded') {
      throw new SessionRequestError(`Core sessions are unavailable for ${scope}: ${entry.degradedReason ?? 'repeated host failures'}`, { code: 'host_degraded', retryable: false })
    }
    if (entry.starting) return entry.starting
    if (entry.state.status === 'ready') {
      // The client closed before its close event was processed: count it as a failure.
      this.fail(scope, entry, 'Session host connection closed')
      if (this.status(scope) === 'degraded') return this.acquire(scope)
    }
    if (entry.state.status === 'restarting') {
      // A caller needs the host now: start immediately instead of waiting for the backoff timer.
      entry.restartTimer?.cancel()
      entry.restartTimer = null
      entry.state = onRestartDue(entry.state).state
    } else if (entry.state.status === 'absent') {
      entry.state = onDemand(entry.state).state
    }
    return this.start(scope, entry)
  }

  /**
   * Follow a session: its events are applied to `sink` and reported to
   * `listener`. Survives host restarts (resume + replay from the sink cursor).
   */
  async track(scope: string, sessionId: string, sink: ProjectionSink, listener: PumpListener): Promise<SessionEventPump> {
    const client = await this.acquire(scope)
    const entry = this.entry(scope)
    const tracked: Tracked = entry.tracked.get(sessionId) ?? { sessionId, sink, listener, pump: null }
    entry.tracked.set(sessionId, tracked)
    tracked.pump?.detach()
    tracked.pump = new SessionEventPump(sessionId, client, sink, listener)
    await tracked.pump.attach()
    return tracked.pump
  }

  untrack(scope: string, sessionId: string): void {
    const entry = this.scopes.get(scope)
    const tracked = entry?.tracked.get(sessionId)
    tracked?.pump?.detach()
    entry?.tracked.delete(sessionId)
  }

  /** Manual retry of a degraded scope. */
  async retry(scope: string): Promise<void> {
    const entry = this.entry(scope)
    const result = onRetry(entry.state)
    if (result.decision.action !== 'start') return
    entry.state = result.state
    entry.degradedReason = null
    entry.degradedCode = null
    await this.start(scope, entry)
  }

  /** Graceful stop of one scope (project removed). */
  async stop(scope: string): Promise<void> {
    const entry = this.scopes.get(scope)
    if (!entry) return
    entry.restartTimer?.cancel()
    entry.state = onStop(entry.state)
    for (const tracked of entry.tracked.values()) tracked.pump?.detach()
    for (const unsubscribe of entry.unsubscribe.splice(0)) unsubscribe()
    const client = entry.client ?? (entry.starting ? await entry.starting.catch(() => null) : null)
    entry.client = null
    this.options.onStatus?.(scope, 'stopped')
    if (client) await client.close()
    this.scopes.delete(scope)
  }

  /** App shutdown. */
  async stopAll(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.scopes.keys()].map((scope) => this.stop(scope)))
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private entry(scope: string): ScopeEntry {
    let entry = this.scopes.get(scope)
    if (!entry) {
      entry = { state: INITIAL_HOST_STATE, client: null, starting: null, restartTimer: null, tracked: new Map(), unsubscribe: [], degradedReason: null, degradedCode: null }
      this.scopes.set(scope, entry)
    }
    return entry
  }

  private isClosed(client: SessionHostClient): boolean {
    return (client as { closed?: boolean }).closed === true
  }

  private start(scope: string, entry: ScopeEntry): Promise<SessionHostClient> {
    this.options.onStatus?.(scope, 'starting')
    entry.starting = (async () => {
      try {
        const client = await this.options.launcher.launch(scope)
        if (entry.state.status === 'stopped') { await client.close(); throw new SessionRequestError('Scope stopped', { code: 'busy', retryable: false }) }
        entry.client = client
        entry.state = onReady(entry.state)
        this.wire(scope, entry, client)
        this.options.onStatus?.(scope, 'ready')
        await this.reattach(entry, client)
        return client
      } catch (error) {
        if (entry.state.status !== 'stopped') {
          if (isSessionRequestError(error) && FATAL_CODES.has(error.code)) this.fatal(scope, entry, error.code, error.message)
          else this.fail(scope, entry, (error as Error).message)
        }
        throw error
      } finally {
        entry.starting = null
      }
    })()
    return entry.starting
  }

  private wire(scope: string, entry: ScopeEntry, client: SessionHostClient): void {
    for (const unsubscribe of entry.unsubscribe.splice(0)) unsubscribe()
    entry.unsubscribe.push(
      client.onEvent((envelope) => { void entry.tracked.get(envelope.sessionId)?.pump?.push(envelope).catch((error) => this.options.onStatus?.(scope, entry.state.status, `projection failed: ${(error as Error).message}`)) }),
      client.onLagged((sessionId) => { void entry.tracked.get(sessionId)?.pump?.catchUp().catch(() => undefined) }),
      client.onClose((reason, code) => {
        if (entry.client !== client || entry.state.status === 'stopped') return
        entry.client = null
        if (code && FATAL_CODES.has(code)) this.fatal(scope, entry, code, reason)
        else this.fail(scope, entry, reason)
      }),
    )
  }

  /** After a (re)start: resume every tracked session and replay from its cursor. */
  private async reattach(entry: ScopeEntry, client: SessionHostClient): Promise<void> {
    for (const tracked of entry.tracked.values()) {
      tracked.pump?.detach()
      try {
        await client.request('session.open', { resume: { sessionId: tracked.sessionId } })
      } catch (error) {
        // Closed sessions replay as history; a session Core never opened has nothing to resume.
        if (!(error instanceof SessionRequestError) || (error.code !== 'session_closed' && error.code !== 'session_not_found')) throw error
        if (error.code === 'session_not_found') continue
      }
      tracked.pump = new SessionEventPump(tracked.sessionId, client, tracked.sink, tracked.listener)
      await tracked.pump.attach()
    }
  }

  private fatal(scope: string, entry: ScopeEntry, code: string, reason: string): void {
    const result = onFatal(entry.state, reason)
    entry.state = result.state
    if (result.decision.action !== 'degrade') return
    entry.restartTimer?.cancel()
    entry.restartTimer = null
    entry.degradedReason = reason
    entry.degradedCode = code
    this.options.onStatus?.(scope, 'degraded', reason, code)
  }

  private fail(scope: string, entry: ScopeEntry, reason: string): void {
    const result = onFailure(entry.state, this.options.clock.now(), this.options.policy ?? DEFAULT_SUPERVISION)
    entry.state = result.state
    if (result.decision.action === 'degrade') {
      entry.degradedReason = `${result.decision.reason}; last: ${reason}`
      this.options.onStatus?.(scope, 'degraded', entry.degradedReason)
      return
    }
    if (result.decision.action === 'restart') {
      this.options.onStatus?.(scope, 'restarting', reason)
      entry.restartTimer?.cancel()
      entry.restartTimer = this.options.clock.after(result.decision.delayMs, () => {
        entry.restartTimer = null
        const due = onRestartDue(entry.state)
        entry.state = due.state
        if (due.decision.action === 'start') void this.start(scope, entry).catch(() => undefined)
      })
    }
  }
}
