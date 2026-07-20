import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import { spawnAiCli } from './util/cli-prompt'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import {
  getProposal,
  updateProposal,
} from './db'
import { resolveCommand } from './command-resolver'
import { getAdapter, type ProviderAdapter, type AdapterEvent } from './providers'
import type { SpawnOptions } from './providers/types'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  formatProviderCommand,
  parseStreamEvents,
} from './providers/runtime'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import { resolveProjectExecution, type ProjectExecution } from './workspace-resolution'

// ─── ProposalManager ──────────────────────────────────────────────────────────

export class ProposalManager {
  private _broadcast: (msg: WsMessage) => void
  private _db: DbInstance
  private _cwd: string
  private _activeProcesses: Map<string, ChildProcess>
  private _buffers: Map<string, string>
  private _disposed = false
  /**
   * Proposals whose child was intentionally killed via cancel(). The close
   * handler short-circuits for these so the killed child's non-zero exit does
   * not overwrite the authoritative `cancelled` status nor emit a spurious
   * failure (BUG-LONGTAIL-01).
   */
  private _cancelledIds = new Set<string>()
  /** Pending SIGKILL escalation timers, keyed by proposal id (BUG-LONGTAIL-02). */
  private _killTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-project id for ai_invocations recording (COST-ACCOUNTING-AUDIT
   *  HIGH-6). Optional so pre-wiring call sites keep compiling; recording only
   *  fires when present (the DB is always available on this manager). */
  private _projectId?: string
  private _projectSlug?: string
  private _adapter: ProviderAdapter

  constructor(
    broadcast: (msg: WsMessage) => void,
    db: DbInstance,
    cwd: string,
    projectId?: string,
    providerId: string = 'claude',
    projectSlug?: string,
  ) {
    this._broadcast = broadcast
    this._db = db
    this._cwd = cwd
    this._projectId = projectId
    this._projectSlug = projectSlug
    this._adapter = getAdapter(providerId)
    this._activeProcesses = new Map()
    this._buffers = new Map()
  }

  /** Resolve lazily because a project context is created before Core may
   * populate its relocated workspace during setup. */
  private _execution(): ProjectExecution {
    return resolveProjectExecution({ slug: this._projectSlug, path: this._cwd })
  }

  /**
   * Synchronous route preflight for `/propose`. It deliberately uses the same
   * provider-aware command resolution and lazy execution cwd as the real spawn:
   * Claude resolves installed command markdown, Codex rewrites its native
   * prompt invocation, and Kimi materializes the direct-child SKILL.md.
   */
  canStartExploration(): boolean {
    const execution = this._execution()
    const rawCommand = '/specrails:propose-feature test'
    try {
      const resolved = this._adapter.capabilities.materializeHeadlessSkills
        ? rawCommand
        : resolveCommand(rawCommand, execution.cwd)
      const prompt = resolved === rawCommand
        ? formatProviderCommand(this._adapter, rawCommand, execution.cwd)
        : resolved
      return prompt !== rawCommand
    } catch {
      return false
    }
  }

  private _spawnOptions(
    execution: ProjectExecution,
    options: SpawnOptions,
  ): SpawnOptions {
    if (!execution.relocated) return options
    return {
      ...options,
      extraArgs: [
        ...(options.extraArgs ?? []),
        ...buildProviderRepoAccessArgs(this._adapter, [execution.repoDir]),
      ],
    }
  }

  /**
   * Persist one surface='proposal' ai_invocations row per spawn (exploration,
   * each refinement turn, and issue creation are all separate billable claude
   * runs — HIGH-6). Cost is the native `total_cost_usd` when a terminal `result`
   * event arrived, else the pricing-table estimate over the accumulated
   * per-assistant-event usage (cancelled/killed runs still burned tokens).
   * Best-effort: a recording failure is logged, never thrown.
   */
  private _recordInvocation(
    proposalId: string,
    events: readonly AdapterEvent[],
    status: InvocationStatus,
    startedAtIso: string,
  ): void {
    if (!this._projectId) return
    try {
      const finishedAt = new Date().toISOString()
      const { result, estimated } = finaliseInvocationResult(this._adapter, events, {
        fallbackModel: this._adapter.defaultModel(),
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAtIso)),
      })
      recordInvocation(this._db, {
        id: randomUUID(),
        project_id: this._projectId,
        provider: this._adapter.id,
        surface: 'proposal',
        surface_ref_id: proposalId,
        status,
        started_at: startedAtIso,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
      this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
    } catch (err) {
      console.error('[ProposalManager] recordInvocation failed:', err)
    }
  }

