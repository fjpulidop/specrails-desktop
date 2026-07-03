import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { resolveCommand } from './command-resolver'
import { spawnClaude } from './util/cli-prompt'
import { getAdapter, type ProviderAdapter, type AdapterEvent } from './providers'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'

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
  /** claude adapter — the launcher only ever spawns claude. Used to parse the
   *  stream into AdapterEvents for cost finalisation. */
  private _adapter: ProviderAdapter = getAdapter('claude')
  /** Accumulated adapter events per active launch, drained at close. */
  private _events = new Map<string, AdapterEvent[]>()
  /** Spawn timestamp per active launch (ISO), for the invocation row. */
  private _startedAt = new Map<string, string>()

  constructor(broadcast: (msg: WsMessage) => void, cwd: string, db?: DbInstance, projectId?: string) {
    this._broadcast = broadcast
    this._cwd = cwd
    this._db = db
    this._projectId = projectId
    this._activeProcesses = new Map()
    this._buffers = new Map()
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
      const { result, estimated } = finaliseInvocationResult(this._adapter, events, {
        fallbackModel: this._adapter.defaultModel(),
      })
      recordInvocation(db, {
        id: randomUUID(),
        project_id: projectId,
        provider: this._adapter.id,
        surface: 'spec-launcher',
        surface_ref_id: launchId,
        status,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
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
    const rawCommand = `/opsx:ff ${description}`
    const prompt = resolveCommand(rawCommand, this._cwd)
    if (prompt === rawCommand) {
      this._broadcastError(launchId, 'This project does not have the /opsx:ff command installed. Run "npx specrails-core@latest" to install it.')
      return
    }

    const args = [
      '--dangerously-skip-permissions',
      '--tools', 'default',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', prompt,
    ]

    // spawnClaude reroutes multi-line argv values through stdin on Windows.
    const child = spawnClaude(args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this._cwd,
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
        error: `Failed to launch claude: ${err.message}`,
        timestamp: new Date().toISOString(),
      })
    })
    /* c8 ignore stop */

    // Capture last change ID from output (opsx:ff usually prints the change name)
    let detectedChangeId: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      // Accumulate adapter events so a killed/failed launch is still costed from
      // the per-assistant-event usage snapshots (HIGH-5). Only when DB-wired.
      if (this._db && this._projectId) {
        const ev = this._adapter.parseStreamLine(line)
        if (ev) this._events.get(launchId)?.push(ev)
      }

      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* skip non-JSON */ }
      if (!parsed) return

      const eventType = parsed.type as string

      if (eventType === 'assistant') {
        const msg = parsed.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
        const blocks = msg?.content ?? []

        const texts = blocks
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
        const newText = texts.join('')
        if (newText) {
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
        }

        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            this._broadcast({
              type: 'spec_launcher_stream',
              projectId: '',
              launchId,
              delta: `<!--tool:${block.name}-->`,
              timestamp: new Date().toISOString(),
            })
          }
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
        // Record the invocation regardless of cancel/done outcome (the spend is
        // real either way) — but NOT when the project is being torn down, since
        // its DB is closing (recordInvocation would throw). A cancelled/killed
        // launch is 'aborted'; a non-zero exit is 'failed'; a clean exit is
        // 'success' (HIGH-5).
        if (!this._disposed) {
          const status: InvocationStatus = wasCancelled ? 'aborted' : code === 0 ? 'success' : 'failed'
          this._recordInvocation(launchId, status)
        }
        this._events.delete(launchId)
        this._startedAt.delete(launchId)
        // A cancel() killed this child intentionally, or shutdown() removed the
        // project — either way do NOT emit a follow-up done/error broadcast for
        // a cancelled/torn-down launch (BUG-LONGTAIL-04).
        if (wasCancelled || this._disposed) { resolve(); return }

        if (code === 0) {
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
          this._broadcastError(launchId, 'Spec generation failed')
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
