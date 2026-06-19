import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { getConversation, addMessage, updateConversation, getStats, listJobs } from './db'
import { resolveCommand } from './command-resolver'
import { spawnAiCli } from './util/cli-prompt'
import { ensureExploreCwd } from './explore-cwd-manager'
import { recordInvocation } from './ai-invocations'
import { finaliseInvocationResult } from './result-event'
import { randomUUID } from 'crypto'
import { parseSpecDraftBlocks, applyBlocks, type ConversationDraftState } from './spec-draft-parser'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { getAdapter, type ProviderAdapter, type AdapterEvent, type ProviderId } from './providers'
import {
  buildScopedSystemPromptPrefix, toolFlagsForScope, normalizeContextScope,
  defaultBootScope, type ContextScope,
} from './context-scope'
import { buildUserMcpArgs } from './user-mcp-config'
import { binaryOnPath } from './binary-probe'
import { ExploreStdinSessions, isExplorePersistentStdinEnabled } from './explore-stdin-session'
import { resolveProjectExecution, type ProjectExecution } from './workspace-resolution'
import type { ChatConversationRow } from './types'

const COMMAND_INSTRUCTION =
  'When you want to suggest a SpecRails command for the user to execute, wrap it in a command block like this: ' +
  ':::command\n/specrails:implement #42\n::: ' +
  'The user will be prompted to confirm before the command runs.'

function extractCommandProposals(text: string): string[] {
  const regex = /:::command\s*\n([\s\S]*?):::/g
  const results: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1].trim())
  }
  return results
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  /** Skip the heavy system prompt (dashboard stats/jobs) and use a minimal one */
  lightweight?: boolean
  /** Limit Claude's agentic tool-use turns (maps to --max-turns) */
  maxTurns?: number
  /**
   * Optional file attachments to fold into the prompt. Resolves to
   * `<user-attachment>` text blocks (image refs / extracted text) appended
   * under "## Attached Resources" and adds the USER_ATTACHMENT_SYSTEM_NOTE
   * to the system prompt so the model treats them as untrusted input.
   */
  attachments?: {
    /** Project slug used by AttachmentManager for path resolution */
    slug: string
    /** Pending spec id (or real ticket id) the attachments are stored under */
    ticketKey: string
    /** Attachment ids to include with this turn */
    ids: string[]
  }
}

// ─── Explore lifecycle ────────────────────────────────────────────────────────

/** Tunables for Explore-spec acceleration lifecycle. Module-level constants
 *  rather than ChatManager statics so tests can override via vi.spyOn or
 *  redefine in fixtures. */
export const EXPLORE_IDLE_KILL_MS = 2 * 60 * 1000
export const EXPLORE_MAX_CONCURRENCY = 5
export const EXPLORE_QUEUE_TIMEOUT_MS = 30 * 1000

interface ExploreLifecycle {
  isMinimized: boolean
  isStreaming: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  crashCount: number
  lastActivityAt: number
}

// ─── ChatManager ──────────────────────────────────────────────────────────────

export class ChatManager {
  private _broadcast: (msg: WsMessage) => void
  private _db: DbInstance
  private _activeProcesses: Map<string, ChildProcess>
  /** M13: conversations with a turn in-flight but not yet spawned. Closes the
   *  TOCTOU window between sendMessage's initial guard and `_activeProcesses.set`
   *  across the explore-slot/attachment awaits, so a second concurrent POST for
   *  the same conversation is rejected instead of double-spawning. */
  private _reservedTurns: Set<string> = new Set()
  private _buffers: Map<string, string>
  private _emittedProposals: Map<string, Set<string>>
  private _abortingConversations: Set<string>
  private _specDraftStates: Map<string, ConversationDraftState>
  /** Per-conversation live-strip state for `\`\`\`spec-draft` fenced blocks. */
  private _streamFilters: Map<string, StreamFilterState>
  /** Per-Explore-conversation lifecycle state (idle timer, crash counter,
   *  streaming flag). See design.md D7. */
  private _exploreLifecycle: Map<string, ExploreLifecycle>
  /** FIFO queue of Explore turns waiting for a concurrency slot. */
  private _exploreQueue: Array<{
    conversationId: string
    enqueuedAt: number
    timeoutTimer: ReturnType<typeof setTimeout>
    onSlot: () => void
    onTimeout: () => void
  }>

  /** Persistent-stdin Explore transport (big bet #3, flag-gated default OFF).
   *  Holds long-lived claude children that survive between turns. */
  private _stdinSessions = new ExploreStdinSessions()

  private _cwd: string | undefined
  private _projectName: string | undefined
  private _adapter: ProviderAdapter
  private _projectId: string | undefined
  private _projectSlug: string | undefined

  constructor(
    broadcast: (msg: WsMessage) => void,
    db: DbInstance,
    cwd?: string,
    projectName?: string,
    provider?: ProviderId,
    projectId?: string,
    projectSlug?: string,
  ) {
    this._broadcast = broadcast
    this._db = db
    this._cwd = cwd
    this._projectName = projectName
    this._adapter = getAdapter(provider ?? 'claude')
    this._projectId = projectId
    this._projectSlug = projectSlug
    this._activeProcesses = new Map()
    this._buffers = new Map()
    this._emittedProposals = new Map()
    this._abortingConversations = new Set()
    this._specDraftStates = new Map()
    this._streamFilters = new Map()
    this._exploreLifecycle = new Map()
    this._exploreQueue = []
  }

  /** Compatibility accessor for tests that introspect the resolved provider. */
  get provider(): string {
    return this._adapter.id
  }

  /**
   * Resolve the adapter for a conversation. A conversation may carry its own
   * `provider` (set at creation from the Add Spec AI Engine selector); when
   * present and registered it wins, otherwise the project's primary adapter is
   * used. Single-provider conversations always resolve to the primary.
   */
  private _adapterForConversation(conversation: { provider?: string | null }): ProviderAdapter {
    if (conversation.provider) {
      try {
        return getAdapter(conversation.provider)
      } catch {
        /* unknown id → fall back to primary */
      }
    }
    return this._adapter
  }

  // ─── Explore lifecycle helpers ──────────────────────────────────────────────

  private _getOrCreateExploreLifecycle(conversationId: string): ExploreLifecycle {
    let life = this._exploreLifecycle.get(conversationId)
    if (!life) {
      life = {
        isMinimized: false,
        isStreaming: false,
        idleTimer: null,
        crashCount: 0,
        lastActivityAt: Date.now(),
      }
      this._exploreLifecycle.set(conversationId, life)
    }
    return life
  }

  private _clearIdleTimer(conversationId: string): void {
    const life = this._exploreLifecycle.get(conversationId)
    if (life?.idleTimer) {
      clearTimeout(life.idleTimer)
      life.idleTimer = null
    }
  }

  private _startIdleTimer(conversationId: string): void {
    const life = this._exploreLifecycle.get(conversationId)
    if (!life) return
    if (life.isStreaming) return
    if (!life.isMinimized) return
    this._clearIdleTimer(conversationId)
    life.idleTimer = setTimeout(() => {
      const child = this._activeProcesses.get(conversationId)
      if (child?.pid) {
        try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
      }
      // Persistent-stdin children live OUTSIDE _activeProcesses between turns —
      // idle-kill must reach them too (the next turn re-spawns with --resume).
      this._stdinSessions.kill(conversationId)
    }, EXPLORE_IDLE_KILL_MS)
  }

