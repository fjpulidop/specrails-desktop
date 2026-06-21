/**
 * SPECs SMASH — Runner
 *
 * Standalone orchestrator for a single SMASH turn. Spawns a fresh `claude`
 * with the byte-stable SMASH system prompt, parses the JSON response, then
 * atomically flips the parent ticket to `is_epic` and inserts N child
 * tickets inside a single `mutateStore` callback.
 *
 * See openspec/changes/add-specs-smash.
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'

import { spawnAiCli } from './util/cli-prompt'
import {
  buildSmashSystemPrompt,
  parseSmashOutput,
  isSpecsSmashKillSwitchActive,
  type SmashChild,
  type SmashMode,
  type SmashValidationReason,
} from './explore-smash'
import { ensureExploreCwd } from './explore-cwd-manager'
import { resolveProjectExecution } from './workspace-resolution'
import { recordInvocation } from './ai-invocations'
import { normaliseResultEvent } from './result-event'
import { clampShortSummary } from './ticket-store'
import {
  mutateStore,
  resolveTicketStoragePath,
  type Ticket,
  type TicketStore,
} from './ticket-store'
import type { DbInstance } from './db'

/** Resolve the tickets-store path for a SMASH run: the gated `ticketsPath` when
 *  the caller threaded it (relocation-aware), else the legacy repo-relative
 *  derivation. */
function smashTicketsPath(deps: Pick<SmashDeps, 'ticketsPath' | 'projectPath'>): string {
  return deps.ticketsPath ?? resolveTicketStoragePath(deps.projectPath)
}

const SMASH_TIMEOUT_MS_SIMPLE = 60_000
const SMASH_TIMEOUT_MS_FULL = 900_000      // 15 min — super-spec mode, no rush
const SMASH_MAX_TURNS_SIMPLE = 1
const SMASH_MAX_TURNS_FULL = 30            // plenty of room for codebase exploration

export type SmashFailureReason =
  | 'disabled'
  | 'ticket-not-found'
  | 'is-draft'
  | 'no-contract-layer'
  | 'is-child'
  | 'has-children'
  | 'already-epic-no-children-ok'
  | 'crashed'
  | 'model_error'
  | 'timeout'
  | 'invalid-output'
  | 'mutation-failed'
  | 'in-progress'

export interface SmashDeps {
  db: DbInstance
  projectId: string
  projectSlug: string
  projectPath: string
  projectName: string
  /** Relocate-artifacts: the gated tickets-store path (workspace when relocated,
   *  else `<project>/.specrails/local-tickets.json`). When provided, SMASH reads
   *  and writes the store HERE instead of re-deriving from `projectPath` (which
   *  would target a stale repo copy the rails never load). Optional for
   *  byte-identical legacy + test back-compat. */
  ticketsPath?: string
  /** Broadcaster — emits `smash.*` events plus `ticket_*` events. */
  broadcast: (msg: unknown) => void
  /** Optional spawn injection (tests). */
  spawn?: typeof spawnAiCli
  /** Optional now() injection (tests). */
  now?: () => Date
  /** Override the timeout (tests). */
  timeoutMs?: number
  /** Model override; defaults to 'sonnet'. */
  model?: string | null
  /** Mode override; defaults to 'simple'. */
  mode?: SmashMode
}

export interface SmashOutcome {
  ok: boolean
  reason?: SmashFailureReason
  ticketId: number
  runId: string
  childrenIds?: number[]
}

// ─── Pre-flight gating ───────────────────────────────────────────────────────

const CONTRACT_LAYER_MARKER = '## Contract Layer'

export interface SmashGateContext {
  ticket: Ticket
  childCount: number
}

export type SmashGateResult =
  | { ok: true; context: SmashGateContext }
  | { ok: false; reason: SmashFailureReason }

/**
 * Check whether the ticket is eligible to be SMASHed. Pure function for ease
 * of testing — does not mutate state, does not depend on env.
 */