  /**
   * SIGTERM the child's process tree, then arm an unref'd 2s SIGKILL escalation
   * (cleared on the child's 'close'). A child that swallows SIGTERM — or has a
   * blocked git/gh/build subprocess — would otherwise become an unkillable
   * orphan running with --dangerously-skip-permissions (BUG-LONGTAIL-02).
   */
  private _killWithEscalation(proposalId: string, pid: number): void {
    try { treeKill(pid, 'SIGTERM') } catch { /* best-effort */ }
    const existing = this._killTimers.get(proposalId)
    if (existing) clearTimeout(existing)
    const grace = setTimeout(() => {
      this._killTimers.delete(proposalId)
      try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
    }, 2000)
    grace.unref?.()
    this._killTimers.set(proposalId, grace)
  }

  private _clearKillTimer(proposalId: string): void {
    const timer = this._killTimers.get(proposalId)
    if (timer) {
      clearTimeout(timer)
      this._killTimers.delete(proposalId)
    }
  }

  isActive(proposalId: string): boolean {
    return this._activeProcesses.has(proposalId)
  }

  /**
   * Tear down before the project's DB is closed (M12). Disposes so in-flight
   * close/error handlers skip their updateProposal DB writes (which would throw
   * on the closed connection and crash the app), and SIGTERMs orphaned children.
   */
  shutdown(): void {
    this._disposed = true
    for (const [proposalId, child] of this._activeProcesses) {
      if (child.pid) this._killWithEscalation(proposalId, child.pid)
    }
    this._activeProcesses.clear()
    this._buffers.clear()
  }

