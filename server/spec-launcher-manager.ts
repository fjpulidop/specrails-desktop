import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { resolveCommand } from './command-resolver'
import { spawnAiCli } from './util/cli-prompt'
import { getAdapter, type ProviderAdapter, type AdapterEvent } from './providers'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  formatProviderCommand,
  parseStreamEvents,
} from './providers/runtime'
import { expandCommands } from './loop-command-catalog'
import { resolveProjectExecution, type ProjectExecution } from './workspace-resolution'

// ─── SpecLauncherManager ──────────────────────────────────────────────────────

export class SpecLauncherManager {
  private _broadcast: (msg: WsMessage) => void
  private _cwd: string
  private _activeProcesses: Map<string, ChildProcess>
  private _buffers: Map<string, string>
  /**
   * Launches whose child was intentionally killed via cancel(). The close
   * handler short-circuits for these so a cancelled launch never emits a
   * follow-up spec_launcher_done/error (BUG-LONGTAIL-04).
   */
  private _cancelledIds = new Set<string>()
  /**
   * Set in shutdown() so any in-flight close handler skips broadcasting on a
   * removed/torn-down project (BUG-LONGTAIL-04).
   */
  private _disposed = false
  /** Pending SIGKILL escalation timers, keyed by launch id (BUG-LONGTAIL-02). */
  private _killTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-project DB + id for ai_invocations recording (COST-ACCOUNTING-AUDIT
   *  HIGH-5). Optional so pre-wiring call sites keep compiling; recording only
   *  fires when BOTH are present. */
  private _db?: DbInstance
  private _projectId?: string
  private _projectSlug?: string
  private _adapter: ProviderAdapter
  /** Accumulated adapter events per active launch, drained at close. */
  private _events = new Map<string, AdapterEvent[]>()
  /** Spawn timestamp per active launch (ISO), for the invocation row. */
  private _startedAt = new Map<string, string>()

  constructor(
    broadcast: (msg: WsMessage) => void,
    cwd: string,
    db?: DbInstance,
    projectId?: string,
    providerId: string = 'claude',
    projectSlug?: string,
  ) {
    this._broadcast = broadcast
    this._cwd = cwd
    this._db = db
    this._projectId = projectId
    this._projectSlug = projectSlug
    this._adapter = getAdapter(providerId)
    this._activeProcesses = new Map()
    this._buffers = new Map()
  }

  /** Resolve lazily because Core may populate the relocated workspace after
   * this project-scoped manager was constructed. */
  private _execution(): ProjectExecution {
    return resolveProjectExecution({ slug: this._projectSlug, path: this._cwd })
  }

