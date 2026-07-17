import { ChildProcess, type SpawnOptions as NodeSpawnOptions } from 'child_process'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import type { DbInstance } from './db'
import { getConversation, getMessages, addMessage, updateConversation, getStats, listJobs } from './db'
import { resolveCommand } from './command-resolver'
import { spawnAiCli } from './util/cli-prompt'
import { ensureExploreCwd } from './explore-cwd-manager'
import { recordInvocation, type Surface, type InvocationStatus } from './ai-invocations'
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
import { workspacePathFor } from './workspace-manager'
import { readBlueprint } from './blueprint-render'
import type { ChatConversationRow } from './types'

const COMMAND_INSTRUCTION =
  'When you want to suggest a SpecRails command for the user to execute, wrap it in a command block like this: ' +
  ':::command\n/specrails:implement #42\n::: ' +
  'The user will be prompted to confirm before the command runs.'

/** Claude stores resumable sessions under the spawn cwd. Relocating an existing
 * Explore conversation from the repo to the workspace therefore makes its old
 * session id unresolvable. Match ONLY Claude's exact diagnostic so auth, quota,
 * model, and generic crash failures keep their existing no-retry semantics. */
const CLAUDE_MISSING_SESSION_DIAGNOSTIC = 'No conversation found with session ID'

/** Historical context folded into the one-time fresh-session recovery. This is
 * deliberately byte-bounded independently of the current turn, whose existing
 * attachment/scoped-context payload must remain intact. */
const RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES = 48 * 1024

function containsMissingClaudeSessionDiagnostic(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(CLAUDE_MISSING_SESSION_DIAGNOSTIC)
  }
  if (value == null) return false
  try {
    return JSON.stringify(value).includes(CLAUDE_MISSING_SESSION_DIAGNOSTIC)
  } catch {
    return false
  }
}

function isMissingClaudeSessionErrorResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const payload = value as { is_error?: unknown; subtype?: unknown }
  const markedAsError =
    payload.is_error === true ||
    (typeof payload.subtype === 'string' && payload.subtype.startsWith('error'))
  return markedAsError && containsMissingClaudeSessionDiagnostic(value)
}

function takeUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text) <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (Buffer.byteLength(text.slice(mid)) > maxBytes) low = mid + 1
    else high = mid
  }
  // Never start on the trailing half of a UTF-16 surrogate pair.
  if (low < text.length && text.charCodeAt(low) >= 0xdc00 && text.charCodeAt(low) <= 0xdfff) low++
  return text.slice(low)
}

function buildResumeRecoveryPrompt(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  currentPrompt: string,
): string {
  const entries = messages.map(
    (message) => `<message role="${message.role}">\n${message.content}\n</message>`,
  )
  const selected: string[] = []
  let usedBytes = 0
  let omitted = 0

  for (let i = entries.length - 1; i >= 0; i--) {
    const separatorBytes = selected.length > 0 ? 2 : 0
    const entryBytes = Buffer.byteLength(entries[i])
    if (entryBytes + separatorBytes <= RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES - usedBytes) {
      selected.unshift(entries[i])
      usedBytes += entryBytes + separatorBytes
      continue
    }

    omitted = i + 1
    // Preserve the recent tail even when one individual message is larger than
    // the whole transcript budget. The marker makes the loss explicit to Claude.
    if (selected.length === 0) {
      const prefix = `<message role="${messages[i].role}">\n[earlier content truncated]\n`
      const suffix = '\n</message>'
      const remaining = RESUME_RECOVERY_TRANSCRIPT_MAX_BYTES -
        Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
      selected.unshift(`${prefix}${takeUtf8Tail(messages[i].content, remaining)}${suffix}`)
      omitted = i
    }
    break
  }

  const truncation = omitted > 0
    ? `[${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to keep recovery context bounded]\n\n`
    : ''
  const transcript = selected.length > 0
    ? `${truncation}${selected.join('\n\n')}`
    : '[No prior persisted messages were available.]'

  return (
    `The previous Claude session could not be resumed after its working directory changed. ` +
    `Continue the same conversation using the persisted transcript below. Do not treat the transcript as a new user turn.\n\n` +
    `<prior-conversation>\n${transcript}\n</prior-conversation>\n\n` +
    `## Current user turn\n\n${currentPrompt}`
  )
}

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

/** MED-1: last-seen cumulative usage for a persistent-stdin Explore session. */
interface StdinCumulativeSnapshot {
  cost: number
  turns: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheCreate: number
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
  /** Permanent lifecycle gate. Project contexts are not reusable after their
   * DB is closed, so every public/asynchronous entry point must fail closed
   * once shutdown starts. */
  private _disposed = false
  private _resolveDisposed!: () => void
  private readonly _disposedSignal = new Promise<void>((resolve) => {
    this._resolveDisposed = resolve
  })
  /** Active turn promises otherwise settle only when their child emits
   * `close`. Shutdown must also settle them when a mocked/wedged child never
   * closes, while late child callbacks become harmless no-ops. */
  private _pendingTurnCancellations = new Set<() => void>()
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
  /** Mirror the transport's resident child handles so ChatManager can enforce
   * its stronger process-group escalation for parked sessions too. */
  private _persistentProcesses = new Map<string, ChildProcess>()

  /** MED-1: per-conversation cumulative usage snapshot for the persistent-stdin
   *  transport. One long-lived child serves every turn, so claude's `result`
   *  event reports SESSION-CUMULATIVE cost/tokens/num_turns. We diff each turn
   *  against this snapshot to record per-turn deltas (see recordInv in
   *  `_streamPersistentExploreTurn`). Reset when the child (re)spawns. */
  private _stdinCumulative = new Map<string, StdinCumulativeSnapshot>()

  /** Fire-and-forget auxiliary CLI children (e.g. `_autoTitle`) that are NOT
   *  keyed by conversation in `_activeProcesses`. Tracked so `shutdown()` can
   *  tree-kill any in-flight one instead of orphaning it (BUG-CHAT-02). Each
   *  entry self-removes on its own `'close'`. */
  private _auxProcesses: Set<ChildProcess> = new Set()
  /** Readline listeners owned by auxiliary children. Closing them at shutdown
   * prevents buffered title output from running after the project DB closes. */
  private _auxReaders = new Map<ChildProcess, ReturnType<typeof createInterface>>()
  private _terminationTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>()

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