export function checkSmashEligibility(store: TicketStore, ticketId: number): SmashGateResult {
  const ticket = store.tickets[String(ticketId)]
  if (!ticket) return { ok: false, reason: 'ticket-not-found' }
  if (ticket.status === 'draft') return { ok: false, reason: 'is-draft' }
  if (ticket.parent_epic_id !== null) return { ok: false, reason: 'is-child' }
  if (!ticket.description.includes(CONTRACT_LAYER_MARKER)) {
    return { ok: false, reason: 'no-contract-layer' }
  }
  // Already-épica with children → must delete first.
  let childCount = 0
  for (const id of Object.keys(store.tickets)) {
    if (store.tickets[id].parent_epic_id === ticketId) childCount += 1
  }
  if (ticket.is_epic && childCount > 0) return { ok: false, reason: 'has-children' }
  return { ok: true, context: { ticket, childCount } }
}

// ─── Spawn helpers ───────────────────────────────────────────────────────────

function buildSmashArgs(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  mode: SmashMode,
): string[] {
  // Simple: deny all tools, single turn — fast, no codebase access.
  // Full: allow Read/Grep/Glob (read-only), multi-turn — slower, grounded.
  const disallowed = mode === 'full' ? 'Bash,Edit,Write,NotebookEdit' : 'Read,Grep,Glob,Bash'
  const maxTurns = mode === 'full' ? SMASH_MAX_TURNS_FULL : SMASH_MAX_TURNS_SIMPLE
  return [
    '--model', model,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', systemPrompt,
    '--disallowedTools', disallowed,
    '--max-turns', String(maxTurns),
    '-p', userPrompt,
  ]
}

/**
 * Build the spawn argv + cwd. Exported for tests.
 */
export function prepareSmashSpawn(
  deps: Pick<SmashDeps, 'projectSlug' | 'projectPath' | 'projectName' | 'model' | 'mode'>,
  ticket: Ticket,
): { args: string[]; cwd: string; env?: Record<string, string>; systemPrompt: string; userPrompt: string; mode: SmashMode } {
  const mode: SmashMode = deps.mode === 'full' ? 'full' : 'simple'
  const systemPrompt = buildSmashSystemPrompt(mode)
  const userPrompt = `${ticket.title}\n\n${ticket.description}`
  let cwd: string
  let env: Record<string, string> | undefined
  // Full mode needs access to the project tree (so Read/Grep/Glob hit the
  // real repo). Simple mode keeps the app-managed dir for a clean scope.
  if (mode === 'full') {
    // Relocate-artifacts: when relocated, spawn from the workspace (so the CLI
    // discovers the relocated agents/profiles + reaches the repo via the
    // `./project` symlink + SPECRAILS_REPO_DIR). Legacy ⇒ cwd = project.path,
    // empty env (byte-identical).
    const exec = resolveProjectExecution({ slug: deps.projectSlug, path: deps.projectPath })
    cwd = exec.cwd
    env = exec.relocated ? exec.env : undefined
  } else {
    try {
      cwd = ensureExploreCwd({
        slug: deps.projectSlug,
        projectPath: deps.projectPath,
        projectName: deps.projectName,
      })
    } catch {
      cwd = deps.projectPath
    }
  }
  const model = deps.model ?? 'sonnet'
  return { args: buildSmashArgs(model, systemPrompt, userPrompt, mode), cwd, env, systemPrompt, userPrompt, mode }
}

/** Grace before SIGKILL-escalating a child that swallowed SIGTERM. */
const SMASH_SIGKILL_GRACE_MS = 2_000

/**
 * BUG-PARSER-01: tear down the FULL process subtree on timeout, mirroring the
 * shared `spawn-lifecycle.ts` teardown. A bare `child.kill('SIGTERM')` leaves
 * grandchildren orphaned and never force-kills a signal-swallowing CLI — a real
 * risk for SMASH `full` mode (15-minute timeout, Read/Grep/Glob enabled). We
 * treeKill SIGTERM, then SIGKILL-escalate after a grace window. The escalation
 * timer is returned so the close handler can clear it. Inlined here (not a
 * shared module) per file-ownership constraints.
 *
 * `kill` is injectable for tests so the timeout path can be asserted without
 * spawning a real `ps`/`taskkill` against a fake pid.
 */
