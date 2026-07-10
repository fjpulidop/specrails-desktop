import fs from 'fs'
import path from 'path'
import { ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import { testCustomAgent } from './agent-generator'
import { recordInvocation } from './ai-invocations'
import { finaliseInvocationResult } from './result-event'
import { runAiCliInvocation } from './spawn-lifecycle'
import { resolveProjectExecution } from './workspace-resolution'
import {
  getAdapter,
  type ProviderAdapter,
  type AdapterEvent,
  type ProviderId,
  type SpawnOptions,
} from './providers'
import type { DbInstance } from './db'
import type {
  WsMessage,
  AgentRefinePhase,
} from './types'
import {
  createRefineSession,
  getRefineSession,
  updateRefineSession,
  deleteRefineSession,
  type RefineHistoryTurn,
  type RefineSessionRow,
} from './agent-refine-db'

const CUSTOM_PREFIX = /^custom-[a-z0-9][a-z0-9-]*$/
const SMART_TEST_DEBOUNCE_MS = 5_000

export interface StartRefineOptions {
  agentId: string
  instruction: string
  autoTest?: boolean
}

export interface SendTurnOptions {
  refineId: string
  instruction: string
}

export interface ApplyResult {
  ok: boolean
  reason?: 'disk_changed' | 'name_changed' | 'session_not_found' | 'invalid_state' | 'agent_not_found'
  version?: number
  body?: string
}

interface ApplyOptions {
  refineId: string
  /** When true, skip the disk-hash guard (force-apply). */
  force?: boolean
}

/**
 * Manager for AI-driven iterative refinement of custom agent .md files.
 *
 * Mirrors ProposalManager: spawn `claude` with stream-json, capture session id
 * on first turn, resume on follow-ups. Streams deltas + phase pills over WS.
 */
export class AgentRefineManager {
  private _broadcast: (msg: WsMessage) => void
  private _db: DbInstance
  private _projectPath: string
  private _projectId: string | undefined
  private _adapter: ProviderAdapter
  private _activeProcesses = new Map<string, ChildProcess>()
  private _bodyBuffers = new Map<string, string>()
  private _disposed = false
  /**
   * Refine sessions whose child was intentionally killed via cancel(). The
   * post-spawn settle path short-circuits for these so the killed child's
   * non-zero exit does not overwrite the authoritative 'cancelled' status with
   * 'error' nor emit a spurious failure (BUG-LONGTAIL-01).
   */
  private _cancelledIds = new Set<string>()
  /** Pending SIGKILL escalation timers, keyed by refine id (BUG-LONGTAIL-02). */
  private _killTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Provider evidence retained outside the awaiting stack so shutdown can
   *  account it while the project DB is still open. */
  private _liveAccounting = new Map<string, {
    events: AdapterEvent[]
    model: string
    startedAt: string
  }>()

  constructor(
    broadcast: (msg: WsMessage) => void,
    db: DbInstance,
    projectPath: string,
    projectId?: string,
    provider?: ProviderId,
  ) {
    this._broadcast = broadcast
    this._db = db
    this._projectPath = projectPath
    this._projectId = projectId
    this._adapter = getAdapter(provider ?? 'claude')
  }

  isActive(refineId: string): boolean {
    return this._activeProcesses.has(refineId)
  }

  /**
   * SIGTERM the child's process tree, then arm an unref'd 2s SIGKILL escalation
   * (cleared once the spawn settles). A child that swallows SIGTERM — or has a
   * blocked tool subprocess — would otherwise become an unkillable orphan
   * running with --dangerously-skip-permissions (BUG-LONGTAIL-02).
   */
  private _killWithEscalation(refineId: string, pid: number): void {
    try { treeKill(pid, 'SIGTERM') } catch { /* best-effort */ }
    const existing = this._killTimers.get(refineId)
    if (existing) clearTimeout(existing)
    const grace = setTimeout(() => {
      this._killTimers.delete(refineId)
      try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
    }, 2000)
    grace.unref?.()
    this._killTimers.set(refineId, grace)
  }

  private _clearKillTimer(refineId: string): void {
    const timer = this._killTimers.get(refineId)
    if (timer) {
      clearTimeout(timer)
      this._killTimers.delete(refineId)
    }
  }

  /**
   * Tear down before the project's DB is closed (M12). Marks the manager disposed
   * so in-flight close/error handlers short-circuit instead of writing to a
   * closed connection (which throws synchronously inside the EventEmitter and,
   * with no uncaughtException handler, crashes the whole app), and SIGTERMs any
   * orphaned refine child. Idempotent.
   */
  shutdown(): void {
    if (this._disposed) return
    this._disposed = true
    for (const [refineId, live] of this._liveAccounting) {
      this._recordRefineInvocation(refineId, live.events, live.model, 'aborted', live.startedAt)
    }
    this._liveAccounting.clear()
    for (const [refineId, child] of this._activeProcesses) {
      if (child.pid) this._killWithEscalation(refineId, child.pid)
    }
    this._activeProcesses.clear()
    this._bodyBuffers.clear()
  }

  /** Start a new refine session for the given custom agent. */
  async startRefine(opts: StartRefineOptions): Promise<{ refineId: string }> {
    this._assertActive()
    if (!CUSTOM_PREFIX.test(opts.agentId)) {
      throw new Error('not_a_custom_agent')
    }
    const file = this._agentFile(opts.agentId)
    if (!fs.existsSync(file)) {
      throw new Error('agent_not_found')
    }
    const body = fs.readFileSync(file, 'utf8')
    const baseHash = sha256(body)
    const baseVersion = this._currentVersion(opts.agentId)
    const refineId = randomUUID()
    createRefineSession(this._db, {
      id: refineId,
      agentId: opts.agentId,
      baseVersion,
      baseBodyHash: baseHash,
      autoTest: opts.autoTest !== false,
    })
    // Seed history with the user's instruction so reconnects show full thread.
    this._appendHistory(refineId, { role: 'user', content: opts.instruction, timestamp: Date.now() })

    void this._runTurn(refineId, opts.instruction, /* isFirst */ true, body)
    return { refineId }
  }

  /** Send a follow-up instruction on an existing session. */
  async sendTurn(opts: SendTurnOptions): Promise<void> {
    this._assertActive()
    const session = getRefineSession(this._db, opts.refineId)
    if (!session) throw new Error('session_not_found')
    if (session.status === 'streaming') throw new Error('turn_in_progress')
    if (!session.session_id) throw new Error('no_session_id')
    this._appendHistory(opts.refineId, { role: 'user', content: opts.instruction, timestamp: Date.now() })
    void this._runTurn(opts.refineId, opts.instruction, /* isFirst */ false, null)
  }

  /** Cancel an in-flight session. Idempotent. */
  cancel(refineId: string): void {
    this._assertActive()
    const child = this._activeProcesses.get(refineId)
    if (child?.pid) {
      // Mark intentionally-cancelled BEFORE killing so the spawn's settle path
      // short-circuits instead of clobbering 'cancelled' with 'error'
      // (BUG-LONGTAIL-01), and escalate to SIGKILL (BUG-LONGTAIL-02).
      this._cancelledIds.add(refineId)
      this._killWithEscalation(refineId, child.pid)
    }
    const existing = getRefineSession(this._db, refineId)
    if (existing) {
      updateRefineSession(this._db, refineId, { status: 'cancelled', phase: 'idle' })
    }
    this._broadcast({
      type: 'agent_refine_cancelled',
      projectId: '',
      refineId,
      timestamp: new Date().toISOString(),
    })
  }

  /** Toggle auto-test for a session. */
  toggleAutoTest(refineId: string, enabled: boolean): void {
    this._assertActive()
    const session = getRefineSession(this._db, refineId)
    if (!session) throw new Error('session_not_found')
    updateRefineSession(this._db, refineId, { auto_test: enabled ? 1 : 0 })
  }

  /** Apply the current draft_body to disk through the standard write path. */
  apply(opts: ApplyOptions): ApplyResult {
    this._assertActive()
    const session = getRefineSession(this._db, opts.refineId)
    if (!session) return { ok: false, reason: 'session_not_found' }
    if (!session.draft_body) return { ok: false, reason: 'invalid_state' }
    const file = this._agentFile(session.agent_id)
    if (!fs.existsSync(file)) return { ok: false, reason: 'agent_not_found' }
    const currentBody = fs.readFileSync(file, 'utf8')
    if (!opts.force && sha256(currentBody) !== session.base_body_hash) {
      return { ok: false, reason: 'disk_changed' }
    }
    const draftName = extractFrontmatterName(session.draft_body)
    const currentName = extractFrontmatterName(currentBody) ?? session.agent_id
    if (draftName && draftName !== currentName) {
      return { ok: false, reason: 'name_changed' }
    }
    fs.writeFileSync(file, session.draft_body, 'utf8')
    const maxVersion = (this._db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE agent_name = ?`)
      .get(session.agent_id) as { v: number }).v
    const nextVersion = maxVersion + 1
    this._db.prepare(
      `INSERT INTO agent_versions (agent_name, version, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run(session.agent_id, nextVersion, session.draft_body, Date.now())
    updateRefineSession(this._db, opts.refineId, { status: 'applied', phase: 'done' })
    this._broadcast({
      type: 'agent_refine_applied',
      projectId: '',
      refineId: opts.refineId,
      agentId: session.agent_id,
      version: nextVersion,
      timestamp: new Date().toISOString(),
    })
    // Also broadcast the standard catalog change event so existing UI updates.
    this._broadcast({ type: 'agent.changed', projectId: '', id: session.agent_id } as never)
    return { ok: true, version: nextVersion, body: session.draft_body }
  }

  /** Hard-delete a session (used by cleanup/admin paths). */
  destroy(refineId: string): void {
    this._assertActive()
    this.cancel(refineId)
    deleteRefineSession(this._db, refineId)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _assertActive(): void {
    if (this._disposed) throw new Error('manager_disposed')
  }

  private _agentFile(agentId: string): string {
    // Per-provider on-disk layout:
    //   claude → <root>/.claude/agents/<agentId>.md
    //   codex  → <root>/.codex/skills/<agentId>/SKILL.md
    // Future providers add their own branch via the adapter; the projectDir
    // is already provider-aware.
    //
    // Relocate-artifacts: custom-* agents are materialized by core into the
    // WORKSPACE when the project is relocated (same place the rails load them
    // from). Reading/writing `<project.path>/<providerDir>/agents` would touch a
    // stale repo copy the rails never see — and this path WRITES the refined
    // agent. Resolve through the gate so reads + writes hit the same tree the
    // rails consume. Legacy projects are byte-identical (root === project.path).
    const exec = resolveProjectExecution({ path: this._projectPath })
    const root = exec.relocated && exec.workspaceDir ? exec.workspaceDir : this._projectPath
    if (this._adapter.id === 'codex') {
      return path.join(root, this._adapter.projectDirName, 'skills', agentId, 'SKILL.md')
    }
    return path.join(root, this._adapter.projectDirName, 'agents', `${agentId}.md`)
  }

  private _currentVersion(agentId: string): number {
    const row = this._db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE agent_name = ?`)
      .get(agentId) as { v: number }
    return row.v
  }

  private _appendHistory(refineId: string, turn: RefineHistoryTurn): void {
    const session = getRefineSession(this._db, refineId)
    if (!session) return
    updateRefineSession(this._db, refineId, { history: [...session.history, turn] })
  }

  private async _runTurn(
    refineId: string,
    instruction: string,
    isFirst: boolean,
    bodyForFirstTurn: string | null,
  ): Promise<void> {
    const session = getRefineSession(this._db, refineId)
    if (!session) return

    updateRefineSession(this._db, refineId, { status: 'streaming', phase: 'reading' })
    this._emitPhase(refineId, 'reading')

    const prompt = isFirst
      ? buildFirstTurnPrompt({
          agentId: session.agent_id,
          currentBody: bodyForFirstTurn ?? '',
          userInstruction: instruction,
        })
      : instruction

    const action = !isFirst && session.session_id && this._adapter.capabilities.nativeResume
      ? 'chat-resume' as const
      : 'agent-refine' as const
    const refineModel = this._adapter.defaultModel()
    const buildOpts: SpawnOptions = {
      prompt,
      model: refineModel,
      sessionId: session.session_id ?? undefined,
      // The model receives the complete current agent body in its prompt and
      // must only return a replacement body. Repo tools cannot improve this
      // contract and would turn prompt text into filesystem authority.
      toolPolicy: 'none',
    }
    const args = this._adapter.buildArgs(action, buildOpts)

    let drafted = false
    this._bodyBuffers.set(refineId, '')
    const turnStartedAt = new Date().toISOString()
    const spawnState: { err: Error | null } = { err: null }
    const liveAccounting = { events: [] as AdapterEvent[], model: refineModel, startedAt: turnStartedAt }
    this._liveAccounting.set(refineId, liveAccounting)

    // Spawn / stream / settlement is owned by the shared spawn-lifecycle; the
    // refine-specific draft buffering, accounting, validation and history all
    // stay here unchanged.
    // Relocate-artifacts gate: spawn from the workspace (with SPECRAILS_REPO_DIR)
    // when relocated, else cwd = project.path + empty env (byte-identical legacy).
    const refineExec = resolveProjectExecution({ path: this._projectPath })
    const refineEnv = refineExec.relocated ? { ...process.env, ...refineExec.env } : undefined
    const run = await runAiCliInvocation({
      adapter: this._adapter,
      // Pass the already-policy-bound argv so first turns and native resumes
      // cannot diverge if the lifecycle rebuilds options later.
      argv: args,
      cwd: refineExec.cwd,
      env: refineEnv,
      onSpawn: (child) => this._activeProcesses.set(refineId, child),
      onSpawnError: (err) => { spawnState.err = err },
      onEvent: (ev) => {
        if (this._disposed) return
        liveAccounting.events.push(ev)
        switch (ev.kind) {
          case 'text-delta': {
            if (!drafted) {
              drafted = true
              updateRefineSession(this._db, refineId, { phase: 'drafting' })
              this._emitPhase(refineId, 'drafting')
            }
            const prev = this._bodyBuffers.get(refineId) ?? ''
            const next = prev + ev.text
            this._bodyBuffers.set(refineId, next)
            this._broadcast({
              type: 'agent_refine_stream',
              projectId: '',
              refineId,
              delta: ev.text,
              timestamp: new Date().toISOString(),
            })
            updateRefineSession(this._db, refineId, { draft_body: next })
            break
          }
          case 'tool-use':
            this._broadcast({
              type: 'agent_refine_stream',
              projectId: '',
              refineId,
              delta: `<!--tool:${ev.name}-->`,
              timestamp: new Date().toISOString(),
            })
            break
          default:
            break
        }
      },
    })

    this._clearKillTimer(refineId)
    this._activeProcesses.delete(refineId)
    this._liveAccounting.delete(refineId)
    const fullDraft = this._bodyBuffers.get(refineId) ?? ''
    this._bodyBuffers.delete(refineId)
    // A cancel() killed this child intentionally; its non-zero exit must NOT
    // overwrite the 'cancelled' status with 'error' or emit a failure
    // (BUG-LONGTAIL-01). But real tokens may already have streamed, so record an
    // 'aborted' ai_invocations row (with an estimated cost over the accumulated
    // adapter events) BEFORE short-circuiting — otherwise the cancel path loses
    // 100% of its spend (MED-12). No status overwrite, no failure emit.
    const wasCancelled = this._cancelledIds.delete(refineId)
    // shutdown() already flushed this live run synchronously while the DB was
    // open. A cancel racing with project removal must not insert it twice.
    if (this._disposed) return
    if (wasCancelled) {
      this._recordRefineInvocation(refineId, run.events, refineModel, 'aborted', turnStartedAt)
      return // cancel (BUG-LONGTAIL-01)
    }

    if (run.spawnFailed) {
      this._emitError(refineId, `Failed to launch claude: ${spawnState.err?.message ?? 'spawn error'}`)
      updateRefineSession(this._db, refineId, { status: 'error', phase: 'idle' })
      return
    }

    const capturedSessionId = run.sessionId
    const adapterEvents = run.events
    const code = run.code
    const stderr = run.stderrTail

    // ai_invocations capture (surface='ai-edit'). One row per refine turn.
    const invStatus = code === 0 && fullDraft.trim() ? 'success' : 'failed'
    this._recordRefineInvocation(refineId, adapterEvents, refineModel, invStatus, turnStartedAt)

    if (code !== 0 || !fullDraft.trim()) {
      this._emitError(
        refineId,
        code !== 0
          ? `claude exited with code ${code}${stderr ? `: ${stderr.slice(-300)}` : ''}`
          : 'claude returned empty output',
      )
      updateRefineSession(this._db, refineId, { status: 'error', phase: 'idle' })
      return
    }

    // Validation phase.
    updateRefineSession(this._db, refineId, { phase: 'validating' })
    this._emitPhase(refineId, 'validating')
    const stripped = stripToolMarkers(fullDraft)
    const validation = validateAgentBody(stripped, this._adapter.id)
    if (!validation.ok) {
      this._emitError(refineId, `Frontmatter invalid: ${validation.error}`)
      updateRefineSession(this._db, refineId, { status: 'error', phase: 'idle', draft_body: stripped })
      return
    }

    // Append assistant turn to history (use stripped body — markers gone).
    this._appendHistory(refineId, {
      role: 'assistant',
      content: stripped,
      timestamp: Date.now(),
    })

    const patch = {
      status: 'ready' as const,
      phase: 'done' as AgentRefinePhase,
      draft_body: stripped,
      ...(capturedSessionId ? { session_id: capturedSessionId } : {}),
    }
    updateRefineSession(this._db, refineId, patch)
    this._broadcast({
      type: 'agent_refine_ready',
      projectId: '',
      refineId,
      draftBody: stripped,
      timestamp: new Date().toISOString(),
    })
    this._emitPhase(refineId, 'done')

    // Smart-mode auto-test: only run if enabled, body changed since last
    // test, and >5s elapsed. Best-effort; failures are non-fatal.
    const session2 = getRefineSession(this._db, refineId)
    if (session2 && session2.auto_test === 1) {
      const draftHash = sha256(stripped)
      const recent =
        session2.last_test_at !== null && Date.now() - session2.last_test_at < SMART_TEST_DEBOUNCE_MS
      const sameBody = session2.last_test_hash === draftHash
      if (!recent && !sameBody) {
        void this._runAutoTest(refineId, session2.agent_id, stripped, draftHash)
      }
    }
  }

  /**
   * Record one ai_invocations row (surface='ai-edit') for a refine turn. Used
   * by the normal settle path (status 'success'|'failed') AND the cancel/dispose
   * early-return path (status 'aborted') so streamed tokens are never lost
   * (MED-12). finaliseInvocationResult yields native cost when present, else an
   * estimated cost over the accumulated adapter events (estimated=true). Wrapped
   * so a DB failure (e.g. a closing DB during dispose) never crashes the manager.
   */
  private _recordRefineInvocation(
    refineId: string,
    adapterEvents: AdapterEvent[],
    model: string,
    status: 'success' | 'failed' | 'aborted',
    startedAt: string,
  ): void {
    if (!this._projectId) return
    try {
      const { result: normalised, estimated } = finaliseInvocationResult(
        this._adapter,
        adapterEvents,
        { fallbackModel: model },
      )
      recordInvocation(this._db, {
        id: randomUUID(),
        project_id: this._projectId,
        provider: this._adapter.id,
        surface: 'ai-edit',
        surface_ref_id: refineId,
        status,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        total_cost_usd_estimated: estimated,
        ...normalised,
      })
      this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
    } catch (err) {
      console.error('[agent-refine-manager] recordInvocation failed:', err)
    }
  }

  private async _runAutoTest(
    refineId: string,
    agentId: string,
    draftBody: string,
    draftHash: string,
  ): Promise<void> {
    if (this._disposed) return
    updateRefineSession(this._db, refineId, { phase: 'testing' })
    this._emitPhase(refineId, 'testing')
    const sampleTask = pickSampleTask(this._db, agentId)
    try {
      const result = await testCustomAgent(this._projectPath, {
        draftBody,
        sampleTask,
        // MED-3: the default-on per-refine-turn auto-test is a billable claude
        // spawn — record it (surface='agent-studio') when we have a project DB.
        record: this._projectId
          ? { db: this._db, projectId: this._projectId, surfaceRefId: refineId, broadcast: this._broadcast }
          : undefined,
      })
      if (this._disposed) return
      this._db.prepare(
        `INSERT INTO agent_tests (agent_name, draft_hash, sample_task_id, tokens, duration_ms, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(agentId, result.draftHash, null, result.tokens, result.durationMs, result.output, Date.now())
      updateRefineSession(this._db, refineId, {
        last_test_at: Date.now(),
        last_test_hash: draftHash,
        phase: 'done',
      })
      this._appendHistory(refineId, {
        role: 'system',
        kind: 'test_result',
        content: result.output,
        timestamp: Date.now(),
      })
      this._broadcast({
        type: 'agent_refine_test',
        projectId: '',
        refineId,
        result: { output: result.output, tokens: result.tokens, durationMs: result.durationMs },
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      if (this._disposed) return
      this._emitError(refineId, `Auto-test failed: ${(err as Error).message}`)
      updateRefineSession(this._db, refineId, { phase: 'done' })
    }
  }

  private _emitPhase(refineId: string, phase: AgentRefinePhase): void {
    this._broadcast({
      type: 'agent_refine_phase',
      projectId: '',
      refineId,
      phase,
      timestamp: new Date().toISOString(),
    })
  }

  private _emitError(refineId: string, error: string): void {
    this._broadcast({
      type: 'agent_refine_error',
      projectId: '',
      refineId,
      error,
      timestamp: new Date().toISOString(),
    })
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function stripToolMarkers(s: string): string {
  return s.replace(/<!--tool:[^>]+-->/g, '').trim()
}

function extractFrontmatterName(body: string): string | null {
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const m = fm[1].match(/^name:\s*(\S+)/m)
  return m ? m[1].trim() : null
}

interface ValidationResult {
  ok: boolean
  error?: string
}

export function validateAgentBody(body: string, providerId: string = 'claude'): ValidationResult {
  const trimmed = body.trim()
  if (!trimmed.startsWith('---')) return { ok: false, error: 'missing YAML frontmatter' }
  const fm = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return { ok: false, error: 'unterminated YAML frontmatter' }
  const block = fm[1]
  if (!/^name:\s*\S+/m.test(block)) return { ok: false, error: 'frontmatter must include `name:`' }
  if (!/^description:/m.test(block)) return { ok: false, error: 'frontmatter must include `description:`' }
  // Per-provider model field rules:
  //   - claude: `.claude/agents/sr-*.md` frontmatter requires `model:` from
  //     the short alias set (sonnet/opus/haiku) for the Task tool to resolve.
  //   - codex: SKILL.md format has no `model:` field — model is decided at
  //     spawn time via `--model`. Skip the model check entirely.
  if (providerId === 'claude' && !/^model:\s*(sonnet|opus|haiku)/m.test(block)) {
    return { ok: false, error: 'frontmatter `model:` must be sonnet|opus|haiku' }
  }
  return { ok: true }
}

export function buildFirstTurnPrompt(opts: {
  agentId: string
  currentBody: string
  userInstruction: string
}): string {
  return [
    'You are refining an existing custom agent. The user wants to iterate on its',
    'definition. Output the COMPLETE refined `.md` file — full YAML frontmatter',
    'between `---` separators, then the body. Do not include code fences,',
    'commentary, or explanations. Start at `---`.',
    '',
    'Hard rules:',
    '  1. Frontmatter MUST include `name`, `description`, and `model` (one of',
    '     `sonnet`, `opus`, `haiku`).',
    `  2. The frontmatter \`name\` MUST remain exactly: ${opts.agentId}`,
    '  3. The id `name` is locked; renaming is a separate explicit action.',
    '',
    `Agent id: ${opts.agentId}`,
    '',
    'Current agent file:',
    '```markdown',
    opts.currentBody,
    '```',
    '',
    `User refinement request:`,
    opts.userInstruction,
    '',
    'Output only the new file content, starting with `---`.',
  ].join('\n')
}

function pickSampleTask(db: DbInstance, agentId: string): string {
  try {
    const row = db
      .prepare(
        `SELECT output FROM agent_tests
         WHERE agent_name = ? AND sample_task_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId) as { output: string } | undefined
    if (row?.output) return row.output
  } catch { /* ignore */ }
  return DEFAULT_SAMPLE_TASK
}

const DEFAULT_SAMPLE_TASK = [
  'Demonstrate how you would handle a small representative task within your',
  'declared focus areas. Keep the answer under 150 words.',
].join(' ')

/** Build a public, JSON-friendly view of a session for the GET /refine/:id endpoint. */
export function refineSessionToJson(row: RefineSessionRow): {
  id: string
  agentId: string
  status: string
  phase: string
  autoTest: boolean
  draftBody: string | null
  history: RefineHistoryTurn[]
  baseVersion: number
  createdAt: number
  updatedAt: number
} {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    phase: row.phase,
    autoTest: row.auto_test === 1,
    draftBody: row.draft_body,
    history: row.history,
    baseVersion: row.base_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