  /**
   * Mark an Explore conversation as minimized. Starts the idle-kill timer
   * iff the conversation is not currently streaming. If a turn is in flight,
   * the timer starts when the turn completes.
   */
  notifyMinimized(conversationId: string): void {
    const life = this._getOrCreateExploreLifecycle(conversationId)
    life.isMinimized = true
    life.lastActivityAt = Date.now()
    this._startIdleTimer(conversationId)
  }

  /** Mark an Explore conversation as restored (un-minimized). Cancels the
   *  pending idle-kill timer if any. */
  notifyRestored(conversationId: string): void {
    const life = this._exploreLifecycle.get(conversationId)
    if (!life) return
    life.isMinimized = false
    life.lastActivityAt = Date.now()
    this._clearIdleTimer(conversationId)
  }

  private _countStreamingExplore(): number {
    let n = 0
    for (const life of this._exploreLifecycle.values()) {
      if (life.isStreaming) n++
    }
    return n
  }

  private _findIdleExploreVictim(excludeConvId: string): string | null {
    let oldest: { id: string; t: number } | null = null
    for (const [id, life] of this._exploreLifecycle.entries()) {
      if (id === excludeConvId) continue
      if (life.isStreaming) continue
      if (life.idleTimer == null && !life.isMinimized) continue
      if (!oldest || life.lastActivityAt < oldest.t) {
        oldest = { id, t: life.lastActivityAt }
      }
    }
    return oldest?.id ?? null
  }

  private _drainExploreQueue(): void {
    // A released waiter does NOT flip its `isStreaming` flag synchronously — it
    // does so only when its awaiting sendMessage continuation runs as a later
    // microtask. So `_countStreamingExplore()` stays stale across this fully
    // synchronous loop. Track the genuinely-free slots with a local counter so
    // we release at most that many waiters per drain pass; otherwise a single
    // freed slot could release every queued turn at once and blow past
    // EXPLORE_MAX_CONCURRENCY (an unbounded burst of CLI processes).
    let freed = EXPLORE_MAX_CONCURRENCY - this._countStreamingExplore()
    while (this._exploreQueue.length > 0 && freed > 0) {
      const next = this._exploreQueue.shift()!
      clearTimeout(next.timeoutTimer)
      freed--
      next.onSlot()
    }
  }

  private async _waitForExploreSlot(conversationId: string): Promise<'ok' | 'busy'> {
    if (this._countStreamingExplore() < EXPLORE_MAX_CONCURRENCY) return 'ok'
    // M14: a streaming slot is freed only when a STREAMING turn ends. The old code
    // evicted an idle (non-streaming) victim and immediately returned 'ok' — but
    // _findIdleExploreVictim skips streaming entries, so the victim holds no live
    // slot and the count is unchanged. That admitted a 6th concurrent turn (and,
    // repeated per idle/minimized entry, made the effective cap 5 + idle-count =
    // unbounded CLI spawning). Now: prune the idle entry (memory hygiene + kill any
    // stray child) but only grant the slot if the streaming count actually dropped.
    const victim = this._findIdleExploreVictim(conversationId)
    if (victim) {
      const child = this._activeProcesses.get(victim)
      if (child?.pid) {
        try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
      }
      // Reclaim the slot from a persistent-stdin child parked between turns.
      this._stdinSessions.kill(victim)
      this._clearIdleTimer(victim)
      this._exploreLifecycle.delete(victim)
      if (this._countStreamingExplore() < EXPLORE_MAX_CONCURRENCY) return 'ok'
    }
    // Still at cap — queue with timeout until a streaming turn completes.
    return new Promise<'ok' | 'busy'>((resolve) => {
      const timeoutTimer = setTimeout(() => {
        const idx = this._exploreQueue.findIndex((q) => q.conversationId === conversationId)
        if (idx >= 0) this._exploreQueue.splice(idx, 1)
        resolve('busy')
      }, EXPLORE_QUEUE_TIMEOUT_MS)
      this._exploreQueue.push({
        conversationId,
        enqueuedAt: Date.now(),
        timeoutTimer,
        onSlot: () => resolve('ok'),
        onTimeout: () => resolve('busy'),
      })
    })
  }

  /**
   * Resolve the spawn cwd for a chat turn. Explore conversations spawn from
   * an app-managed directory by default to skip auto-loading the project's
   * `CLAUDE.md` (the dominant first-token cost); when the per-project MCP
   * toggle is on, fall back to the project path so `.mcp.json` is honoured.
   * Non-Explore conversations always use the project path.
   *
   * See openspec/changes/accelerate-spec-chat-first-token/design.md D1+D4.
   */
  /**
   * Relocate-artifacts: resolve execution for a NON-explore (sidebar / rail-like)
   * spawn. Explore keeps its own explore-cwd logic (untouched). Returns the
   * relocated cwd + env when relocated, else legacy (cwd = project.path, empty
   * env). Cached per call — cheap registry read.
   */
  private _resolveNonExploreExecution(): ProjectExecution | null {
    if (!this._projectSlug || !this._cwd) return null
    return resolveProjectExecution({ slug: this._projectSlug, path: this._cwd })
  }

  /**
   * Relocate-artifacts: the dir whose `.specrails/local-tickets.json` the scoped
   * system-prompt prefix reads. Workspace when relocated, else project.path.
   */
  private _specrailsRoot(): string | undefined {
    if (!this._cwd) return undefined
    const exec = resolveProjectExecution({ path: this._cwd })
    return exec.relocated && exec.workspaceDir ? exec.workspaceDir : this._cwd
  }

  private _resolveSpawnCwd(
    kind: string | null | undefined,
    scope?: ContextScope | null,
    providerId?: string,
  ): string | undefined {
    if (kind !== 'explore') {
      // Non-explore sidebar: route through the relocate-artifacts gate.
      const exec = this._resolveNonExploreExecution()
      return exec ? exec.cwd : this._cwd
    }
    if (!this._projectSlug || !this._cwd || !this._projectName) return this._cwd
    // Per-conversation scope.mcp is the only source of truth. Legacy null
    // scope is treated as mcp=false (spawn from app-managed cwd).
    const mcpEnabled = scope ? !!scope.mcp : false
    if (mcpEnabled) return this._cwd
    try {
      const cwd = ensureExploreCwd({
        slug: this._projectSlug,
        projectPath: this._cwd,
        projectName: this._projectName,
        provider: providerId ?? this._adapter.id,
      })
      console.log(`[chat-manager] explore spawn cwd=${cwd} (mcp=off)`)
      return cwd
    } catch (err) {
      console.error('[chat-manager] ensureExploreCwd failed, falling back to project path:', err)
      return this._cwd
    }
  }