type TreeKiller = (pid: number, signal: string, cb?: (err?: Error) => void) => void

function escalateSmashKill(
  pid: number | undefined,
  kill: TreeKiller,
): NodeJS.Timeout | null {
  if (typeof pid !== 'number') return null
  try {
    kill(pid, 'SIGTERM', () => { /* best-effort */ })
  } catch { /* already gone */ }
  const escalation = setTimeout(() => {
    try {
      kill(pid, 'SIGKILL', () => { /* best-effort */ })
    } catch { /* already gone */ }
  }, SMASH_SIGKILL_GRACE_MS)
  if (typeof escalation.unref === 'function') escalation.unref()
  return escalation
}

/**
 * Read stream-json output from a child process. Exported for tests.
 */
export function readSmashChildOutput(
  child: ChildProcess,
  timeoutMs: number,
  kill: TreeKiller = treeKill,
): Promise<{
  fullText: string
  resultEvent: Record<string, unknown> | null
  code: number | null
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    let fullText = ''
    let resultEvent: Record<string, unknown> | null = null
    let timedOut = false
    let settled = false
    if (!child.stdout) {
      resolve({ fullText, resultEvent, code: -1, timedOut: false })
      return
    }
    let killEscalation: NodeJS.Timeout | null = null
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', (line: string) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { return }
      if (!parsed) return
      const type = parsed.type as string
      if (type === 'result') {
        resultEvent = parsed
      } else if (type === 'assistant') {
        const message = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined
        const blocks = message?.content ?? []
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') fullText += b.text
        }
      }
    })
    const timer = setTimeout(() => {
      timedOut = true
      // BUG-PARSER-01: treeKill the whole subtree (SIGTERM) and SIGKILL-escalate
      // after a grace window so a signal-swallowing CLI tree is force-killed.
      killEscalation = escalateSmashKill(child.pid, kill)
      if (!settled) {
        settled = true
        resolve({ fullText, resultEvent, code: null, timedOut: true })
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      // The child exited — cancel the pending SIGKILL escalation.
      if (killEscalation) { clearTimeout(killEscalation); killEscalation = null }
      if (settled) return
      settled = true
      resolve({ fullText, resultEvent, code, timedOut })
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (killEscalation) { clearTimeout(killEscalation); killEscalation = null }
      if (settled) return
      settled = true
      resolve({ fullText, resultEvent, code: -1, timedOut })
    })
  })
}

// ─── Store mutation ──────────────────────────────────────────────────────────

interface ApplySmashResult {
  epic: Ticket
  children: Ticket[]
  smashedAt: string
}

/**
 * Compose the final markdown description persisted for a Sub-Spec.
 * Appends "Why this Sub-Spec" (rationale) and "Acceptance Criteria" sections
 * when those fields are populated (full mode). Simple mode leaves the agent's
 * description as-is.
 */
export function composeChildDescription(child: SmashChild): string {
  const parts: string[] = [child.description.trim()]
  if (child.rationale && child.rationale.trim().length > 0) {
    parts.push('', '## Why this Sub-Spec', '', child.rationale.trim())
  }
  if (child.acceptanceCriteria && child.acceptanceCriteria.length > 0) {
    parts.push('', '## Acceptance Criteria', '')
    for (const ac of child.acceptanceCriteria) {
      parts.push(`- ${ac}`)
    }
  }
  return parts.join('\n')
}

/**
 * Inside a single `mutateStore` callback, flip the parent to épica and
 * insert N child tickets. Returns the updated épica plus the inserted
 * children. Throws if the ticket disappears between the gate check and
 * the lock (rare race).
 */