  /**
   * Persist one surface='spec-launcher' ai_invocations row. Cost is the native
   * `total_cost_usd` when the run produced a terminal `result` event, else the
   * pricing-table estimate over the accumulated per-assistant-event usage (a
   * cancelled / shutdown-killed /opsx:ff run is a real, billable agentic spend —
   * HIGH-5). Best-effort: a recording failure is logged, never thrown.
   */
  private _recordInvocation(launchId: string, status: InvocationStatus): void {
    const db = this._db
    const projectId = this._projectId
    const events = this._events.get(launchId) ?? []
    const startedAt = this._startedAt.get(launchId) ?? new Date().toISOString()
    if (!db || !projectId) return
    try {
      const finishedAt = new Date().toISOString()
      const { result, estimated } = finaliseInvocationResult(this._adapter, events, {
        fallbackModel: this._adapter.defaultModel(),
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      })
      recordInvocation(db, {
        id: randomUUID(),
        project_id: projectId,
        provider: this._adapter.id,
        surface: 'spec-launcher',
        surface_ref_id: launchId,
        status,
        started_at: startedAt,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
      this._broadcast({ type: 'spending.invalidated', projectId })
    } catch (err) {
      console.error('[SpecLauncherManager] recordInvocation failed:', err)
    }
  }

  isActive(launchId: string): boolean {
    return this._activeProcesses.has(launchId)
  }

  /**
   * SIGTERM the child's process tree, then arm an unref'd 2s SIGKILL escalation
   * (cleared on the child's 'close'). A child that swallows SIGTERM would
   * otherwise become an unkillable orphan running with
   * --dangerously-skip-permissions (BUG-LONGTAIL-02).
   */
  private _killWithEscalation(launchId: string, pid: number): void {
    try { treeKill(pid, 'SIGTERM') } catch { /* best-effort */ }
    const existing = this._killTimers.get(launchId)
    if (existing) clearTimeout(existing)
    const grace = setTimeout(() => {
      this._killTimers.delete(launchId)
      try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
    }, 2000)
    grace.unref?.()
    this._killTimers.set(launchId, grace)
  }

  private _clearKillTimer(launchId: string): void {
    const timer = this._killTimers.get(launchId)
    if (timer) {
      clearTimeout(timer)
      this._killTimers.delete(launchId)
    }
  }

  /**
   * Tear down before the project is removed (M12). This manager holds no DB
   * handle (its close handler only broadcasts), so it cannot crash the app — but
   * an orphaned `/opsx:ff` child runs with --dangerously-skip-permissions against
   * a removed project and keeps burning spend, so SIGTERM it. Idempotent.
   */
  shutdown(): void {
    this._disposed = true
    for (const [launchId, child] of this._activeProcesses) {
      if (child.pid) this._killWithEscalation(launchId, child.pid)
    }
    this._activeProcesses.clear()
    this._buffers.clear()
    this._events.clear()
    this._startedAt.clear()
  }

  async launch(launchId: string, description: string): Promise<void> {
    const execution = this._execution()
    const rawCommand = `/opsx:ff ${description}`
    const resolvedPrompt = this._adapter.capabilities.materializeHeadlessSkills
      ? rawCommand
      : resolveCommand(rawCommand, execution.cwd)
    const providerCommand = resolvedPrompt === rawCommand
      ? `${expandCommands('{{cmd:opsx:ff}}', { provider: this._adapter.id })} ${description}`
      : resolvedPrompt
    if (providerCommand === rawCommand) {
      this._broadcastError(launchId, 'This project does not have the /opsx:ff command installed. Run "npx specrails-core@latest" to install it.')
      return
    }
    let prompt: string
    try {
      prompt = formatProviderCommand(this._adapter, providerCommand, execution.cwd)
    } catch (error) {
      this._broadcastError(
        launchId,
        error instanceof Error ? error.message : String(error),
      )
      return
    }

    const spawnOptions = {
      prompt,
      model: this._adapter.defaultModel(),
      toolPolicy: 'default' as const,
      extraArgs: execution.relocated
        ? buildProviderRepoAccessArgs(this._adapter, [execution.repoDir])
        : [],
    }
    const args = this._adapter.buildArgs('spec-gen', spawnOptions)

    const child = spawnAiCli(this._adapter.binary, args, {
      env: buildProviderEnv(this._adapter, spawnOptions, {
        ...process.env,
        ...execution.env,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: execution.cwd,
    })

    this._activeProcesses.set(launchId, child)
    this._buffers.set(launchId, '')
    this._events.set(launchId, [])
    this._startedAt.set(launchId, new Date().toISOString())

    // Surface ENOENT (e.g. claude not on PATH) instead of crashing the app.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[SpecLauncherManager] spawn failed for ${launchId}: ${err.message}`)
      // A spawn-failure still costs nothing meaningful, but record a failed row
      // for completeness when wired to a project DB.
      if (!this._disposed && !this._cancelledIds.has(launchId)) this._recordInvocation(launchId, 'failed')
      this._events.delete(launchId)
      this._startedAt.delete(launchId)
      this._activeProcesses.delete(launchId)
      this._buffers.delete(launchId)
      this._broadcast({
        type: 'spec_launcher_error',
        projectId: '',
        launchId,
        error: `Failed to launch ${this._adapter.binary}: ${err.message}`,
        timestamp: new Date().toISOString(),
      })
    })
    /* c8 ignore stop */

    // Capture last change ID from output (opsx:ff usually prints the change name)
    let detectedChangeId: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      // Accumulate adapter events so a killed/failed launch is still costed from
      // the per-assistant-event usage snapshots (HIGH-5), and so explicit
      // provider failures remain terminal even when a CLI anomalously exits 0.
      for (const event of parseStreamEvents(this._adapter, line)) {
        this._events.get(launchId)?.push(event)
        if (event.kind === 'text-delta') {
          const newText = event.text
          // Try to detect change ID from output (look for "openspec/changes/<id>" pattern)
          const changeMatch = newText.match(/openspec\/changes\/([^\s/]+)/)
          if (changeMatch) detectedChangeId = changeMatch[1]

          const prev = this._buffers.get(launchId) ?? ''
          this._buffers.set(launchId, prev + newText)
          this._broadcast({
            type: 'spec_launcher_stream',
            projectId: '',
            launchId,
            delta: newText,
            timestamp: new Date().toISOString(),
          })
        } else if (event.kind === 'tool-use') {
          this._broadcast({
            type: 'spec_launcher_stream',
            projectId: '',
            launchId,
            delta: `<!--tool:${event.name}-->`,
            timestamp: new Date().toISOString(),
          })
        }
      }
    })

    return new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const fullText = this._buffers.get(launchId) ?? ''
        this._clearKillTimer(launchId)
        this._activeProcesses.delete(launchId)
        this._buffers.delete(launchId)
        const wasCancelled = this._cancelledIds.delete(launchId)
        const providerError = this._events.get(launchId)?.find(
          (event): event is Extract<AdapterEvent, { kind: 'error' }> =>
            event.kind === 'error',
        )?.message
        // Record the invocation regardless of cancel/done outcome (the spend is
        // real either way) — but NOT when the project is being torn down, since
        // its DB is closing (recordInvocation would throw). A cancelled/killed
        // launch is 'aborted'; a non-zero exit is 'failed'; a clean exit is
        // 'success' (HIGH-5).
        if (!this._disposed) {
          const status: InvocationStatus =
            wasCancelled ? 'aborted' : code === 0 && !providerError ? 'success' : 'failed'
          this._recordInvocation(launchId, status)
        }
        this._events.delete(launchId)
        this._startedAt.delete(launchId)
        // A cancel() killed this child intentionally, or shutdown() removed the
        // project — either way do NOT emit a follow-up done/error broadcast for
        // a cancelled/torn-down launch (BUG-LONGTAIL-04).
        if (wasCancelled || this._disposed) { resolve(); return }

        if (code === 0 && !providerError) {
          // Also try to extract change ID from full text
          if (!detectedChangeId) {
            const match = fullText.match(/openspec\/changes\/([^\s/]+)/)
            if (match) detectedChangeId = match[1]
          }
          this._broadcast({
            type: 'spec_launcher_done',
            projectId: '',
            launchId,
            changeId: detectedChangeId,
            timestamp: new Date().toISOString(),
          })
        } else {
          this._broadcastError(launchId, providerError ?? 'Spec generation failed')
        }

        resolve()
      })
    })
  }

  cancel(launchId: string): void {
    // Mark intentionally-cancelled BEFORE killing so the child's later 'close'
    // short-circuits instead of broadcasting a contradictory done/error for a
    // cancelled launch (BUG-LONGTAIL-04).
    this._cancelledIds.add(launchId)
    const child = this._activeProcesses.get(launchId)
    if (child?.pid) {
      this._killWithEscalation(launchId, child.pid)
    } else {
      // No live child to close-out, so the flag would otherwise leak.
      this._cancelledIds.delete(launchId)
    }
    this._activeProcesses.delete(launchId)
    this._buffers.delete(launchId)
    this._broadcastError(launchId, 'cancelled')
  }

  private _broadcastError(launchId: string, error: string): void {
    this._broadcast({
      type: 'spec_launcher_error',
      projectId: '',
      launchId,
      error,
      timestamp: new Date().toISOString(),
    })
  }
}