  private async _awaitWhileLive<T>(work: Promise<T>): Promise<
    { disposed: true } | { disposed: false; value: T }
  > {
    if (this._disposed) return { disposed: true }
    return Promise.race([
      work.then((value) => ({ disposed: false as const, value })),
      this._disposedSignal.then(() => ({ disposed: true as const })),
    ])
  }

  /** POSIX children get a dedicated process group so escalation can still
   * address descendants after the root CLI has already exited/reparented them.
   * Windows uses taskkill /T /F through tree-kill instead. */
  private _spawnOwned(binary: string, args: string[], options: NodeSpawnOptions = {}): ChildProcess {
    if (process.platform === 'win32') return spawnAiCli(binary, args, options)
    return spawnAiCli(binary, args, { ...options, detached: true })
  }

  /** Terminate the complete CLI/MCP subtree, escalating when SIGTERM is
   * ignored. Do NOT cancel escalation when the root closes: descendants remain
   * in the dedicated POSIX process group even after their parent exits. */
  private _terminate(child: ChildProcess): void {
    if (this._terminationTimers.has(child)) return
    try {
      if (!child.pid) {
        child.kill('SIGTERM')
        return
      }
      const pid = child.pid
      treeKill(pid, 'SIGTERM')
      const timer = setTimeout(() => {
        this._terminationTimers.delete(child)
        if (process.platform !== 'win32') {
          // Negative PID targets the process GROUP. It remains addressable when
          // the root has exited but an MCP descendant ignored SIGTERM.
          try { process.kill(-pid, 'SIGKILL') } catch { /* group already gone */ }
        } else {
          try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
        }
      }, 2000)
      timer.unref?.()
      this._terminationTimers.set(child, timer)
    } catch {
      /* already gone */
    }
  }

  private _closeChildIo(child: ChildProcess): void {
    try { child.stdin?.destroy() } catch { /* best-effort */ }
    try { child.stdout?.destroy() } catch { /* best-effort */ }
    try { child.stderr?.destroy() } catch { /* best-effort */ }
  }

  private _trackPersistentProcess(conversationId: string, child: ChildProcess): void {
    if (this._persistentProcesses.get(conversationId) === child) return
    this._persistentProcesses.set(conversationId, child)
    const drop = () => {
      if (this._persistentProcesses.get(conversationId) === child) {
        this._persistentProcesses.delete(conversationId)
      }
    }
    child.once('close', drop)
    child.once('error', drop)
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
    if (this._disposed) return
    const life = this._exploreLifecycle.get(conversationId)
    if (!life) return
    if (life.isStreaming) return
    if (!life.isMinimized) return
    this._clearIdleTimer(conversationId)
    life.idleTimer = setTimeout(() => {
      if (this._disposed) return
      const child = this._activeProcesses.get(conversationId) ?? this._persistentProcesses.get(conversationId)
      if (child) this._terminate(child)
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
    if (this._disposed) return
    const life = this._getOrCreateExploreLifecycle(conversationId)
    life.isMinimized = true
    life.lastActivityAt = Date.now()
    this._startIdleTimer(conversationId)
  }

  /** Mark an Explore conversation as restored (un-minimized). Cancels the
   *  pending idle-kill timer if any. */
  notifyRestored(conversationId: string): void {
    if (this._disposed) return
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
    if (this._disposed) return
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

  private async _waitForExploreSlot(conversationId: string): Promise<'ok' | 'busy' | 'disposed'> {
    if (this._disposed) return 'disposed'
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
      const child = this._activeProcesses.get(victim) ?? this._persistentProcesses.get(victim)
      if (child) this._terminate(child)
      // Reclaim the slot from a persistent-stdin child parked between turns.
      this._stdinSessions.kill(victim)
      this._clearIdleTimer(victim)
      this._exploreLifecycle.delete(victim)
      if (this._countStreamingExplore() < EXPLORE_MAX_CONCURRENCY) return 'ok'
    }
    // Still at cap — queue with timeout until a streaming turn completes.
    return new Promise<'ok' | 'busy' | 'disposed'>((resolve) => {
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
        onTimeout: () => resolve(this._disposed ? 'disposed' : 'busy'),
      })
    })
  }