export function applySmashToStore(
  filePath: string,
  epicId: number,
  children: SmashChild[],
  nowIso: string,
  createdBy: string,
): ApplySmashResult {
  let epic: Ticket | null = null
  const inserted: Ticket[] = []
  mutateStore(filePath, (s: TicketStore) => {
    const target = s.tickets[String(epicId)]
    if (!target) throw new Error(`épica ${epicId} not found inside mutation`)
    target.is_epic = true
    // Stash the pre-SMASH status so undo can restore it. Only stash on first
    // SMASH (re-SMASH already done) — if already done, leave the original
    // stash in place.
    if (!target.metadata) target.metadata = {}
    const md = target.metadata as { pre_smash_status?: string }
    if (!md.pre_smash_status) {
      md.pre_smash_status = target.status
    }
    // Mark the épica as done so it leaves the active backlog and only the
    // Sub-Specs remain as actionable work.
    target.status = 'done'
    target.updated_at = nowIso
    epic = target
    for (const child of children) {
      const id = s.next_id++
      const description = composeChildDescription(child)
      const ticket: Ticket = {
        id,
        title: child.title,
        description,
        status: 'todo',
        priority: child.priority,
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        comments: [],
        attachments: [],
        origin_conversation_id: null,
        is_epic: false,
        parent_epic_id: epicId,
        execution_order: child.executionOrder,
        short_summary: clampShortSummary(child.shortSummary),
        created_at: nowIso,
        updated_at: nowIso,
        created_by: createdBy,
        source: 'specs-smash',
      }
      s.tickets[String(id)] = ticket
      inserted.push(ticket)
    }
  })
  if (!epic) throw new Error('mutation did not yield épica')
  return { epic, children: inserted, smashedAt: nowIso }
}

/**
 * Undo a SMASH: clear `is_epic` on the parent and delete every child whose
 * `parent_epic_id` matches AND whose `created_at >= smashedAt`. Returns the
 * ids of the deleted children plus the updated épica (or null when no épica
 * exists / no longer flagged).
 */
export function applySmashUndo(
  filePath: string,
  epicId: number,
  smashedAt: string,
  nowIso: string,
): { epic: Ticket | null; deletedChildren: number[] } {
  let epic: Ticket | null = null
  const deletedChildren: number[] = []
  mutateStore(filePath, (s: TicketStore) => {
    const target = s.tickets[String(epicId)]
    if (!target) return
    if (!target.is_epic) return
    for (const idStr of Object.keys(s.tickets)) {
      const t = s.tickets[idStr]
      if (t.parent_epic_id === epicId && t.created_at >= smashedAt) {
        deletedChildren.push(t.id)
        delete s.tickets[idStr]
      }
    }
    target.is_epic = false
    // Restore the pre-SMASH status from metadata if available.
    // B61: 'done' was missing from this whitelist, so undoing a SMASH on a ticket
    // that was 'done' before silently demoted it to 'todo'. Include every valid
    // non-epic status.
    const md = (target.metadata ?? {}) as { pre_smash_status?: string }
    if (md.pre_smash_status === 'todo' || md.pre_smash_status === 'in_progress'
        || md.pre_smash_status === 'cancelled' || md.pre_smash_status === 'draft'
        || md.pre_smash_status === 'done') {
      target.status = md.pre_smash_status
    } else {
      target.status = 'todo'
    }
    delete md.pre_smash_status
    target.updated_at = nowIso
    epic = target
  })
  return { epic, deletedChildren }
}

/**
 * Delete all children of an épica without undoing the épica flip itself.
 * Used by the Re-SMASH flow.
 */
export function applyDeleteEpicChildren(
  filePath: string,
  epicId: number,
): { deletedChildren: number[]; revision: number } {
  const deletedChildren: number[] = []
  const store = mutateStore(filePath, (s: TicketStore) => {
    for (const idStr of Object.keys(s.tickets)) {
      const t = s.tickets[idStr]
      if (t.parent_epic_id === epicId) {
        deletedChildren.push(t.id)
        delete s.tickets[idStr]
      }
    }
  })
  return { deletedChildren, revision: store.revision }
}

// ─── recordInvocation wrapper ────────────────────────────────────────────────