  private _resolveConversationScope(row: { kind?: string | null; context_scope?: string | null } | null | undefined): ContextScope | null {
    if (!row || row.kind !== 'explore') return null
    const fallback = defaultBootScope('explore')
    if (!row.context_scope) return fallback
    try {
      return normalizeContextScope(JSON.parse(row.context_scope), fallback)
    } catch {
      return fallback
    }
  }

  /** Drop the per-conversation draft state (used on conversation deletion). */
  forgetSpecDraft(conversationId: string): void {
    this._specDraftStates.delete(conversationId)
  }

  /** Snapshot of the current spec-draft state for a conversation, or null
   *  if no draft has accumulated yet. Used by the client to rehydrate after
   *  a refresh / minimize cycle so updates Claude pushed while no shell
   *  was subscribed don't get lost. */
  getSpecDraftState(conversationId: string): ConversationDraftState | null {
    return this._specDraftStates.get(conversationId) ?? null
  }

  /**
   * Sidebar system prompt. MUST stay byte-stable across consecutive
   * invocations for the same project name so Anthropic's automatic prompt
   * cache hits across turns within the 5-minute TTL window — the same
   * constraint `_buildLightweightSystemPrompt` documents for Explore.
   *
   * DO NOT inject timestamps, live job stats, recent-job summaries, costs,
   * or any per-invocation data here. The volatile dashboard snapshot is
   * prepended to the user turn instead (see `_buildDashboardContextBlock`
   * and its callsite in `sendMessage`).
   */
  private _buildSystemPrompt(): string {
    const name = this._projectName ?? 'this project'

    return (
      `You are a project assistant for the "${name}" specrails project with full access to this repository via Claude Code. ` +
      `You can help answer questions about the codebase, explain SpecRails concepts, and suggest commands to run.` +
      `\n\nIMPORTANT: You have explicit permission to read and write .specrails/local-tickets.json — ` +
      `this is the project's local ticket store managed by Specrails. It is NOT sensitive. ` +
      `When creating or updating tickets, write directly to this JSON file.` +
      `\n\nUser messages may begin with a "## Current Dashboard Context" section. It is injected by the dashboard, ` +
      `not typed by the user — treat it as live, authoritative project state (active job, recent jobs, stats, costs) ` +
      `when answering.` +
      `\n\n` +
      COMMAND_INSTRUCTION
    )
  }

  /**
   * Volatile dashboard snapshot (active job, recent jobs, stats, costs) for
   * sidebar turns. Prepended to the user turn rather than the system prompt
   * so the cacheable `--system-prompt` prefix stays byte-stable.
   * Returns '' when stats can't be read (context is best-effort).
   */
  private _buildDashboardContextBlock(): string {
    try {
      const stats = getStats(this._db)
      const { jobs: recentJobs } = listJobs(this._db, { limit: 5 })

      // Active job (running or queued at top)
      const activeJob = recentJobs.find((j) => j.status === 'running' || j.status === 'queued')
      const activeLine = activeJob
        ? `**${activeJob.status.toUpperCase()}**: \`${activeJob.command}\``
        : 'No job currently running.'

      // Recent terminal jobs
      const terminalJobs = recentJobs.filter(
        (j) => j.status === 'completed' || j.status === 'failed' || j.status === 'canceled'
      )
      const jobLines = terminalJobs.map((j) => {
        const status = j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : '○'
        const dur = j.duration_ms != null ? `${Math.round(j.duration_ms / 1000)}s` : '—'
        const cost = j.total_cost_usd != null ? `$${j.total_cost_usd.toFixed(3)}` : '—'
        const cmd = j.command.length > 60 ? j.command.slice(0, 57) + '...' : j.command
        return `- ${status} \`${cmd}\` | ${dur} | ${cost}`
      })

      const successRate =
        stats.totalJobs > 0
          ? Math.round(((stats.totalJobs - stats.failedJobs) / stats.totalJobs) * 100)
          : null

      return (
        `## Current Dashboard Context\n\n` +
        `### Active Job\n${activeLine}\n\n` +
        (jobLines.length > 0 ? `### Recent Jobs\n${jobLines.join('\n')}\n\n` : '') +
        `### Project Stats\n` +
        `- Total jobs: ${stats.totalJobs}\n` +
        `- Jobs today: ${stats.jobsToday}\n` +
        (successRate != null ? `- Overall success rate: ${successRate}%\n` : '') +
        `- Total cost: $${stats.totalCostUsd.toFixed(3)}\n` +
        `- Cost today: $${stats.costToday.toFixed(3)}`
      )
    } catch {
      // Context is best-effort; fall back gracefully
      return ''
    }
  }

  /**
   * Lightweight system prompt for Explore Spec turns. MUST stay byte-stable
   * across consecutive invocations for the same project name so Anthropic's
   * automatic prompt cache hits across turns within the 5-minute TTL window.
   *
   * DO NOT inject timestamps, live job stats, recent-job summaries, costs, or
   * any per-invocation data here. Adding non-deterministic content silently
   * breaks the cache and reverts the first-token-latency win.
   *
   * See openspec/changes/accelerate-spec-chat-first-token/design.md D5.
   */
  private _buildLightweightSystemPrompt(scope?: ContextScope | null): string {
    const name = this._projectName ?? 'this project'
    // High tier = the user opted into MCP/connectors (Max/Desktop presets). At
    // that tier the agent also has Bash (gh + repo inspection) and MCP tools, so
    // its stance flips from "be minimal" to "verify against the real code before
    // recommending" — this is deterministic per scope, so the prompt stays
    // byte-stable for prompt caching within a given scope.
    const highTier = !!(scope && scope.full && (scope.mcp || scope.userMcp))
    const intro =
      `You are a focused assistant for the "${name}" specrails project. ` +
      `You have explicit permission to read and write .specrails/local-tickets.json — ` +
      `this is the project's local ticket store managed by Specrails. It is NOT sensitive. ` +
      `When creating or updating tickets, write directly to this JSON file.`
    const stance = highTier
      ? `IMPORTANT: You have read/search tools (Read, Grep, Glob), the GitHub CLI (\`gh\`, already authenticated for this machine — use it to inspect issues, PRs, and CI), and any MCP servers the user enabled. ` +
        `Before recommending a spec, doing gap analysis, or claiming a feature is missing, you MUST INVESTIGATE THE ACTUAL CODEBASE first — grep and read the relevant source (and check \`gh\`/MCP where useful) to confirm the real implementation status. ` +
        `NEVER recommend a spec for something that is already implemented: if the backlog or another spec references a feature, verify it in code before proposing it. Reading code thoroughly is expected and encouraged at this tier — do not guess from ticket titles alone.`
      : `IMPORTANT: Be efficient. Minimize tool calls. Only read files that are directly relevant. ` +
        `Do not explore broadly — focus on the specific task.`
    const scopedBase =
      `${intro}\n\n${stance}\n\n` +
      `When "Specrails Tickets" or "OpenSpec Specs" sections are present below, treat them as authoritative project context. ` +
      `For roadmap-style requests like "suggest the next best spec", ground the answer in that context, avoid duplicates, and propose one concrete next spec instead of generic directions.`
    if (!scope || !this._cwd) return scopedBase
    const prefix = buildScopedSystemPromptPrefix(scope, this._cwd, this._specrailsRoot())
    if (!prefix) return scopedBase
    return `${scopedBase}\n\n${prefix}`
  }