  /**
   * Resolve the spawn cwd for a chat turn. Explore conversations spawn from
   * an app-managed directory by default to skip auto-loading the project's
   * `CLAUDE.md` (the dominant first-token cost); when the per-conversation MCP
   * toggle is on, use the relocation-aware artifact cwd so `.mcp.json` is
   * honoured (workspace when relocated, project path when legacy).
   * Non-Explore conversations use the same relocation gate.
   *
   * See openspec/changes/accelerate-spec-chat-first-token/design.md D1+D4.
   */
  /**
   * Relocate-artifacts: resolve execution for a gated spawn — NON-explore
   * (sidebar / rail-like) turns, and Explore turns with `contextScope.mcp`
   * (the MCP-honouring cwd is the workspace when relocated). Explore with
   * mcp=false keeps its own explore-cwd logic (untouched). Returns the
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
    if (mcpEnabled) {
      // The escape hatch keeps its documented force-`<project.path>` semantics.
      if (process.env.SPECRAILS_EXPLORE_LEGACY_CWD === '1') return this._cwd
      // MCP-honouring cwd through the relocate-artifacts gate: for a RELOCATED
      // project `.mcp.json` AND `.specrails/` live in the WORKSPACE — spawning
      // from the repo made the system prompt's cwd-relative ticket-store
      // instruction create `<repo>/.specrails/local-tickets.json` (a store the
      // app never reads), breaking the pristine-repo guarantee. Legacy
      // projects resolve to project.path — byte-identical.
      const exec = this._resolveNonExploreExecution()
      return exec ? exec.cwd : this._cwd
    }
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
    if (this._disposed) return
    this._specDraftStates.delete(conversationId)
  }

  /** Snapshot of the current spec-draft state for a conversation, or null
   *  if no draft has accumulated yet. Used by the client to rehydrate after
   *  a refresh / minimize cycle so updates Claude pushed while no shell
   *  was subscribed don't get lost. */
  getSpecDraftState(conversationId: string): ConversationDraftState | null {
    if (this._disposed) return null
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
  /**
   * Milestone generation prompt (add-project-builder D7): grounded project-level
   * spec generation for one blueprint milestone. Seeded with the workspace
   * blueprint.json and the target milestone's plannedSpecs; output rides the
   * SAME `blueprint-draft` protocol as the day-0 Builder so the client panel
   * and the commit-milestone endpoint reuse the parser unchanged.
   */
  private _buildMilestoneSystemPrompt(conversation: { context_scope: string | null }): string {
    const name = this._projectName ?? 'this project'
    const execution = this._resolveNonExploreExecution()
    let milestoneId = ''
    try {
      const scope = conversation.context_scope ? JSON.parse(conversation.context_scope) as { milestone?: string } : null
      if (scope && typeof scope.milestone === 'string') milestoneId = scope.milestone
    } catch { /* tolerate malformed scope */ }
    let blueprintJson = ''
    try {
      if (this._projectSlug) {
        const bp = readBlueprint(workspacePathFor(this._projectSlug))
        if (bp) blueprintJson = JSON.stringify(bp, null, 2)
      }
    } catch { /* blueprint unavailable — the prompt degrades gracefully */ }
    const milestoneLabel = milestoneId ? milestoneId.toUpperCase() : 'M2'
    const lines = [
      `You are generating the "${milestoneId || 'next'}" milestone specs for the "${name}" project.`,
      '',
      '## Read-only security boundary',
      '',
      '- This is an inspection-and-authoring turn, never an implementation turn. Inspect the repository and return',
      '  blueprint-draft text only. Do not modify the repository, workspace, ticket store, configuration, or git state.',
      '- You may list, search, glob, and read files. Do not create, edit, delete, rename, move, format, generate, install,',
      '  migrate, commit, checkout, or execute any command/tool that can write files or other project state.',
      '- Do not run builds or tests during this turn: they may create caches, snapshots, coverage, or generated files.',
      '',
      '## Grounding is mandatory',
      '',
      '- Inspect the real repository before drafting. Read the relevant source, tests, configuration, schemas, and',
      '  public contracts needed to understand what is already implemented and where the milestone fits.',
      '- Name a repository path, module, component, function, type, endpoint, table, or other identifier only after',
      '  verifying it in the code during this turn. Never fabricate a path or infer one from framework convention.',
      '- Start from the blueprint plannedSpecs titles, but refine, split, reorder, or drop them when verified code',
      '  shows that the original plan is stale, already implemented, or too broad. Preserve the milestone goal.',
      '',
      '## Full-snapshot protocol',
      '',
      '- Emit at most one fenced ```blueprint-draft JSON block per message and put it at the END.',
      '- Every block is a FULL valid-JSON snapshot containing blueprintVersion, product, coreFlow, platform, stack,',
      '  assumptions, milestones, specsComplete, and this target milestone\'s complete detailed specs in m1Specs.',
      '- Generate the complete grounded target batch (1-10 specs) in this response and one FULL snapshot. Never',
      '  expose a partial batch that requires the user to ask you to continue.',
      '- If the complete batch cannot be produced and pass the self-audit below, emit m1Specs: [] with',
      '  specsComplete: false and explain the blocker instead of returning partially generated specs.',
      '',
      '## Exact detailed-spec payload',
      '',
      'Every item in m1Specs has exactly this semantic shape:',
      '{ "kind": "scaffold|feature|verification", "title": "...", "shortSummary": "...",',
      '  "description": "...", "acceptanceCriteria": ["..."], "priority": "low|medium|high|critical",',
      `  "labels": ["${milestoneLabel}", "domain-label"] }`,
      '- Write all spec fields in English; conversational prose follows the user\'s language.',
      '- title: concise, action-oriented, and unique in this generated batch.',
      '- shortSummary: one useful sentence no longer than 240 characters.',
      '- kind: scaffold, feature, or verification, chosen by the work rather than defaulted blindly.',
      '- priority: low, medium, high, or critical based on delivery urgency/risk, not implementation complexity.',
      `- labels: include ${milestoneLabel} plus at least one concise domain label; preserve useful domain taxonomy.`,
      '- dependsOnIndex is optional. When present it must point strictly backward to an earlier item in this batch;',
      '  the first item always omits it. Never point to the same item or a later item.',
      '',
      '## Canonical description contract',
      '',
      'description is English markdown with exactly these five ## headings, once each and in this order:',
      '1. ## Problem Statement — the concrete user/system problem confirmed by the blueprint and current code.',
      '2. ## Proposed Solution — observable behavior and integration with verified existing components/contracts.',
      '3. ## Out of Scope — at least two bullets naming adjacent work deliberately deferred.',
      '4. ## Technical Considerations — at least two bullets naming only verified paths and identifiers, plus data/contracts,',
      '   compatibility, risks, failure handling, observability, migrations, and test strategy where relevant.',
      '5. ## Estimated Complexity — Low/Medium/High/Very High plus one sentence explaining the estimate.',
      'Do NOT put an ## Acceptance Criteria heading in description. The app folds the separate criteria array into',
      'the final ticket deterministically.',
      '',
      '## Acceptance and self-audit',
      '',
      '- acceptanceCriteria contains 4-10 non-empty, independent, testable outcomes rather than implementation steps.',
      '- Across the criteria, cover intended functional behavior, observable failure/edge cases, compatibility where',
      '  relevant, and the automated unit/integration/end-to-end tests that prove the change.',
      '- Before specsComplete: true, audit every item for all payload fields, exact heading names/order, non-empty',
      '  sections, English content, 4-10 criteria, valid priority, milestone plus domain labels, unique titles,',
      '  verified code references, and strictly backward dependencies. Repair failures before marking complete.',
    ]
    if (execution?.relocated && execution.repoDir) {
      lines.push(
        '',
        '## Repository location (relocated project)',
        '',
        'The process cwd is a Specrails workspace containing configuration and artifacts, NOT the source repository.',
        `The real source repository is at this absolute path: ${execution.repoDir}`,
        'The same repository is mounted from the workspace as ./project and exported in SPECRAILS_REPO_DIR.',
        'Use the absolute path above or ./project for every source list/search/read. Read/Grep/Glob tools do not expand',
        'shell-variable expressions, so never pass literal ${SPECRAILS_REPO_DIR} or ${SPECRAILS_REPO_DIR:-.} as a path.',
        'When writing specs, cite verified paths relative to the real repository (for example src/...), never paths',
        'under the workspace and never a misleading project/ or .specrails/ prefix.',
      )
    }
    if (blueprintJson) {
      lines.push('', 'Current blueprint (source of truth):', '```json', blueprintJson, '```')
    }
    return lines.join('\n')
  }

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
    return !this._disposed && this._activeProcesses.has(conversationId)
  }