function recordSafely(
  deps: SmashDeps,
  ticketId: number,
  runId: string,
  startedAt: string,
  finishedAt: string,
  status: 'success' | 'failed' | 'aborted',
  resultEvent: Record<string, unknown> | null,
  model: string | null | undefined,
): void {
  try {
    const normalised = resultEvent ? normaliseResultEvent(resultEvent, 'claude') : {}
    recordInvocation(deps.db, {
      id: randomUUID(),
      project_id: deps.projectId,
      provider: 'claude',
      surface: 'smash',
      surface_ref_id: `smash:${runId}`,
      conversation_id: null,
      ticket_id: ticketId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      ...normalised,
      model: (resultEvent?.model as string | undefined) ?? model ?? undefined,
    })
  } catch (err) {
    console.error('[smash-runner] recordInvocation failed:', err)
  }
}

/**
 * On a successful SMASH, attribute the spawn cost/tokens proportionally to
 * each Sub-Spec so the per-child spending line is populated immediately.
 * Cost / tokens / duration are split evenly across N children; num_turns is
 * floor(turns/N) per row (small loss of precision, acceptable).
 */
function recordChildrenInvocations(
  deps: SmashDeps,
  childrenIds: number[],
  runId: string,
  startedAt: string,
  finishedAt: string,
  resultEvent: Record<string, unknown> | null,
  model: string | null | undefined,
): void {
  if (childrenIds.length === 0 || !resultEvent) return
  try {
    const normalised = normaliseResultEvent(resultEvent, 'claude')
    const n = childrenIds.length
    const split = <T extends number | null | undefined>(v: T): number | undefined => {
      if (v === null || v === undefined) return undefined
      return (v as number) / n
    }
    const splitInt = <T extends number | null | undefined>(v: T): number | undefined => {
      if (v === null || v === undefined) return undefined
      return Math.floor((v as number) / n)
    }
    for (const childId of childrenIds) {
      recordInvocation(deps.db, {
        id: randomUUID(),
        project_id: deps.projectId,
        provider: 'claude',
        surface: 'smash',
        surface_ref_id: `smash:${runId}:child:${childId}`,
        conversation_id: null,
        ticket_id: childId,
        status: 'success',
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: split(normalised.duration_ms),
        duration_api_ms: split(normalised.duration_api_ms),
        tokens_in: splitInt(normalised.tokens_in),
        tokens_out: splitInt(normalised.tokens_out),
        tokens_cache_read: splitInt(normalised.tokens_cache_read),
        tokens_cache_create: splitInt(normalised.tokens_cache_create),
        total_cost_usd: split(normalised.total_cost_usd),
        num_turns: splitInt(normalised.num_turns),
        session_id: normalised.session_id,
        model: (resultEvent.model as string | undefined) ?? model ?? undefined,
      })
    }
  } catch (err) {
    console.error('[smash-runner] recordChildrenInvocations failed:', err)
  }
}

// ─── Public runner ───────────────────────────────────────────────────────────

/**
 * Fire a SMASH attempt for a single ticket.
 */
// B60: in-process guard against concurrent SMASH of the same ticket. Eligibility
// is checked pre-spawn (not under the store lock), so two near-simultaneous
// requests would both pass the gate and each spawn a child set → duplicates.
// Keyed by `${projectId}:${ticketId}` so distinct projects don't collide.
const _smashInFlight = new Set<string>()

