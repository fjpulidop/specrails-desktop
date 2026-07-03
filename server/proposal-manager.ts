import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import { spawnClaude } from './util/cli-prompt'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import {
  getProposal,
  updateProposal,
} from './db'
import { resolveCommand } from './command-resolver'
import { getAdapter, type ProviderAdapter, type AdapterEvent } from './providers'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'

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
  /** claude adapter — the proposal flows only ever spawn claude. */
  private _adapter: ProviderAdapter = getAdapter('claude')

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance, cwd: string, projectId?: string) {
    this._broadcast = broadcast
    this._db = db
    this._cwd = cwd
    this._projectId = projectId
    this._activeProcesses = new Map()
    this._buffers = new Map()
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
      const { result, estimated } = finaliseInvocationResult(this._adapter, events, {
        fallbackModel: this._adapter.defaultModel(),
      })
      recordInvocation(this._db, {
        id: randomUUID(),
        project_id: this._projectId,
        provider: this._adapter.id,
        surface: 'proposal',
        surface_ref_id: proposalId,
        status,
        started_at: startedAtIso,
        finished_at: new Date().toISOString(),
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
    const rawCommand = `/specrails:propose-feature ${idea}`
    const prompt = resolveCommand(rawCommand, this._cwd)
    if (prompt === rawCommand) {
      updateProposal(this._db, proposalId, { status: 'cancelled' })
      this._broadcastError(proposalId, 'This project does not have the /specrails:propose-feature command installed. Run "npx specrails-core@latest" to update.')
      return
    }

    updateProposal(this._db, proposalId, { status: 'exploring' })

    const args = [
      '--dangerously-skip-permissions',
      '--tools', 'default',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', prompt,
    ]

    await this._runProcess(proposalId, args, (fullText, sessionId) => {
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
    }, () => {
      updateProposal(this._db, proposalId, { status: 'input' })
      this._broadcastError(proposalId, 'Exploration failed')
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

    const args = [
      '--dangerously-skip-permissions',
      '--tools', 'default',
      '--output-format', 'stream-json',
      '--verbose',
      '--resume', proposal.session_id,
      '-p', feedback,
    ]

    await this._runProcess(proposalId, args, (fullText, sessionId) => {
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
    }, () => {
      updateProposal(this._db, proposalId, { status: 'review' })
      this._broadcastError(proposalId, 'Refinement failed')
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

    const args = [
      '--dangerously-skip-permissions',
      '--tools', 'default',
      '--output-format', 'stream-json',
      '--verbose',
      '--resume', proposal.session_id,
      '-p', prompt,
    ]

    await this._runProcess(proposalId, args, (fullText, sessionId) => {
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
    }, () => {
      updateProposal(this._db, proposalId, { status: 'review' })
      this._broadcastError(proposalId, 'Issue creation failed')
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
    onSuccess: (fullText: string, sessionId: string | null) => void,
    onError: () => void
  ): Promise<void> {
    // spawnClaude reroutes multi-line argv values through stdin on Windows.
    const child = spawnClaude(args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this._cwd,
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
      if (this._projectId) {
        const ev = this._adapter.parseStreamLine(line)
        if (ev) adapterEvents.push(ev)
      }

      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* skip non-JSON */ }
      if (!parsed) return

      const eventType = parsed.type as string

      if (eventType === 'result') {
        const sid = parsed.session_id as string | undefined
        if (sid) capturedSessionId = sid
      }

      if (eventType === 'assistant') {
        const msg = parsed.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
        const blocks = msg?.content ?? []

        // Extract text from text blocks (skip thinking blocks)
        const texts = blocks
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
        const newText = texts.join('')
        if (newText) {
          const prev = this._buffers.get(proposalId) ?? ''
          this._buffers.set(proposalId, prev + newText)
          this._broadcast({
            type: 'proposal_stream',
            projectId: '',
            proposalId,
            delta: newText,
            timestamp: new Date().toISOString(),
          })
        }

        // Broadcast tool_use activity so the UI can show "reading codebase..."
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            this._broadcast({
              type: 'proposal_stream',
              projectId: '',
              proposalId,
              delta: `<!--tool:${block.name}-->`,
              timestamp: new Date().toISOString(),
            })
          }
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
        this._broadcastError(proposalId, `Failed to launch claude: ${err.message}`)
        onError()
        resolve()
      })
      /* c8 ignore stop */
      child.on('close', (code) => {
        const fullText = this._buffers.get(proposalId) ?? ''
        this._clearKillTimer(proposalId)
        this._activeProcesses.delete(proposalId)
        this._buffers.delete(proposalId)
        const wasCancelled = this._cancelledIds.delete(proposalId)
        // Record the spend regardless of cancel/done outcome (the tokens were
        // burned either way) — but NOT when the project is being torn down, since
        // its DB is closing (recordInvocation would throw). Cancel/kill → aborted;
        // non-zero exit → failed; clean exit → success (HIGH-6).
        if (!this._disposed) {
          const status: InvocationStatus = wasCancelled ? 'aborted' : code === 0 ? 'success' : 'failed'
          this._recordInvocation(proposalId, adapterEvents, status, turnStartedAt)
        }
        // A cancel() killed this child intentionally; its non-zero exit must NOT
        // overwrite the 'cancelled' status or emit a failure (BUG-LONGTAIL-01).
        if (wasCancelled) { resolve(); return }
        if (this._disposed) { resolve(); return } // M12: project removed mid-flight; DB closing

        if (code === 0) {
          onSuccess(fullText, capturedSessionId)
        } else {
          onError()
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