  isActive(conversationId: string): boolean {
    return this._activeProcesses.has(conversationId)
  }

  async sendMessage(conversationId: string, userText: string, options?: SendMessageOptions): Promise<void> {
    if (this._activeProcesses.has(conversationId) || this._reservedTurns.has(conversationId)) {
      console.warn(`[ChatManager] conversation ${conversationId} already has an active or pending stream`)
      return
    }

    const conversation = getConversation(this._db, conversationId)
    if (!conversation) {
      console.warn(`[ChatManager] conversation ${conversationId} not found`)
      return
    }

    // Per-conversation adapter (multi-provider). The conversation's stored
    // provider wins; null/legacy conversations fall back to the project
    // primary (this._adapter). Resolved once and used for the whole turn.
    const adapter = this._adapterForConversation(conversation)

    if (!binaryOnPath(adapter.binary)) {
      this._broadcast({
        type: 'chat_error',
        conversationId,
        error: `${adapter.id.toUpperCase()}_NOT_FOUND`,
        timestamp: new Date().toISOString(),
      })
      return
    }

    // M13: reserve synchronously before the explore-slot / attachment awaits.
    // Released in the finally at the end of the method — by then either
    // _activeProcesses owns the guard (spawn succeeded) or the turn bailed out.
    this._reservedTurns.add(conversationId)
    try {
    // Explore: enforce per-project concurrency cap before doing any work.
    if (conversation.kind === 'explore') {
      const slot = await this._waitForExploreSlot(conversationId)
      if (slot === 'busy') {
        this._broadcast({
          type: 'chat_error',
          conversationId,
          error: 'busy',
          timestamp: new Date().toISOString(),
        })
        return
      }
      const life = this._getOrCreateExploreLifecycle(conversationId)
      life.isStreaming = true
      life.lastActivityAt = Date.now()
      this._clearIdleTimer(conversationId)
    }

    // Check if this is turn 1 (session_id was null before this message)
    const isFirstTurn = conversation.session_id === null

    // Persist user message
    addMessage(this._db, { conversation_id: conversationId, role: 'user', content: userText })

    // Resolve slash commands (e.g. /specrails:propose-spec → prompt content)
    let resolvedText = resolveCommand(userText, this._cwd ?? process.cwd())

    // Fold attachments into the prompt as <user-attachment> text blocks under
    // an "## Attached Resources" section, mirroring how /generate-spec wires
    // them. Errors during extraction are logged and skipped — the chat turn
    // proceeds without that attachment rather than failing.
    let hasAttachments = false
    if (options?.attachments && options.attachments.ids.length > 0) {
      try {
        const { textBlocks } = await attachmentManager.getClaudeArgs(
          options.attachments.slug,
          options.attachments.ticketKey,
          options.attachments.ids,
        )
        if (textBlocks.length > 0) {
          resolvedText = `${resolvedText}\n\n## Attached Resources\n\n${textBlocks.join('\n\n')}`
          hasAttachments = true
        }
      } catch (err) {
        console.error(`[chat-manager] attachment extraction failed (${conversationId}):`, err)
      }
    }

    // Build spawn args via the resolved adapter. System prompt placement
    // (--system-prompt flag vs prompt-fold) and resume vs fresh-turn are both
    // adapter-driven via capability flags.
    const lightweight = options?.lightweight ?? false
    const conversationScope = this._resolveConversationScope(conversation)
    let systemPrompt = lightweight
      ? this._buildLightweightSystemPrompt(conversationScope)
      : this._buildSystemPrompt()
    if (hasAttachments) systemPrompt = `${systemPrompt}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`

    const binary = adapter.binary
    const model = conversation.model || adapter.defaultModel()
    const action = conversation.session_id && adapter.capabilities.nativeResume
      ? 'chat-resume' as const
      : 'chat-turn' as const
    // Translate the per-conversation Explore scope into provider-native
    // tool-gating flags. `toolFlagsForScope` emits claude-shape argv
    // (`--tools …` to restrict the read-only tiers, or `--disallowedTools …` at
    // the high MCP tier where Bash + MCP tools must stay callable); codex's
    // `exec` would reject those with an "unexpected argument" error and crash
    // the turn. The scope's tool
    // gating is therefore claude-only today — codex inherits its sandbox
    // and approval policy from the project's `.codex/config.toml` (or the
    // `-c sandbox_mode=` override the adapter already attaches on resume).
    const scopeFlags = conversationScope && adapter.id === 'claude'
      ? toolFlagsForScope(conversationScope).args
      : []
    // Inject the user's OWN already-approved MCP servers when scope.userMcp is
    // on. Claude-only via `--mcp-config` (codex reads ~/.codex natively, so
    // buildUserMcpArgs returns []). Independent of the `mcp` toggle (project
    // .mcp.json) and does not change the spawn cwd. See server/user-mcp-config.ts.
    if (conversationScope?.userMcp && adapter.id === 'claude' && this._cwd && this._projectSlug) {
      scopeFlags.push(
        ...buildUserMcpArgs({
          adapterId: adapter.id,
          projectPath: this._cwd,
          slug: this._projectSlug,
        }),
      )
    }
    let promptForAdapter = resolvedText
    if (conversation.kind === 'explore' && adapter.id === 'codex' && conversationScope && this._cwd) {
      const scopedContext = buildScopedSystemPromptPrefix(conversationScope, this._cwd, this._specrailsRoot())
      if (scopedContext) {
        promptForAdapter =
          `Project context selected in Add Spec. Use it to avoid duplicate specs and to make project-specific recommendations.\n\n` +
          `${scopedContext}\n\n` +
          `## User turn\n\n${resolvedText}`
      }
    }
    // Sidebar turns: the volatile dashboard snapshot lives in the user turn
    // (not --system-prompt) so the cacheable system-prompt prefix stays
    // byte-stable across turns — same pattern as the codex scoped-context
    // prepend above. Gated on systemPromptArg: adapters without it (codex)
    // drop the system prompt for chat turns entirely (argv stays
    // user-text-only by design), so they never saw the dashboard block and
    // must not start receiving it here.
    if (!lightweight && adapter.capabilities.systemPromptArg) {
      const dashboardContext = this._buildDashboardContextBlock()
      if (dashboardContext) {
        promptForAdapter = `${dashboardContext}\n\n## User turn\n\n${promptForAdapter}`
      }
    }
    let args = adapter.buildArgs(action, {
      prompt: promptForAdapter,
      systemPrompt,
      model,
      sessionId: conversation.session_id ?? undefined,
      maxTurns: options?.maxTurns,
      extraArgs: scopeFlags,
      // "My approved MCPs" (scope.userMcp) loads the developer's user-scope,
      // plugin, and connector MCP servers — which require the `user` setting
      // source. Claude-only (codex reads ~/.codex natively, ignores this).
      loadUserEnv: adapter.id === 'claude' && !!conversationScope?.userMcp,
    })
    if (conversationScope) {
      console.log(`[chat-manager] scope=${JSON.stringify(conversationScope)} flags=${scopeFlags.join(' ')} promptBytes=${Buffer.byteLength(systemPrompt)}`)
    }

    // No OTEL env injection here — ChatManager spawns are interactive user sessions,
    // not pipeline jobs. Telemetry is scoped to QueueManager pipeline runs only.
    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    const spawnCwd = this._resolveSpawnCwd(conversation.kind, conversationScope, adapter.id)

    // Relocate-artifacts env for NON-explore (sidebar) spawns. Explore keeps its
    // own explore-cwd path (no relocation env — it reaches the repo via the
    // explore-cwd `./project` link). Legacy ⇒ process.env (byte-identical).
    let spawnEnv: NodeJS.ProcessEnv = process.env
    if (conversation.kind !== 'explore') {
      const exec = this._resolveNonExploreExecution()
      if (exec?.relocated) {
        spawnEnv = { ...process.env, ...exec.env }
        if (adapter.id === 'gemini') spawnEnv = { ...spawnEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
      }
    }

    // Big bet #3 fast-path: persistent-stdin multi-turn for Explore (claude
    // only, flag-gated default OFF). Reuses a single long-lived child across
    // turns so turns 2+ skip spawn + session rehydration. Full fallback to the
    // legacy spawn-per-turn path below when disabled / unsupported.
    if (
      isExplorePersistentStdinEnabled() &&
      conversation.kind === 'explore' &&
      adapter.capabilities.persistentStdin === true
    ) {
      return await this._streamPersistentExploreTurn({
        conversationId, conversation, adapter, binary, model, systemPrompt,
        scopeFlags, spawnCwd, promptForAdapter, isFirstTurn, userText,
        lightweight, conversationScope,
      })
    }

    const child = spawnAiCli(binary, args, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: spawnCwd,
    })

    let stderrBuf = ''
    // Drain stderr so the pipe buffer never fills up (child process would block otherwise)
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      console.error(`[chat-manager] ${binary} stderr (${conversationId}):`, text.trim())
    })