export async function runSmash(
  deps: SmashDeps,
  ticketId: number,
): Promise<SmashOutcome> {
  const now = deps.now ?? (() => new Date())
  const mode: SmashMode = deps.mode === 'full' ? 'full' : 'simple'
  const defaultTimeout = mode === 'full' ? SMASH_TIMEOUT_MS_FULL : SMASH_TIMEOUT_MS_SIMPLE
  const timeoutMs = deps.timeoutMs ?? defaultTimeout
  const spawn = deps.spawn ?? spawnAiCli
  const runId = randomUUID()

  console.log(`[smash-runner] entry ticket=${ticketId} run=${runId}`)

  if (isSpecsSmashKillSwitchActive()) {
    return { ok: false, reason: 'disabled', ticketId, runId }
  }

  // B60: reject a concurrent SMASH of the same ticket. The has-check + add are
  // synchronous (no await between them), so they close the TOCTOU window the
  // pre-flight eligibility check leaves open. Released in the finally below.
  const inFlightKey = `${deps.projectId}:${ticketId}`
  if (_smashInFlight.has(inFlightKey)) {
    // BUG-PARSER-02: every other failure branch broadcasts `smash.failed`, but
    // this early-return previously returned silently — leaving the client (which
    // already received a 202 for the duplicate submit) with a stuck spinner.
    // Emit `smash.failed` so the UI can clear its pending state.
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason: 'in-progress',
      timestamp: now().toISOString(),
    })
    return { ok: false, reason: 'in-progress', ticketId, runId }
  }
  _smashInFlight.add(inFlightKey)
  try {

  // Pre-flight: read store and check eligibility.
  const filePath = smashTicketsPath(deps)
  let ticket: Ticket
  try {
    const { readStore } = await import('./ticket-store')
    const store = readStore(filePath)
    const gate = checkSmashEligibility(store, ticketId)
    if (!gate.ok) {
      return { ok: false, reason: gate.reason, ticketId, runId }
    }
    ticket = gate.context.ticket
  } catch (err) {
    console.error('[smash-runner] pre-flight read failed:', err)
    return { ok: false, reason: 'crashed', ticketId, runId }
  }

  // Broadcast start.
  const startedAt = now().toISOString()
  deps.broadcast({
    type: 'smash.started',
    projectId: deps.projectId,
    ticketId,
    runId,
    ticketTitle: ticket.title,
    timestamp: startedAt,
  })

  const { args, cwd, env: spawnEnv } = prepareSmashSpawn(
    {
      projectSlug: deps.projectSlug,
      projectPath: deps.projectPath,
      projectName: deps.projectName,
      model: deps.model,
      mode,
    },
    ticket,
  )

  let child: ChildProcess
  try {
    child = spawn('claude', args, {
      env: spawnEnv ? { ...process.env, ...spawnEnv } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    })
  } catch (err) {
    const finishedAt = now().toISOString()
    recordSafely(deps, ticketId, runId, startedAt, finishedAt, 'failed', null, deps.model)
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason: 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'crashed', ticketId, runId }
  }

  // Synthesize progress pills as the spawn proceeds. The runner uses fixed
  // offsets — cheap and deterministic vs trying to read tool-use events.
  const progressTimers: NodeJS.Timeout[] = []
  const stages: Array<'analyzing' | 'identifying' | 'ordering'> = ['analyzing', 'identifying', 'ordering']
  stages.forEach((stage, i) => {
    progressTimers.push(setTimeout(() => {
      deps.broadcast({
        type: 'smash.progress',
        projectId: deps.projectId,
        ticketId,
        runId,
        stage,
        timestamp: now().toISOString(),
      })
    }, 200 + i * 1500))
  })

  const result = await readSmashChildOutput(child, timeoutMs)
  progressTimers.forEach((t) => clearTimeout(t))
  const finishedAt = now().toISOString()
  console.log(`[smash-runner] spawn done code=${result.code} timedOut=${result.timedOut} hasResult=${!!result.resultEvent} textBytes=${result.fullText.length}`)

  if (result.timedOut) {
    recordSafely(deps, ticketId, runId, startedAt, finishedAt, 'aborted', result.resultEvent, deps.model)
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason: 'timeout',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'timeout', ticketId, runId }
  }
  if (result.code !== 0 || !result.resultEvent) {
    recordSafely(deps, ticketId, runId, startedAt, finishedAt, 'failed', result.resultEvent, deps.model)
    const reason: SmashFailureReason = result.resultEvent ? 'model_error' : 'crashed'
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason,
      timestamp: finishedAt,
    })
    return { ok: false, reason, ticketId, runId }
  }

  const parse = parseSmashOutput(result.fullText)
  if (!parse.ok) {
    console.log(`[smash-runner] parse failed reason=${parse.reason} detail=${parse.detail ?? '-'}`)
    recordSafely(deps, ticketId, runId, startedAt, finishedAt, 'failed', result.resultEvent, deps.model)
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason: 'invalid-output',
      detail: parse.reason as SmashValidationReason,
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'invalid-output', ticketId, runId }
  }

  // Atomic flip + insert.
  let applied: ApplySmashResult
  try {
    applied = applySmashToStore(
      filePath,
      ticketId,
      parse.value.children,
      finishedAt,
      'sr-specs-smash',
    )
  } catch (err) {
    console.error('[smash-runner] mutation failed:', err)
    recordSafely(deps, ticketId, runId, startedAt, finishedAt, 'failed', result.resultEvent, deps.model)
    deps.broadcast({
      type: 'smash.failed',
      projectId: deps.projectId,
      ticketId,
      runId,
      reason: 'mutation-failed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'mutation-failed', ticketId, runId }
  }

  // On a successful SMASH, attribute the spawn cost ONLY to the children
  // (cost split evenly). The Epic itself does not accrue cost here — the
  // operation logically birthed the Sub-Specs and the cost belongs to them.
  // Total project cost remains the original spawn cost (sum of N × X/N = X).
  recordChildrenInvocations(
    deps,
    applied.children.map((c) => c.id),
    runId,
    startedAt,
    finishedAt,
    result.resultEvent,
    deps.model,
  )

  // Broadcast underlying state changes first, then the SMASH-specific event.
  deps.broadcast({
    type: 'ticket_updated',
    ticket: applied.epic,
    projectId: deps.projectId,
    timestamp: finishedAt,
  })
  for (const child of applied.children) {
    deps.broadcast({
      type: 'ticket_created',
      ticket: child,
      projectId: deps.projectId,
      timestamp: finishedAt,
    })
  }
  deps.broadcast({
    type: 'smash.completed',
    projectId: deps.projectId,
    ticketId,
    runId,
    smashedAt: finishedAt,
    childrenIds: applied.children.map((c) => c.id),
    timestamp: finishedAt,
  })
  deps.broadcast({ type: 'spending.invalidated', projectId: deps.projectId })

  return {
    ok: true,
    ticketId,
    runId,
    childrenIds: applied.children.map((c) => c.id),
  }
  } finally {
    // B60: always release the in-flight guard (success, failure, or throw).
    _smashInFlight.delete(inFlightKey)
  }
}