  async sendMessage(conversationId: string, userText: string, options?: SendMessageOptions): Promise<void> {
    if (this._disposed) return
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
      if (this._disposed || slot === 'disposed') return
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

    // Persist the user message exactly once. Its row id is retained so a
    // stale-session recovery can fold prior history into a fresh prompt without
    // duplicating this current turn (getMessages already includes it by then).
    const persistedUserMessage = addMessage(this._db, {
      conversation_id: conversationId,
      role: 'user',
      content: userText,
    })

    // Resolve slash commands (e.g. /specrails:propose-spec → prompt content)
    let resolvedText = resolveCommand(userText, this._cwd ?? process.cwd())

    // Fold attachments into the prompt as <user-attachment> text blocks under
    // an "## Attached Resources" section, mirroring how /generate-spec wires
    // them. Errors during extraction are logged and skipped — the chat turn
    // proceeds without that attachment rather than failing.
    let hasAttachments = false
    if (options?.attachments && options.attachments.ids.length > 0) {
      try {
        const attachmentResult = await this._awaitWhileLive(
          attachmentManager.getClaudeArgs(
            options.attachments.slug,
            options.attachments.ticketKey,
            options.attachments.ids,
          ),
        )
        if (attachmentResult.disposed) return
        const { textBlocks } = attachmentResult.value
        if (textBlocks.length > 0) {
          resolvedText = `${resolvedText}\n\n## Attached Resources\n\n${textBlocks.join('\n\n')}`
          hasAttachments = true
        }
      } catch (err) {
        console.error(`[chat-manager] attachment extraction failed (${conversationId}):`, err)
      }
      // Project removal may close the DB while attachment extraction is in
      // flight. Never continue into context reads or a new spawn afterwards.
      if (this._disposed) return
    }

    // Build spawn args via the resolved adapter. System prompt placement
    // (--system-prompt flag vs prompt-fold) and resume vs fresh-turn are both
    // adapter-driven via capability flags.
    const lightweight = options?.lightweight ?? false
    const conversationScope = this._resolveConversationScope(conversation)
    let systemPrompt = conversation.kind === 'milestone'
      ? this._buildMilestoneSystemPrompt(conversation)
      : lightweight
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
    // Milestone prompts contain volatile blueprint context and the complete
    // grounding/spec contract. Providers without a dedicated system-prompt
    // argument would otherwise receive none of it. Fold the exact same prompt
    // into their effective user turn so Claude, Codex, Gemini, and future
    // capability-equivalent adapters get the same instructions.
    if (conversation.kind === 'milestone' && !adapter.capabilities.systemPromptArg) {
      promptForAdapter =
        `## Milestone generation instructions\n\n${systemPrompt}\n\n` +
        `## User turn\n\n${resolvedText}`
    }
    // Providers WITHOUT a --system-prompt flag (codex AND gemini) drop
    // opts.systemPrompt for chat turns, so the Explore scoped-context (the
    // project's tickets/spec prefix the Add Spec scope toggle injects) would
    // never reach them — gemini then ignores the real project and wanders the
    // generic .gemini openspec tooling dir. Prepend the scoped context into the
    // user turn for any `systemPromptArg: false` provider (capability-gated, not
    // `id === 'codex'`, so it auto-covers future providers). Claude carries it
    // via --system-prompt and must NOT get the prepend.
    if (
      conversation.kind === 'explore' &&
      !adapter.capabilities.systemPromptArg &&
      conversationScope &&
      this._cwd
    ) {
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
    const buildRecoveryPrompt = (): string => buildResumeRecoveryPrompt(
      getMessages(this._db, conversationId)
        .filter((message) => message.id !== persistedUserMessage.id)
        .map((message) => ({ role: message.role, content: message.content })),
      promptForAdapter,
    )
    let args = adapter.buildArgs(action, {
      prompt: promptForAdapter,
      systemPrompt,
      model,
      sessionId: conversation.session_id ?? undefined,
      // Milestone generation only inspects the real repository and authors a
      // JSON draft. Enforce that boundary natively in every adapter; prompt
      // wording is defence-in-depth, not the permission boundary.
      toolPolicy: conversation.kind === 'milestone' ? 'read-only' : 'default',
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

    // Relocate-artifacts env for gated spawns: NON-explore (sidebar) turns, and
    // Explore turns with `contextScope.mcp` (they spawn from the workspace when
    // relocated — see `_resolveSpawnCwd`; the env makes the workspace's
    // `${SPECRAILS_REPO_DIR:-.}` indirection resolve to the repo). Explore with
    // mcp=false keeps its explore-cwd path (no relocation env — it reaches the
    // repo via the explore-cwd `./project` link). Legacy ⇒ process.env
    // (byte-identical).
    let spawnEnv: NodeJS.ProcessEnv = process.env
    const exploreMcp =
      conversation.kind === 'explore' &&
      !!conversationScope?.mcp &&
      process.env.SPECRAILS_EXPLORE_LEGACY_CWD !== '1'
    if (conversation.kind !== 'explore' || exploreMcp) {
      const exec = this._resolveNonExploreExecution()
      if (exec?.relocated) {
        spawnEnv = { ...process.env, ...exec.env }
        if (adapter.id === 'gemini') spawnEnv = { ...spawnEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
      }
    }
    const allowMissingSessionRecovery =
      adapter.id === 'claude' &&
      conversation.kind === 'explore' &&
      exploreMcp &&
      spawnCwd !== this._cwd &&
      spawnEnv.SPECRAILS_WORKSPACE_DIR === spawnCwd

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
        scopeFlags, spawnCwd, spawnEnv, promptForAdapter, isFirstTurn, userText,
        lightweight, conversationScope, buildRecoveryPrompt,
        allowMissingSessionRecovery,
      })
    }

    const child = this._spawnOwned(binary, args, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: spawnCwd,
    })

    let stderrBuf = ''
    // Drain stderr so the pipe buffer never fills up (child process would block otherwise)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this._disposed) return
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
      if (this._disposed) return
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
    /** Explicit failure reason emitted by the provider (codex `turn.failed` /
     *  `error`). When set, the turn failed for a concrete reason (usage limit,
     *  auth, model) that a respawn cannot fix — surface it instead of retrying. */
    let capturedErrorMessage: string | null = null
    let resumeRecoveryAttempted = false
    const turnStartedAt = new Date().toISOString()

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    const emitDelta = (newText: string) => {
      if (this._disposed) return
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
      if (this._disposed) return
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
        case 'error':
          // Capture the provider's explicit failure reason. Last-wins (codex
          // emits `error` then `turn.failed`, both carrying the same message).
          capturedErrorMessage = ev.message
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
      let settled = false
      const readers = new Set([stdoutReader])
      const closeChildren = new Set<ChildProcess>([child])
      const complete = () => {
        if (settled) return
        settled = true
        this._pendingTurnCancellations.delete(cancelForShutdown)
        resolve()
      }
      const cancelForShutdown = () => {
        if (settled) return
        for (const reader of readers) {
          try { reader.close() } catch { /* best-effort */ }
        }
        for (const ownedChild of closeChildren) {
          ownedChild.removeListener('close', onClose)
        }
        this._activeProcesses.delete(conversationId)
        this._buffers.delete(conversationId)
        this._emittedProposals.delete(conversationId)
        this._abortingConversations.delete(conversationId)
        this._streamFilters.delete(conversationId)
        complete()
      }
      const onClose = (code: number | null) => {
        if (settled) return
        if (this._disposed) {
          cancelForShutdown()
          return
        }
        console.log(`[chat-manager] ${adapter.id} exited code=${code} conv=${conversationId}`)
        const fullText = this._buffers.get(conversationId) ?? ''
        const wasAborting = this._abortingConversations.has(conversationId)

        // A session created before relocated MCP Explore moved from repo cwd to
        // workspace cwd cannot be found in Claude's per-cwd session store. This
        // is not a generic crash retry: recover ONLY the exact provider
        // diagnostic, only before any text/tool side effect, and only once.
        const missingPriorSession =
          allowMissingSessionRecovery &&
          action === 'chat-resume' &&
          !resumeRecoveryAttempted &&
          !wasAborting &&
          fullText.length === 0 &&
          !adapterEvents.some((event) => event.kind === 'tool-use') &&
          (
            containsMissingClaudeSessionDiagnostic(capturedErrorMessage) ||
            containsMissingClaudeSessionDiagnostic(stderrBuf) ||
            adapterEvents.some(
              (event) => event.kind === 'result' &&
                isMissingClaudeSessionErrorResult(event.payload),
            )
          )

        if (missingPriorSession) {
          resumeRecoveryAttempted = true
          // The old id is provably unusable from the corrected cwd. Clearing it
          // before the fresh attempt prevents every later turn from paying the
          // same failed lookup if this recovery spawn itself cannot complete.
          updateConversation(this._db, conversationId, { session_id: null })
          const recoveryPrompt = buildRecoveryPrompt()
          const recoveryArgs = adapter.buildArgs('chat-turn', {
            prompt: recoveryPrompt,
            systemPrompt,
            model,
            maxTurns: options?.maxTurns,
            extraArgs: scopeFlags,
            loadUserEnv: adapter.id === 'claude' && !!conversationScope?.userMcp,
          })
          console.warn(`[chat-manager] stale Explore session; retrying fresh for ${conversationId}`)
          try {
            const newChild = this._spawnOwned(binary, recoveryArgs, {
              env: spawnEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
              cwd: spawnCwd,
            })
            currentChild = newChild
            closeChildren.add(newChild)
            args = recoveryArgs
            // The failed lookup reached a terminal result but burned no model
            // turn. Keep it visible in analytics, then isolate the fresh turn's
            // canonical result/session id from the stale frame.
            this._recordChatInvocation({
              conversationId,
              kind: conversation.kind,
              adapter,
              events: adapterEvents,
              model,
              status: 'failed',
              startedAt: turnStartedAt,
            })
            this._buffers.set(conversationId, '')
            this._streamFilters.set(conversationId, { inBlock: false, pendingTail: '' })
            adapterEvents.length = 0
            capturedSessionId = null
            capturedErrorMessage = null
            sawResult = false
            stderrBuf = ''
            // Consume the normal Explore crash budget so a failed fresh retry is
            // surfaced rather than replaying the same user turn a third time.
            const life = this._exploreLifecycle.get(conversationId)
            if (life) life.crashCount = 1
            this._activeProcesses.set(conversationId, newChild)
            newChild.stderr?.on('data', (chunk: Buffer) => {
              if (this._disposed) return
              const text = chunk.toString()
              stderrBuf += text
              console.error(`[chat-manager] ${binary} stderr (${conversationId}):`, text.trim())
            })
            newChild.on('error', (err) => {
              if (this._disposed) {
                cancelForShutdown()
                return
              }
              console.error(`[chat-manager] stale-session recovery spawn failed for ${conversationId}: ${err.message}`)
              this._recordChatInvocation({
                conversationId,
                kind: conversation.kind,
                adapter,
                events: adapterEvents,
                model,
                status: 'failed',
                startedAt: turnStartedAt,
              })
              this._activeProcesses.delete(conversationId)
              this._buffers.delete(conversationId)
              this._emittedProposals.delete(conversationId)
              this._abortingConversations.delete(conversationId)
              this._streamFilters.delete(conversationId)
              const activeLife = this._exploreLifecycle.get(conversationId)
              if (activeLife) {
                activeLife.isStreaming = false
                activeLife.lastActivityAt = Date.now()
                if (activeLife.isMinimized) this._startIdleTimer(conversationId)
              }
              this._drainExploreQueue()
              this._broadcast({
                type: 'chat_error',
                conversationId,
                error: `Failed to launch ${binary}: ${err.message}`,
                timestamp: new Date().toISOString(),
              })
              complete()
            })
            const newReader = createInterface({ input: newChild.stdout!, crlfDelay: Infinity })
            readers.add(newReader)
            newReader.on('line', readerHandler)
            newChild.on('close', onClose)
            return
          } catch (err) {
            console.error('[chat-manager] stale-session recovery spawn failed:', err)
            // Fall through and surface the original missing-session error.
          }
        }

        // Crash auto-respawn for Explore: if the child exited non-zero before
        // emitting a `result` event, the user did not explicitly abort, and
        // we have not yet retried, respawn the same turn once via chat-resume
        // when the adapter supports it and a session id was captured.
        // See design.md D7.
        if (
          conversation.kind === 'explore' &&
          !wasAborting &&
          !resumeRecoveryAttempted &&
          code !== 0 &&
          !sawResult &&
          // A provider-reported failure (usage limit, auth, unsupported model)
          // will recur identically on respawn — surface it instead of retrying.
          !capturedErrorMessage
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
              const newChild = this._spawnOwned(binary, respawnArgs, {
                env: spawnEnv,
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: spawnCwd,
              })
              currentChild = newChild
              closeChildren.add(newChild)
              args = respawnArgs
              // MED-2: the crashed spawn already burned tokens (tool-call rounds
              // before the crash). Its usage was aggregated into adapterEvents by
              // the adapter's per-assistant-event capture; record it as a 'failed'
              // row (priced via the pricing-table fallback) BEFORE we zero the
              // accumulator for the respawn. Without this the turn only ever
              // records the respawned process's cost, undercounting by the entire
              // pre-crash burn (the respawn's --resume restores conversation
              // state, not the cost counter).
              this._recordChatInvocation({
                conversationId,
                kind: conversation.kind,
                adapter,
                events: adapterEvents,
                model,
                status: 'failed',
                startedAt: turnStartedAt,
              })
              // Reset the per-turn accumulators so the resumed turn REPLACES the
              // pre-crash partial output instead of appending to it (which would
              // duplicate the assistant text and double-count tokens/cost).
              this._buffers.set(conversationId, '')
              this._streamFilters.set(conversationId, { inBlock: false, pendingTail: '' })
              adapterEvents.length = 0
              this._activeProcesses.set(conversationId, newChild)
              newChild.stderr?.on('data', (chunk: Buffer) => {
                if (this._disposed) return
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
                if (this._disposed) {
                  cancelForShutdown()
                  return
                }
                console.error(`[chat-manager] explore crash-respawn spawn failed for ${conversationId}: ${err.message}`)
                // MED-2: the respawn never streamed a result event, so the normal
                // close-path recording is bypassed. Record whatever usage the
                // respawn accumulated (typically none) as a 'failed' row so the
                // turn is never entirely invisible to analytics.
                this._recordChatInvocation({
                  conversationId,
                  kind: conversation.kind,
                  adapter,
                  events: adapterEvents,
                  model,
                  status: 'failed',
                  startedAt: turnStartedAt,
                })
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
                complete()
              })
              /* c8 ignore stop */
              const newReader = createInterface({ input: newChild.stdout!, crlfDelay: Infinity })
              readers.add(newReader)
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

        // ai_invocations capture. MED-4: records explore (surface='explore-spec')
        // AND sidebar (surface='chat-sidebar') turns — see _recordChatInvocation.
        const invStatus: InvocationStatus = wasAborting
          ? 'aborted'
          : code === 0
            ? 'success'
            : 'failed'
        this._recordChatInvocation({
          conversationId,
          kind: conversation.kind,
          adapter,
          events: adapterEvents,
          model,
          status: invStatus,
          startedAt: turnStartedAt,
        })

        if (wasAborting) {
          // abort already emitted chat_error
          complete()
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
          // Prefer the provider's own failure reason (codex turn.failed/error)
          // over the generic exit-code/stderr message.
          const error = capturedErrorMessage
            ? capturedErrorMessage
            : stderrTail
              ? `${binary} exited with code ${code ?? 'unknown'}: ${stderrTail}`
              : `Process exited with code ${code ?? 'unknown'}`
          this._broadcast({
            type: 'chat_error',
            conversationId,
            error,
            timestamp: new Date().toISOString(),
          })
        }

        complete()
      }
      this._pendingTurnCancellations.add(cancelForShutdown)
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
    spawnEnv: NodeJS.ProcessEnv
    promptForAdapter: string
    isFirstTurn: boolean
    userText: string
    lightweight: boolean
    conversationScope: ContextScope | null
    buildRecoveryPrompt: () => string
    allowMissingSessionRecovery: boolean
    resumeRecoveryAttempted?: boolean
  }): Promise<void> {
    if (this._disposed) return
    const {
      conversationId, conversation, adapter, binary, model, systemPrompt,
      scopeFlags, spawnCwd, spawnEnv, promptForAdapter, isFirstTurn, userText,
      lightweight, conversationScope, buildRecoveryPrompt,
    } = p

    const sessionArgs = adapter.buildArgs('chat-stream', {
      prompt: '',
      systemPrompt,
      model,
      sessionId: conversation.session_id ?? undefined,
      extraArgs: scopeFlags,
      loadUserEnv: adapter.id === 'claude' && !!conversationScope?.userMcp,
    })

    const { child, isNew } = this._stdinSessions.getOrSpawn(conversationId, {
      binary, args: sessionArgs, cwd: spawnCwd, env: spawnEnv, spawn: this._spawnOwned.bind(this),
    })
    this._trackPersistentProcess(conversationId, child)
    // MED-1: a fresh child restarts claude's session-cumulative counters at 0,
    // so drop any stale baseline. The next turn diffs against zero.
    if (isNew) this._stdinCumulative.delete(conversationId)
    this._activeProcesses.set(conversationId, child)
    this._buffers.set(conversationId, '')
    this._emittedProposals.set(conversationId, new Set())
    this._streamFilters.set(conversationId, { inBlock: false, pendingTail: '' })

    const adapterEvents: AdapterEvent[] = []
    let capturedSessionId: string | null = null
    let stderrBuf = ''
    const turnStartedAt = new Date().toISOString()

    const emitDelta = (newText: string) => {
      if (this._disposed) return
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
      if (this._disposed) return
      if (!this._projectId) return
      try {
        const { result, estimated } = finaliseInvocationResult(adapter, adapterEvents, {
          fallbackModel: model,
        })
        // MED-1: the persistent-stdin transport reuses ONE long-lived child for
        // the whole session, so claude's `result` event reports
        // SESSION-CUMULATIVE cost/tokens/num_turns — row n carries the totals of
        // turns 1..n. Recording them verbatim multiplies conversation cost
        // (~×(N+1)/2). Diff each cumulative field against the previous snapshot
        // and record the per-turn DELTA (clamped ≥0 for safety against any
        // non-monotonic report), so summing the rows equals the session total.
        // The baseline resets on (re)spawn (see `isNew` above).
        const prev = this._stdinCumulative.get(conversationId) ?? {
          cost: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0,
        }
        // Returns the per-turn delta to record, and the next cumulative baseline.
        // A field the provider did not report (undefined) leaves the baseline
        // untouched and records NULL for that field this turn.
        const step = (cur: number | undefined, base: number): { delta: number | undefined; next: number } =>
          cur === undefined || cur === null
            ? { delta: undefined, next: base }
            : { delta: Math.max(0, cur - base), next: cur }
        const dCost = step(result.total_cost_usd, prev.cost)
        const dTurns = step(result.num_turns, prev.turns)
        const dIn = step(result.tokens_in, prev.tokensIn)
        const dOut = step(result.tokens_out, prev.tokensOut)
        const dCacheRead = step(result.tokens_cache_read, prev.cacheRead)
        const dCacheCreate = step(result.tokens_cache_create, prev.cacheCreate)
        this._stdinCumulative.set(conversationId, {
          cost: dCost.next,
          turns: dTurns.next,
          tokensIn: dIn.next,
          tokensOut: dOut.next,
          cacheRead: dCacheRead.next,
          cacheCreate: dCacheCreate.next,
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
          // Non-cumulative fields (model, durations, session_id) pass through.
          ...result,
          // …cumulative fields are overwritten with the per-turn delta.
          total_cost_usd: dCost.delta,
          num_turns: dTurns.delta,
          tokens_in: dIn.delta,
          tokens_out: dOut.delta,
          tokens_cache_read: dCacheRead.delta,
          tokens_cache_create: dCacheCreate.delta,
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
      if (this._disposed) return
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
      const complete = () => {
        this._pendingTurnCancellations.delete(cancelForShutdown)
        resolve()
      }
      const cancelForShutdown = () => {
        if (settled) return
        settled = true
        this._stdinSessions.clearHandlers(conversationId)
        cleanupTurnState()
        this._abortingConversations.delete(conversationId)
        complete()
      }
      // LOW-7: the persistent transport ends the turn on the `result` event even
      // when that event reports a failure (is_error / an `error_*` subtype, e.g.
      // error_max_turns). Recording those as status='success' misreports the
      // turn; flip to 'failed' (the cost is still kept — the result carries real
      // usage). Set at result time, read by finishTurn.
      let resultIsError = false

      const recoverMissingSession = (diagnostic: unknown): boolean => {
        if (
          settled ||
          !p.allowMissingSessionRecovery ||
          !conversation.session_id ||
          p.resumeRecoveryAttempted ||
          this._abortingConversations.has(conversationId) ||
          (this._buffers.get(conversationId) ?? '').length > 0 ||
          adapterEvents.some((event) => event.kind === 'tool-use') ||
          !(
            containsMissingClaudeSessionDiagnostic(diagnostic) ||
            containsMissingClaudeSessionDiagnostic(stderrBuf)
          )
        ) {
          return false
        }

        // The persistent child was launched with the stale --resume before its
        // first stdin turn. Evict it, but keep the Explore lifecycle slot held
        // while a brand-new stream child receives the same turn exactly once.
        settled = true
        // Persist the invalidation before replacing the old stream child. A
        // failed fresh attempt must not leave the known-bad repo-cwd id behind.
        updateConversation(this._db, conversationId, { session_id: null })
        this._stdinSessions.clearHandlers(conversationId)
        cleanupTurnState()
        recordInv('failed')
        this._stdinSessions.kill(conversationId)
        console.warn(`[chat-manager] stale persistent Explore session; retrying fresh for ${conversationId}`)

        void this._streamPersistentExploreTurn({
          ...p,
          conversation: { ...conversation, session_id: null },
          promptForAdapter: buildRecoveryPrompt(),
          isFirstTurn: false,
          resumeRecoveryAttempted: true,
        }).then(complete).catch((err) => {
          if (!this._disposed) {
            console.error(`[chat-manager] persistent stale-session recovery failed for ${conversationId}:`, err)
            markStreamingEnded(false)
            this._broadcast({
              type: 'chat_error',
              conversationId,
              error: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            })
          }
          complete()
        })
        return true
      }

      const finishTurn = () => {
        if (settled) return
        if (this._disposed) {
          cancelForShutdown()
          return
        }
        settled = true
        this._stdinSessions.clearHandlers(conversationId)
        const fullText = this._buffers.get(conversationId) ?? ''
        const wasAborting = this._abortingConversations.has(conversationId)
        cleanupTurnState()
        this._abortingConversations.delete(conversationId)
        markStreamingEnded(true)
        recordInv(wasAborting ? 'aborted' : resultIsError ? 'failed' : 'success')

        // On abort, the abort() path already emitted chat_error and the turn is
        // user-cancelled — do NOT persist the partial assistant message, update
        // the session, or broadcast chat_done (mirrors the legacy close handler).
        if (wasAborting) {
          complete()
          return
        }

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
        complete()
      }

      const onClose = (code: number | null) => {
        // The persistent child died (crash / idle-kill / shutdown). If the turn
        // already finished on its `result` event, ignore. No crash-respawn —
        // the session is evicted by the transport; the next turn re-spawns with
        // `--resume`, so no persisted state is lost.
        if (settled) return
        if (this._disposed) {
          cancelForShutdown()
          return
        }
        if (recoverMissingSession(stderrBuf)) return
        settled = true
        this._stdinSessions.clearHandlers(conversationId)
        const wasAborting = this._abortingConversations.has(conversationId)
        cleanupTurnState()
        this._abortingConversations.delete(conversationId)
        markStreamingEnded(false)
        recordInv(wasAborting ? 'aborted' : 'failed')
        if (wasAborting) {
          complete()
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
        complete()
      }

      const onLine = (line: string) => {
        if (this._disposed || settled) return
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
            const payload = ev.payload as { session_id?: string; is_error?: unknown; subtype?: unknown }
            if (recoverMissingSession(isMissingClaudeSessionErrorResult(payload) ? payload : null)) break
            if (payload.session_id) capturedSessionId = payload.session_id
            // LOW-7: detect a failed turn reported through the result frame.
            resultIsError =
              payload.is_error === true ||
              (typeof payload.subtype === 'string' && payload.subtype.startsWith('error'))
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
          if (this._disposed || settled) return
          stderrBuf += s
          console.error(`[chat-manager] ${binary} stderr (${conversationId}):`, s.trim())
        },
        onClose,
      })
      this._pendingTurnCancellations.add(cancelForShutdown)

      if (!this._stdinSessions.writeTurn(conversationId, promptForAdapter)) {
        // stdin already gone (child died between spawn and write) — fail the turn.
        onClose(null)
      }
    })
  }

  abort(conversationId: string): void {
    if (this._disposed) return
    const child = this._activeProcesses.get(conversationId)
    if (!child || !child.pid) return

    this._abortingConversations.add(conversationId)
    this._terminate(child)

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
    if (this._disposed) return
    this._clearIdleTimer(conversationId)
    const idx = this._exploreQueue.findIndex((q) => q.conversationId === conversationId)
    if (idx >= 0) {
      clearTimeout(this._exploreQueue[idx].timeoutTimer)
      this._exploreQueue.splice(idx, 1)
    }
    const persistentChild = this._persistentProcesses.get(conversationId)
    if (persistentChild) {
      this._terminate(persistentChild)
      this._closeChildIo(persistentChild)
      this._persistentProcesses.delete(conversationId)
    }
    this._stdinSessions.kill(conversationId)
    this._stdinCumulative.delete(conversationId)
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
    if (this._disposed) return
    this._disposed = true
    this._resolveDisposed()

    // Snapshot before cancellation callbacks remove ownership from the maps.
    const ownedChildren = new Set([
      ...this._activeProcesses.values(),
      ...this._persistentProcesses.values(),
    ])
    const auxChildren = Array.from(this._auxProcesses)

    // Settle every queued capacity waiter and every spawned-turn promise now;
    // do not rely on a killed/wedged child eventually emitting `close`.
    for (const q of this._exploreQueue) {
      clearTimeout(q.timeoutTimer)
      q.onTimeout()
    }
    this._exploreQueue = []
    for (const cancel of Array.from(this._pendingTurnCancellations)) cancel()
    this._pendingTurnCancellations.clear()

    for (const child of ownedChildren) {
      // ChatManager's process-group timer remains authoritative even for
      // persistent children: the transport's legacy root-PID escalation cannot
      // reach a resistant MCP after the root exits.
      this._terminate(child)
      this._closeChildIo(child)
    }
    // Persistent-stdin children outlive individual turns — tear them down too.
    this._stdinSessions.killAll()
    this._persistentProcesses.clear()
    this._stdinCumulative.clear()
    // Fire-and-forget auxiliary children (auto-title) are not keyed by
    // conversation; tree-kill any in-flight one so it isn't orphaned on
    // shutdown / project removal (BUG-CHAT-02).
    for (const child of auxChildren) {
      const reader = this._auxReaders.get(child)
      try { reader?.close() } catch { /* best-effort */ }
      this._terminate(child)
      this._closeChildIo(child)
    }
    this._auxReaders.clear()
    this._auxProcesses.clear()
    for (const id of this._exploreLifecycle.keys()) {
      this._clearIdleTimer(id)
    }
    this._activeProcesses.clear()
    this._reservedTurns.clear()
    this._buffers.clear()
    this._emittedProposals.clear()
    this._abortingConversations.clear()
    this._streamFilters.clear()
    this._exploreLifecycle.clear()
    this._specDraftStates.clear()
  }

  /**
   * Record an ai_invocations row for a chat turn (explore or sidebar).
   *
   * MED-4: this records BOTH `kind='explore'` (surface `explore-spec`) AND
   * `kind='sidebar'` (surface `chat-sidebar`) turns. Sidebar was previously
   * documented as intentionally out-of-scope (CLAUDE.md), but every sidebar
   * turn is fully billable — it spawns in the project path (so the project
   * CLAUDE.md auto-loads), prepends the live dashboard context, and uses the
   * full live-context system prompt — so leaving it unrecorded is a systemic
   * undercount versus Claude's own accounting. This deliberately reverses that
   * earlier exclusion. No-op for any other kind, or when no project is set.
   *
   * Cost/tokens still come from `finaliseInvocationResult`, which applies the
   * pricing-table fallback (estimated=true) when the provider reported no
   * native cost — so kill/crash paths still record a priced row.
   */
  private _recordChatInvocation(opts: {
    conversationId: string
    kind: string | null | undefined
    adapter: ProviderAdapter
    events: AdapterEvent[]
    model: string
    status: InvocationStatus
    startedAt: string
    /** Defaults to `conversationId`. Auto-title passes `title:<conversationId>`. */
    surfaceRefId?: string
  }): void {
    if (this._disposed) return
    if (!this._projectId) return
    if (opts.kind !== 'explore' && opts.kind !== 'sidebar' && opts.kind !== 'milestone') return
    // Milestone generation (add-project-builder D7) deliberately records as
    // 'explore-spec' — no new surface value (analytics guardrail).
    const surface: Surface = opts.kind === 'explore' || opts.kind === 'milestone' ? 'explore-spec' : 'chat-sidebar'
    try {
      const { result, estimated } = finaliseInvocationResult(opts.adapter, opts.events, {
        fallbackModel: opts.model,
      })
      recordInvocation(this._db, {
        id: randomUUID(),
        project_id: this._projectId,
        provider: opts.adapter.id,
        surface,
        surface_ref_id: opts.surfaceRefId ?? opts.conversationId,
        conversation_id: opts.conversationId,
        status: opts.status,
        started_at: opts.startedAt,
        finished_at: new Date().toISOString(),
        total_cost_usd_estimated: estimated,
        ...result,
      })
      this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
    } catch (err) {
      console.error('[chat-manager] recordInvocation failed:', err)
    }
  }

  private _autoTitle(conversationId: string, firstUserMsg: string, firstResponse: string): void {
    if (this._disposed) return
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
      const child = this._spawnOwned(adapter.binary, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this._cwd,
      })
      // Track this fire-and-forget child so shutdown() can tree-kill it
      // instead of orphaning it (BUG-CHAT-02). Self-removed on 'close'.
      this._auxProcesses.add(child)

      let titleText = ''
      // LOW-1: the auto-title spawn is a real, billable CLI invocation fired on
      // the first turn of EVERY conversation. Accumulate its parsed events so we
      // can record an ai_invocations row at close (surface = the conversation's
      // kind, surface_ref_id = `title:<conversationId>`), instead of leaving it
      // invisible to analytics.
      const titleEvents: AdapterEvent[] = []
      const titleStartedAt = new Date().toISOString()
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
      this._auxReaders.set(child, reader)

      reader.on('line', (line) => {
        if (this._disposed) return
        const ev = adapter.parseStreamLine(line)
        if (!ev) return
        titleEvents.push(ev)
        // Keep the FIRST non-empty text-delta as the title (unchanged behaviour).
        if (!titleText && ev.kind === 'text-delta') {
          const trimmed = ev.text.trim()
          if (trimmed) titleText = trimmed
        }
      })

      child.on('error', () => {
        this._auxProcesses.delete(child)
        this._auxReaders.delete(child)
        try { reader.close() } catch { /* best-effort */ }
      })
      child.on('close', (code) => {
        this._auxProcesses.delete(child)
        this._auxReaders.delete(child)
        try { reader.close() } catch { /* best-effort */ }
        if (this._disposed) return
        this._recordChatInvocation({
          conversationId,
          kind: conv?.kind,
          adapter,
          events: titleEvents,
          model: adapter.defaultModel(),
          status: code === 0 ? 'success' : 'failed',
          startedAt: titleStartedAt,
          surfaceRefId: `title:${conversationId}`,
        })
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