    this._activeProcesses.set(conversationId, child)
    this._buffers.set(conversationId, '')
    this._emittedProposals.set(conversationId, new Set())
    this._streamFilters.set(conversationId, { inBlock: false, pendingTail: '' })

    // Surface ENOENT (e.g. claude not on PATH) instead of crashing the app.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[chat-manager] spawn failed for ${conversationId}: ${err.message}`)
      this._activeProcesses.delete(conversationId)
      this._buffers.delete(conversationId)
      this._emittedProposals.delete(conversationId)
      this._broadcast({
        type: 'chat_error',
        conversationId,
        error: `Failed to launch ${binary}: ${err.message}`,
        timestamp: new Date().toISOString(),
      })
    })
    /* c8 ignore stop */

    let capturedSessionId: string | null = null
    // Accumulator of parsed events for finaliseInvocationResult at close.
    const adapterEvents: AdapterEvent[] = []
    /** True iff a kind:'result' event has arrived; mirrors the legacy
     *  `lastResultEvent !== null` check that the crash-respawn guard uses. */
    let sawResult = false
    const turnStartedAt = new Date().toISOString()

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    const emitDelta = (newText: string) => {
      const prev = this._buffers.get(conversationId) ?? ''
      const updated = prev + newText
      this._buffers.set(conversationId, updated)

      // Live-strip any `​```spec-draft` fenced JSON from the broadcast so the
      // user never sees the raw protocol payload mid-stream. The filter holds
      // back partial fence markers and emits only the user-visible prose.
      const filter = this._streamFilters.get(conversationId)
      const visibleDelta = filter ? filterDraftBlocksLive(filter, newText) : newText
      if (visibleDelta) {
        this._broadcast({
          type: 'chat_stream',
          conversationId,
          delta: visibleDelta,
          timestamp: new Date().toISOString(),
        })
      }

      // Check for new command proposals
      const proposals = extractCommandProposals(updated)
      const emitted = this._emittedProposals.get(conversationId)
      if (emitted) {
        for (const proposal of proposals) {
          if (!emitted.has(proposal)) {
            emitted.add(proposal)
            this._broadcast({
              type: 'chat_command_proposal',
              conversationId,
              command: proposal,
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    const readerHandler = (line: string) => {
      const ev = adapter.parseStreamLine(line)
      if (!ev) return
      adapterEvents.push(ev)
      switch (ev.kind) {
        case 'text-delta':
          emitDelta(ev.text)
          break
        case 'session-started':
          // Last-wins: Claude rotates session ids across --resume, and only the
          // id present at result-time is persisted on disk. Capturing the first
          // one leaves DB with a ghost id that fails the next --resume.
          if (ev.sessionId) capturedSessionId = ev.sessionId
          break
        case 'result':
          sawResult = true
          // Claude's result event carries the canonical (post-rotation)
          // session_id; codex captures from thread.started but mirroring here
          // is harmless.
          {
            const sid = (ev.payload as { session_id?: string }).session_id
            if (sid) capturedSessionId = sid
          }
          break
        case 'tool-use':
        case 'other':
          // No-op for ChatManager — adapter parses tool_use into the unified
          // event shape but the chat UI does not currently surface them.
          break
      }
    }
    stdoutReader.on('line', readerHandler)

    let currentChild = child
    void currentChild // keep reference live for crash respawn
    return new Promise<void>((resolve) => {
      const onClose = (code: number | null) => {
        console.log(`[chat-manager] ${adapter.id} exited code=${code} conv=${conversationId}`)
        const fullText = this._buffers.get(conversationId) ?? ''
        const wasAborting = this._abortingConversations.has(conversationId)

        // Crash auto-respawn for Explore: if the child exited non-zero before
        // emitting a `result` event, the user did not explicitly abort, and
        // we have not yet retried, respawn the same turn once via chat-resume
        // when the adapter supports it and a session id was captured.
        // See design.md D7.
        if (
          conversation.kind === 'explore' &&
          !wasAborting &&
          code !== 0 &&
          !sawResult
        ) {
          const life = this._exploreLifecycle.get(conversationId)
          if (life && life.crashCount === 0) {
            life.crashCount = 1
            // Rebuild argv as chat-resume when the adapter supports native
            // resume AND we captured a session id before the crash. Otherwise
            // re-issue the original chat-turn argv so the spawn still happens.
            const respawnArgs =
              capturedSessionId && adapter.capabilities.nativeResume
                ? adapter.buildArgs('chat-resume', {
                    prompt: resolvedText,
                    systemPrompt,
                    model,
                    sessionId: capturedSessionId,
                    maxTurns: options?.maxTurns,
                    // Preserve scope-driven flags (tool gating + user MCP
                    // `--mcp-config`) on respawn; without this the resumed turn
                    // silently drops them.
                    extraArgs: scopeFlags,
                  })
                : args
            console.warn(`[chat-manager] explore crash respawn for ${conversationId}`)
            try {
              const newChild = spawnAiCli(binary, respawnArgs, {
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: spawnCwd,
              })
              currentChild = newChild
              args = respawnArgs
              this._activeProcesses.set(conversationId, newChild)
              newChild.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stderrBuf += text
                console.error(`[chat-manager] ${binary} stderr (${conversationId}):`, text.trim())
              })
              // The respawn is a brand-new ChildProcess; it does NOT inherit
              // the original child's 'error' listener. Without one, an async
              // spawn 'error' (ENOENT/EAGAIN — the very class of failure that
              // can recur right after a crash) would be an unhandled 'error'
              // event and crash the entire app. Mirror the original handler.
              /* c8 ignore start -- respawn spawn-failure path; exercised manually, not in CI */
              newChild.on('error', (err) => {
                console.error(`[chat-manager] explore crash-respawn spawn failed for ${conversationId}: ${err.message}`)
                this._activeProcesses.delete(conversationId)
                this._buffers.delete(conversationId)
                this._emittedProposals.delete(conversationId)
                this._abortingConversations.delete(conversationId)
                this._streamFilters.delete(conversationId)
                const life = this._exploreLifecycle.get(conversationId)
                if (life) {
                  life.isStreaming = false
                  life.lastActivityAt = Date.now()
                  if (life.isMinimized) this._startIdleTimer(conversationId)
                }
                this._drainExploreQueue()
                this._broadcast({
                  type: 'chat_error',
                  conversationId,
                  error: `Failed to launch ${binary}: ${err.message}`,
                  timestamp: new Date().toISOString(),
                })
                resolve()
              })
              /* c8 ignore stop */
              const newReader = createInterface({ input: newChild.stdout!, crlfDelay: Infinity })
              newReader.on('line', readerHandler)
              newChild.on('close', onClose)
              return
            } catch (err) {
              console.error('[chat-manager] crash respawn failed:', err)
              /* fall through to normal close handling */
            }
          }
        }

        // Clean up tracking state
        this._activeProcesses.delete(conversationId)
        this._buffers.delete(conversationId)
        this._emittedProposals.delete(conversationId)
        this._abortingConversations.delete(conversationId)
        this._streamFilters.delete(conversationId)

        // Mark Explore turn as no longer streaming and drain any waiters.
        if (conversation.kind === 'explore') {
          const life = this._exploreLifecycle.get(conversationId)
          if (life) {
            life.isStreaming = false
            life.lastActivityAt = Date.now()
            // Reset crash counter on a successful turn.
            if (code === 0) life.crashCount = 0
            if (life.isMinimized) this._startIdleTimer(conversationId)
          }
          this._drainExploreQueue()
        }

        // ai_invocations capture (surface='explore-spec'). Gated on conversation kind.
        if (this._projectId && conversation.kind === 'explore') {
          try {
            const invStatus = wasAborting
              ? 'aborted'
              : code === 0
                ? 'success'
                : 'failed'
            const { result, estimated } = finaliseInvocationResult(adapter, adapterEvents, {
              fallbackModel: model,
            })
            recordInvocation(this._db, {
              id: randomUUID(),
              project_id: this._projectId,
              provider: adapter.id,
              surface: 'explore-spec',
              surface_ref_id: conversationId,
              conversation_id: conversationId,
              status: invStatus,
              started_at: turnStartedAt,
              finished_at: new Date().toISOString(),
              total_cost_usd_estimated: estimated,
              ...result,
            })
            this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
          } catch (err) {
            console.error('[chat-manager] recordInvocation failed:', err)
          }
        }

        if (wasAborting) {
          // abort already emitted chat_error
          resolve()
          return
        }

        if (code === 0) {
          // Parse out any spec-draft fenced blocks (Explore Spec protocol).
          // No-op for non-Explore conversations (parser pre-checks for the fence
          // marker and returns the original text unchanged).
          const parsed = parseSpecDraftBlocks(fullText)
          const persistedText = parsed.blocks.length > 0 ? parsed.stripped : fullText
          if (parsed.blocks.length > 0) {
            const prev = this._specDraftStates.get(conversationId)
            const nextState = applyBlocks(prev, parsed.blocks)
            this._specDraftStates.set(conversationId, nextState)
            this._broadcast({
              type: 'spec_draft.update',
              conversationId,
              draft: nextState.draft,
              ready: nextState.ready,
              chips: nextState.chips,
              changedFields: nextState.lastChangedFields as string[],
              timestamp: new Date().toISOString(),
            })
          }

          // Persist assistant message (stripped of draft blocks for non-noisy DB).
          if (persistedText) {
            addMessage(this._db, { conversation_id: conversationId, role: 'assistant', content: persistedText })
          }

          // Update session_id from the real thread/session captured during
          // streaming. No more synthetic codex-<convId>-<timestamp> fallback —
          // codex's `thread.started` event already gives us a real UUID, and
          // claude's `system`/`result` events carry the canonical session_id.
          if (capturedSessionId) {
            updateConversation(this._db, conversationId, { session_id: capturedSessionId })
          }

          this._broadcast({
            type: 'chat_done',
            conversationId,
            fullText: persistedText,
            timestamp: new Date().toISOString(),
          })

          // Auto-title on first turn (skip in lightweight mode — conversation is ephemeral)
          if (isFirstTurn && fullText && !options?.lightweight) {
            this._autoTitle(conversationId, userText, fullText)
          }
        } else {
          const stderrTail = stderrBuf.trim().slice(-500)
          this._broadcast({
            type: 'chat_error',
            conversationId,
            error: stderrTail
              ? `${binary} exited with code ${code ?? 'unknown'}: ${stderrTail}`
              : `Process exited with code ${code ?? 'unknown'}`,
            timestamp: new Date().toISOString(),
          })
        }

        resolve()
      }
      child.on('close', onClose)
    })
    } finally {
      // M13: release the synchronous reservation. After _activeProcesses.set the
      // active-process map is the guard; on any early return / throw before that,
      // this frees the conversation for a retry.
      this._reservedTurns.delete(conversationId)
    }
  }

  /**
   * Persistent-stdin Explore turn (big bet #3). Reuses one long-lived claude
   * child per conversation via `--input-format stream-json`: the user turn is
   * written to the child's stdin, and the turn ends on the `result` event
   * (NOT process close — the child stays alive for the next turn). Mirrors the
   * legacy close-handler's finalisation (spec-draft parse, persist, session
   * capture, chat_done, invocation accounting, lifecycle) without crash-respawn
   * — a dead persistent child is evicted and the next turn re-spawns with
   * `--resume`. Only reached when the flag is on; the legacy path is untouched.
   */
  private async _streamPersistentExploreTurn(p: {
    conversationId: string
    conversation: ChatConversationRow
    adapter: ProviderAdapter
    binary: string
    model: string
    systemPrompt: string
    scopeFlags: string[]
    spawnCwd: string | undefined
    promptForAdapter: string
    isFirstTurn: boolean
    userText: string
    lightweight: boolean
    conversationScope: ContextScope | null
  }): Promise<void> {
    const {
      conversationId, conversation, adapter, binary, model, systemPrompt,
      scopeFlags, spawnCwd, promptForAdapter, isFirstTurn, userText,
      lightweight, conversationScope,
    } = p

    const sessionArgs = adapter.buildArgs('chat-stream', {
      prompt: '',
      systemPrompt,
      model,
      sessionId: conversation.session_id ?? undefined,
      extraArgs: scopeFlags,
      loadUserEnv: adapter.id === 'claude' && !!conversationScope?.userMcp,
    })

    const { child } = this._stdinSessions.getOrSpawn(conversationId, {
      binary, args: sessionArgs, cwd: spawnCwd, env: process.env,
    })
    this._activeProcesses.set(conversationId, child)
    this._buffers.set(conversationId, '')
    this._emittedProposals.set(conversationId, new Set())
    this._streamFilters.set(conversationId, { inBlock: false, pendingTail: '' })

    const adapterEvents: AdapterEvent[] = []
    let capturedSessionId: string | null = null
    let stderrBuf = ''
    const turnStartedAt = new Date().toISOString()

    const emitDelta = (newText: string) => {
      const prev = this._buffers.get(conversationId) ?? ''
      this._buffers.set(conversationId, prev + newText)
      const filter = this._streamFilters.get(conversationId)
      const visibleDelta = filter ? filterDraftBlocksLive(filter, newText) : newText
      if (visibleDelta) {
        this._broadcast({
          type: 'chat_stream',
          conversationId,
          delta: visibleDelta,
          timestamp: new Date().toISOString(),
        })
      }
      const proposals = extractCommandProposals(this._buffers.get(conversationId) ?? '')
      const emitted = this._emittedProposals.get(conversationId)
      if (emitted) {
        for (const proposal of proposals) {
          if (!emitted.has(proposal)) {
            emitted.add(proposal)
            this._broadcast({
              type: 'chat_command_proposal',
              conversationId,
              command: proposal,
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    const recordInv = (status: 'success' | 'failed' | 'aborted') => {
      if (!this._projectId) return
      try {
        const { result, estimated } = finaliseInvocationResult(adapter, adapterEvents, {
          fallbackModel: model,
        })
        recordInvocation(this._db, {
          id: randomUUID(),
          project_id: this._projectId,
          provider: adapter.id,
          surface: 'explore-spec',
          surface_ref_id: conversationId,
          conversation_id: conversationId,
          status,
          started_at: turnStartedAt,
          finished_at: new Date().toISOString(),
          total_cost_usd_estimated: estimated,
          ...result,
        })
        this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
      } catch (err) {
        console.error('[chat-manager] recordInvocation failed:', err)
      }
    }

    const cleanupTurnState = () => {
      this._activeProcesses.delete(conversationId)
      this._buffers.delete(conversationId)
      this._emittedProposals.delete(conversationId)
      this._streamFilters.delete(conversationId)
    }

    const markStreamingEnded = (success: boolean) => {
      const life = this._exploreLifecycle.get(conversationId)
      if (life) {
        life.isStreaming = false
        life.lastActivityAt = Date.now()
        if (success) life.crashCount = 0
        if (life.isMinimized) this._startIdleTimer(conversationId)
      }
      this._drainExploreQueue()
    }

    return new Promise<void>((resolve) => {
      let settled = false

      const finishTurn = () => {
        if (settled) return
        settled = true
        this._stdinSessions.clearHandlers(conversationId)
        const fullText = this._buffers.get(conversationId) ?? ''
        const wasAborting = this._abortingConversations.has(conversationId)
        cleanupTurnState()
        this._abortingConversations.delete(conversationId)
        markStreamingEnded(true)
        recordInv(wasAborting ? 'aborted' : 'success')

        const parsed = parseSpecDraftBlocks(fullText)
        const persistedText = parsed.blocks.length > 0 ? parsed.stripped : fullText
        if (parsed.blocks.length > 0) {
          const prevState = this._specDraftStates.get(conversationId)
          const nextState = applyBlocks(prevState, parsed.blocks)
          this._specDraftStates.set(conversationId, nextState)
          this._broadcast({
            type: 'spec_draft.update',
            conversationId,
            draft: nextState.draft,
            ready: nextState.ready,
            chips: nextState.chips,
            changedFields: nextState.lastChangedFields as string[],
            timestamp: new Date().toISOString(),
          })
        }
        if (persistedText) {
          addMessage(this._db, { conversation_id: conversationId, role: 'assistant', content: persistedText })
        }
        if (capturedSessionId) {
          updateConversation(this._db, conversationId, { session_id: capturedSessionId })
        }
        this._broadcast({
          type: 'chat_done',
          conversationId,
          fullText: persistedText,
          timestamp: new Date().toISOString(),
        })
        if (isFirstTurn && fullText && !lightweight) {
          this._autoTitle(conversationId, userText, fullText)
        }
        resolve()
      }

      const onClose = (code: number | null) => {
        // The persistent child died (crash / idle-kill / shutdown). If the turn
        // already finished on its `result` event, ignore. No crash-respawn —
        // the session is evicted by the transport; the next turn re-spawns with
        // `--resume`, so no persisted state is lost.
        if (settled) return
        settled = true
        this._stdinSessions.clearHandlers(conversationId)
        const wasAborting = this._abortingConversations.has(conversationId)
        cleanupTurnState()
        this._abortingConversations.delete(conversationId)
        markStreamingEnded(false)
        recordInv(wasAborting ? 'aborted' : 'failed')
        if (wasAborting) {
          resolve()
          return
        }
        const stderrTail = stderrBuf.trim().slice(-500)
        this._broadcast({
          type: 'chat_error',
          conversationId,
          error: stderrTail
            ? `${binary} exited with code ${code ?? 'unknown'}: ${stderrTail}`
            : `Process exited with code ${code ?? 'unknown'}`,
          timestamp: new Date().toISOString(),
        })
        resolve()
      }

      const onLine = (line: string) => {
        const ev = adapter.parseStreamLine(line)
        if (!ev) return
        adapterEvents.push(ev)
        switch (ev.kind) {
          case 'text-delta':
            emitDelta(ev.text)
            break
          case 'session-started':
            if (ev.sessionId) capturedSessionId = ev.sessionId
            break
          case 'result': {
            const sid = (ev.payload as { session_id?: string }).session_id
            if (sid) capturedSessionId = sid
            finishTurn()
            break
          }
          default:
            break
        }
      }

      this._stdinSessions.setHandlers(conversationId, {
        onLine,
        onStderr: (s) => {
          stderrBuf += s
          console.error(`[chat-manager] ${binary} stderr (${conversationId}):`, s.trim())
        },
        onClose,
      })

      if (!this._stdinSessions.writeTurn(conversationId, promptForAdapter)) {
        // stdin already gone (child died between spawn and write) — fail the turn.
        onClose(null)
      }
    })
  }

  abort(conversationId: string): void {
    const child = this._activeProcesses.get(conversationId)
    if (!child || !child.pid) return

    this._abortingConversations.add(conversationId)
    treeKill(child.pid, 'SIGTERM')

    this._broadcast({
      type: 'chat_error',
      conversationId,
      error: 'aborted',
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Drop all Explore-lifecycle bookkeeping for a conversation: cancel its
   * pending idle-kill timer, remove it from the wait queue (clearing that
   * waiter's timeout timer), and delete the lifecycle entry. Called when a
   * conversation is deleted so minimized-but-never-resumed entries (and their
   * armed timers) don't accumulate for the lifetime of the project.
   */
  forgetExploreLifecycle(conversationId: string): void {
    this._clearIdleTimer(conversationId)
    const idx = this._exploreQueue.findIndex((q) => q.conversationId === conversationId)
    if (idx >= 0) {
      clearTimeout(this._exploreQueue[idx].timeoutTimer)
      this._exploreQueue.splice(idx, 1)
    }
    this._stdinSessions.kill(conversationId)
    this._exploreLifecycle.delete(conversationId)
  }

  /**
   * Tear down the manager on shutdown / project removal: terminate every
   * active chat child (SIGTERM), cancel all Explore idle timers and queued
   * waiter timeouts, and clear all per-conversation tracking. Without this,
   * in-flight claude/codex children are orphaned (reparented to init) when the
   * app exits and keep consuming API quota/CPU. Idempotent.
   */
  shutdown(): void {
    for (const child of this._activeProcesses.values()) {
      if (child?.pid) {
        try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
      }
    }
    // Persistent-stdin children outlive individual turns — tear them down too.
    this._stdinSessions.killAll()
    for (const id of this._exploreLifecycle.keys()) {
      this._clearIdleTimer(id)
    }
    for (const q of this._exploreQueue) {
      clearTimeout(q.timeoutTimer)
    }
    this._exploreQueue = []
    this._activeProcesses.clear()
    this._buffers.clear()
    this._emittedProposals.clear()
    this._abortingConversations.clear()
    this._streamFilters.clear()
    this._exploreLifecycle.clear()
  }

  private _autoTitle(conversationId: string, firstUserMsg: string, firstResponse: string): void {
    try {
      // Title generation runs on the conversation's own provider.
      const conv = getConversation(this._db, conversationId)
      const adapter = this._adapterForConversation(conv ?? {})
      const titlePrompt =
        `Generate a 4-6 word title for this conversation. Output ONLY the title text, no quotes or punctuation.\n\n` +
        `User: ${firstUserMsg.slice(0, 200)}\nAssistant: ${firstResponse.slice(0, 300)}`

      const args = adapter.buildArgs('auto-title', {
        prompt: titlePrompt,
        model: adapter.defaultModel(),
      })
      const child = spawnAiCli(adapter.binary, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this._cwd,
      })

      let titleText = ''
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

      reader.on('line', (line) => {
        if (titleText) return
        const ev = adapter.parseStreamLine(line)
        if (ev?.kind === 'text-delta') {
          const trimmed = ev.text.trim()
          if (trimmed) titleText = trimmed
        }
      })

      child.on('close', (code) => {
        if (code === 0 && titleText) {
          updateConversation(this._db, conversationId, { title: titleText })
          this._broadcast({
            type: 'chat_title_update',
            conversationId,
            title: titleText,
            timestamp: new Date().toISOString(),
          })
        }
      })
    } catch {
      // auto-title is fire-and-forget; failure is silent
    }
  }
}

// ─── Live spec-draft fence stripper ──────────────────────────────────────────

interface StreamFilterState {
  /** True when we are currently inside a ```spec-draft fenced block. */
  inBlock: boolean
  /**
   * Last few characters of the incoming stream not yet emitted because they
   * could be the prefix of an unfinished fence marker (open or close).
   * Always empty when `inBlock` is true (there is nothing to emit while
   * inside a block — bytes are dropped).
   */
  pendingTail: string
}

const FENCE_OPEN = '```spec-draft'
const FENCE_CLOSE = '```'
// Hold back up to this many trailing chars in the pre-block state so we never
// emit a partial open fence. -1 because we know the user-visible prefix is at
// least 1 char shorter than the full marker on every step.
const PRE_BLOCK_TAIL = FENCE_OPEN.length - 1

/**
 * Stateful, side-effect-free filter that consumes `newText` and returns the
 * substring that is safe to broadcast to the chat stream. Holds back partial
 * fence markers in `state.pendingTail` so the next call can resolve them.
 *
 * Behaviour:
 *  - While outside a block: emit text up to (but not including) the start of
 *    a `\`\`\`spec-draft` marker. If no marker is present, hold back the
 *    trailing few chars so a marker starting on a chunk boundary is not
 *    leaked.
 *  - While inside a block: emit nothing. Look for the closing `\`\`\``.
 *    When found, consume it (plus an optional trailing newline) and resume
 *    emitting from the bytes that follow.
 *
 * The filter intentionally does NOT validate the JSON payload — that is
 * server-side concern of `parseSpecDraftBlocks`. It only strips the fenced
 * span.
 */
export function filterDraftBlocksLive(state: StreamFilterState, newText: string): string {
  let buf = state.pendingTail + newText
  let out = ''
  state.pendingTail = ''

  // Iterate in case a single delta contains multiple transitions
  // (e.g. close + open + close again — pathological but cheap to support).
  while (buf.length > 0) {
    if (state.inBlock) {
      const closeIdx = buf.indexOf(FENCE_CLOSE)
      if (closeIdx === -1) {
        // No close yet — but the close could span the chunk boundary.
        // Hold back up to 2 trailing chars (closing fence is 3 chars; we keep
        // any trailing run of `\`` so the next call resolves it).
        const tailLen = trailingBacktickRun(buf, 2)
        state.pendingTail = buf.slice(buf.length - tailLen)
        return out
      }
      // Consume the close fence + an optional trailing newline.
      let after = closeIdx + FENCE_CLOSE.length
      if (buf[after] === '\n') after += 1
      buf = buf.slice(after)
      state.inBlock = false
      continue
    }

    // Not in block: look for the open marker.
    const openIdx = buf.indexOf(FENCE_OPEN)
    if (openIdx !== -1) {
      out += buf.slice(0, openIdx)
      buf = buf.slice(openIdx + FENCE_OPEN.length)
      // Drop an optional newline immediately after the open marker so the
      // user never sees `\n` belonging to the fence.
      if (buf[0] === '\n') buf = buf.slice(1)
      state.inBlock = true
      continue
    }

    // No open marker — hold back only the trailing run that could become a
    // prefix of FENCE_OPEN (i.e. the longest suffix of `buf` that is also a
    // prefix of FENCE_OPEN). Anything past that is safe to emit.
    const holdBack = longestSuffixThatIsPrefixOf(buf, FENCE_OPEN)
    const safeEnd = buf.length - holdBack
    out += buf.slice(0, safeEnd)
    state.pendingTail = buf.slice(safeEnd)
    return out
  }

  return out
}

/** Length of the longest suffix of `s` that is a prefix of `target`. */
function longestSuffixThatIsPrefixOf(s: string, target: string): number {
  const max = Math.min(s.length, target.length - 1)
  for (let len = max; len > 0; len--) {
    if (target.startsWith(s.slice(s.length - len))) return len
  }
  return 0
}

function trailingBacktickRun(s: string, max: number): number {
  let n = 0
  for (let i = s.length - 1; i >= 0 && n < max; i--) {
    if (s[i] === '`') n++
    else break
  }
  return n
}