/**
 * Undo a prior SMASH: deletes any child created since `smashedAt` and clears
 * `is_epic` on the parent ticket.
 */
export async function runSmashUndo(
  deps: SmashDeps,
  ticketId: number,
  smashedAt: string,
): Promise<{ ok: boolean; deletedChildren: number[]; reason?: SmashFailureReason }> {
  if (isSpecsSmashKillSwitchActive()) {
    return { ok: false, deletedChildren: [], reason: 'disabled' }
  }
  const now = deps.now ?? (() => new Date())
  const filePath = smashTicketsPath(deps)
  const finishedAt = now().toISOString()
  let undone: ReturnType<typeof applySmashUndo>
  try {
    undone = applySmashUndo(filePath, ticketId, smashedAt, finishedAt)
  } catch (err) {
    console.error('[smash-runner] undo failed:', err)
    return { ok: false, deletedChildren: [], reason: 'mutation-failed' }
  }
  if (!undone.epic) {
    return { ok: false, deletedChildren: [], reason: 'ticket-not-found' }
  }
  for (const id of undone.deletedChildren) {
    deps.broadcast({
      type: 'ticket_deleted',
      ticketId: id,
      projectId: deps.projectId,
      timestamp: finishedAt,
    })
  }
  deps.broadcast({
    type: 'ticket_updated',
    ticket: undone.epic,
    projectId: deps.projectId,
    timestamp: finishedAt,
  })
  deps.broadcast({
    type: 'smash.undone',
    projectId: deps.projectId,
    ticketId,
    childrenIds: undone.deletedChildren,
    timestamp: finishedAt,
  })
  return { ok: true, deletedChildren: undone.deletedChildren }
}