  async startExploration(proposalId: string, idea: string): Promise<void> {
    const proposal = getProposal(this._db, proposalId)
    if (!proposal) {
      this._broadcastError(proposalId, 'Proposal not found')
      return
    }

    // Resolve the command file — error if not installed
    const execution = this._execution()
    const rawCommand = `/specrails:propose-feature ${idea}`
    const resolved = this._adapter.capabilities.materializeHeadlessSkills
      ? rawCommand
      : resolveCommand(rawCommand, execution.cwd)
    let prompt: string
    try {
      prompt = resolved === rawCommand
        ? formatProviderCommand(this._adapter, rawCommand, execution.cwd)
        : resolved
    } catch (error) {
      updateProposal(this._db, proposalId, { status: 'cancelled' })
      this._broadcastError(
        proposalId,
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    if (prompt === rawCommand) {
      updateProposal(this._db, proposalId, { status: 'cancelled' })
      this._broadcastError(proposalId, 'This project does not have the /specrails:propose-feature command installed. Run "npx specrails-core@latest" to update.')
      return
    }

    updateProposal(this._db, proposalId, { status: 'exploring' })

    const spawnOptions = this._spawnOptions(execution, {
      prompt,
      model: this._adapter.defaultModel(),
      toolPolicy: 'default',
    })
    const args = this._adapter.buildArgs('spec-gen', spawnOptions)

    await this._runProcess(proposalId, args, spawnOptions, execution, (fullText, sessionId) => {
      updateProposal(this._db, proposalId, {
        status: 'review',
        result_markdown: fullText,
        ...(sessionId ? { session_id: sessionId } : {}),
      })
      this._broadcast({
        type: 'proposal_ready',
        projectId: '',
        proposalId,
        markdown: fullText,
        timestamp: new Date().toISOString(),
      })
    }, (error) => {
      updateProposal(this._db, proposalId, { status: 'input' })
      this._broadcastError(proposalId, error ?? 'Exploration failed')
    })
  }

  async sendRefinement(proposalId: string, feedback: string): Promise<void> {
    const proposal = getProposal(this._db, proposalId)
    if (!proposal) {
      this._broadcastError(proposalId, 'Proposal not found')
      return
    }

    if (!proposal.session_id) {
      this._broadcastError(proposalId, 'No session available for refinement')
      return
    }

    updateProposal(this._db, proposalId, { status: 'refining' })

    const execution = this._execution()
    const spawnOptions = this._spawnOptions(execution, {
      prompt: feedback,
      model: this._adapter.defaultModel(),
      sessionId: proposal.session_id,
      toolPolicy: 'default',
    })
    const args = this._adapter.buildArgs('chat-resume', spawnOptions)

    await this._runProcess(proposalId, args, spawnOptions, execution, (fullText, sessionId) => {
      updateProposal(this._db, proposalId, {
        status: 'review',
        result_markdown: fullText,
        ...(sessionId ? { session_id: sessionId } : {}),
      })
      this._broadcast({
        type: 'proposal_refined',
        projectId: '',
        proposalId,
        markdown: fullText,
        timestamp: new Date().toISOString(),
      })
    }, (error) => {
      updateProposal(this._db, proposalId, { status: 'review' })
      this._broadcastError(proposalId, error ?? 'Refinement failed')
    })
  }

  async createIssue(proposalId: string): Promise<void> {
    const proposal = getProposal(this._db, proposalId)
    if (!proposal) {
      this._broadcastError(proposalId, 'Proposal not found')
      return
    }

    if (!proposal.session_id) {
      this._broadcastError(proposalId, 'No session available for issue creation')
      return
    }

    updateProposal(this._db, proposalId, { status: 'refining' })

    const prompt =
      "Based on the proposal above, create a GitHub Issue with the label 'user-proposed'. " +
      "Output only the URL of the created issue on the last line of your response."

    const execution = this._execution()
    const spawnOptions = this._spawnOptions(execution, {
      prompt,
      model: this._adapter.defaultModel(),
      sessionId: proposal.session_id,
      toolPolicy: 'default',
    })
    const args = this._adapter.buildArgs('chat-resume', spawnOptions)

    await this._runProcess(proposalId, args, spawnOptions, execution, (fullText, sessionId) => {
      const match = fullText.match(/https:\/\/github\.com\/[^\s]+\/issues\/\d+/)
      const issueUrl = match ? match[0] : null

      if (issueUrl) {
        updateProposal(this._db, proposalId, {
          status: 'created',
          issue_url: issueUrl,
          ...(sessionId ? { session_id: sessionId } : {}),
        })
        this._broadcast({
          type: 'proposal_issue_created',
          projectId: '',
          proposalId,
          issueUrl,
          timestamp: new Date().toISOString(),
        })
      } else {
        updateProposal(this._db, proposalId, { status: 'review' })
        this._broadcastError(
          proposalId,
          'Issue creation failed — GitHub CLI may not be available or not authenticated'
        )
      }
    }, (error) => {
      updateProposal(this._db, proposalId, { status: 'review' })
      this._broadcastError(proposalId, error ?? 'Issue creation failed')
    })
  }

  cancel(proposalId: string): void {
    // Mark intentionally-cancelled BEFORE killing so the child's non-zero
    // 'close' short-circuits instead of clobbering 'cancelled' (BUG-LONGTAIL-01).
    this._cancelledIds.add(proposalId)
    const child = this._activeProcesses.get(proposalId)
    if (child?.pid) {
      this._killWithEscalation(proposalId, child.pid)
    }
    updateProposal(this._db, proposalId, { status: 'cancelled' })
    this._broadcast({
      type: 'proposal_error',
      projectId: '',
      proposalId,
      error: 'cancelled',
      timestamp: new Date().toISOString(),
    })
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async _runProcess(
    proposalId: string,
    args: string[],
    spawnOptions: SpawnOptions,
    execution: ProjectExecution,
    onSuccess: (fullText: string, sessionId: string | null) => void,
    onError: (error?: string) => void
  ): Promise<void> {
    const child = spawnAiCli(this._adapter.binary, args, {
      env: buildProviderEnv(this._adapter, spawnOptions, {
        ...process.env,
        ...execution.env,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: execution.cwd,
    })

    this._activeProcesses.set(proposalId, child)
    this._buffers.set(proposalId, '')

    let capturedSessionId: string | null = null
    // Accumulate adapter events so a killed/failed spawn is still costed from the
    // per-assistant-event usage snapshots (HIGH-6). Only when project-wired.
    const adapterEvents: AdapterEvent[] = []
    const turnStartedAt = new Date().toISOString()

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      for (const ev of parseStreamEvents(this._adapter, line)) {
        adapterEvents.push(ev)
        if (ev.kind === 'session-started') capturedSessionId = ev.sessionId
        if (ev.kind === 'result') {
          const sid = (ev.payload as { session_id?: string }).session_id
          if (sid) capturedSessionId = sid
        }
        if (ev.kind === 'text-delta') {
          const newText = ev.text
          const prev = this._buffers.get(proposalId) ?? ''
          this._buffers.set(proposalId, prev + newText)
          this._broadcast({
            type: 'proposal_stream',
            projectId: '',
            proposalId,
            delta: newText,
            timestamp: new Date().toISOString(),
          })
        } else if (ev.kind === 'tool-use') {
          this._broadcast({
            type: 'proposal_stream',
            projectId: '',
            proposalId,
            delta: `<!--tool:${ev.name}-->`,
            timestamp: new Date().toISOString(),
          })
        }
      }
    })

    return new Promise<void>((resolve) => {
      // Without this handler an ENOENT on spawn (e.g. `claude` not on
      // PATH) propagates as an unhandled 'error' event and crashes the
      // entire app process. Surface to the user instead.
      /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
      child.on('error', (err) => {
        console.error(`[ProposalManager] spawn failed for ${proposalId}: ${err.message}`)
        this._clearKillTimer(proposalId)
        this._activeProcesses.delete(proposalId)
        this._buffers.delete(proposalId)
        const wasCancelled = this._cancelledIds.delete(proposalId)
        // Record the spend unless the project is being torn down (DB closing).
        if (!this._disposed) {
          this._recordInvocation(proposalId, adapterEvents, wasCancelled ? 'aborted' : 'failed', turnStartedAt)
        }
        if (wasCancelled) { resolve(); return } // intentional cancel; keep 'cancelled' (BUG-LONGTAIL-01)
        if (this._disposed) { resolve(); return } // M12: project removed mid-flight; DB closing
        onError(`Failed to launch ${this._adapter.binary}: ${err.message}`)
        resolve()
      })
      /* c8 ignore stop */
      child.on('close', (code) => {
        const fullText = this._buffers.get(proposalId) ?? ''
        this._clearKillTimer(proposalId)
        this._activeProcesses.delete(proposalId)
        this._buffers.delete(proposalId)
        const wasCancelled = this._cancelledIds.delete(proposalId)
        const providerError = adapterEvents.find(
          (event): event is Extract<AdapterEvent, { kind: 'error' }> =>
            event.kind === 'error',
        )?.message
        // Record the spend regardless of cancel/done outcome (the tokens were
        // burned either way) — but NOT when the project is being torn down, since
        // its DB is closing (recordInvocation would throw). Cancel/kill → aborted;
        // non-zero exit → failed; clean exit → success (HIGH-6).
        if (!this._disposed) {
          const status: InvocationStatus =
            wasCancelled ? 'aborted' : code === 0 && !providerError ? 'success' : 'failed'
          this._recordInvocation(proposalId, adapterEvents, status, turnStartedAt)
        }
        // A cancel() killed this child intentionally; its non-zero exit must NOT
        // overwrite the 'cancelled' status or emit a failure (BUG-LONGTAIL-01).
        if (wasCancelled) { resolve(); return }
        if (this._disposed) { resolve(); return } // M12: project removed mid-flight; DB closing

        if (code === 0 && !providerError) {
          onSuccess(fullText, capturedSessionId)
        } else {
          onError(providerError)
        }

        resolve()
      })
    })
  }

  private _broadcastError(proposalId: string, error: string): void {
    this._broadcast({
      type: 'proposal_error',
      projectId: '',
      proposalId,
      error,
      timestamp: new Date().toISOString(),
    })
  }
}
