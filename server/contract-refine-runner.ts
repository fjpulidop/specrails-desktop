/**
 * Contract Refine Runner
 *
 * Standalone runner that spawns a single Claude turn to produce the
 * Contract Layer for a just-committed Explore Spec ticket. Lives outside the
 * ChatManager lifecycle for now (design.md D3 — "thin sibling helper" option):
 * the refine is fire-and-forget with a 60 s budget per invocation and no
 * idle-kill / crash-respawn semantics. Only the exact relocated missing-session
 * diagnostic permits one fresh compatibility retry.
 *
 * See openspec/changes/explore-spec-contract-refine.
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { spawnAiCli } from './util/cli-prompt'
import { runAiCliInvocation } from './spawn-lifecycle'
import { getAdapter, type AdapterEvent, type ProviderAdapter, type SpawnOptions } from './providers'
import { buildProviderEnv } from './providers/runtime'
import {
  buildContractRefineSystemPrompt,
  parseContractLayerBlock,
  appendContractLayerToDescription,
  isExploreContractRefineKillSwitchActive,
  CONTRACT_MARKER_USER_MESSAGE,
  type ContractLayer,
} from './explore-contract-refine'
import {
  getConversation,
  type DbInstance,
} from './db'
import { ensureExploreCwd } from './explore-cwd-manager'
import { recordInvocation } from './ai-invocations'
import { finaliseInvocationResult } from './result-event'
import { mutateStore, readStore, resolveTicketStoragePath, type Ticket, type TicketStore } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
import { captureProcessAdmission } from './process-admission'
import { trackTransientChild } from './transient-children'

const REFINE_TIMEOUT_MS = 60_000
const CLAUDE_MISSING_SESSION_DIAGNOSTIC = 'No conversation found with session ID'

/**
 * Relocate-artifacts: resolve the ticket store path honouring the gate.
 * Relocated ⇒ the registry entry's tickets path (workspace); legacy ⇒
 * `resolveTicketStoragePath(projectPath)` (preserves integration-contract.json
 * custom-storagePath behaviour for existing repos).
 */
function resolveContractTicketsPath(projectPath: string): string {
  const exec = resolveProjectExecution({ path: projectPath })
  return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(projectPath)
}

export type RefineFailureReason =
  | 'disabled'
  | 'scope-disabled'
  | 'not-explore'
  | 'no-session'
  | 'model_error'
  | 'crashed'
  | 'malformed'
  | 'timeout'
  | 'aborted'
  | 'parser_error'
  | 'provider-unsupported'

export interface ContractRefineDeps {
  db: DbInstance
  projectId: string
  projectSlug: string
  projectPath: string
  projectName: string
  /** Provider for Quick/no-conversation refinements. Explore refinements always
   * use the provider persisted on their source conversation. */
  providerId?: string
  // Loose broadcaster type — runner emits ad-hoc `explore.contract_refine_*`
  // events not yet in the WsMessage union; the project-router casts at the
  // call site.
  broadcast: (msg: unknown) => void
  /** Optional spawn injection (tests only). Defaults to spawnAiCli. */
  spawn?: typeof spawnAiCli
  /** Optional now() injection (tests only). */
  now?: () => Date
  /** Override the timeout (tests only). */
  timeoutMs?: number
  /** Retry endpoint already gates on project setting; use this to ignore the
   * original conversation's one-off opt-out. */
  ignoreConversationScope?: boolean
}

export interface ContractRefineOutcome {
  ok: boolean
  reason?: RefineFailureReason
  ticketId: number
  conversationId: string
}

/**
 * BUG-PARSER-04: a result event can carry `is_error: true` (with an exit code
 * of 0) when the turn was truncated — most commonly `subtype: 'error_max_turns'`
 * where the model never got to emit the contract block. Previously this fell
 * through to the parser and surfaced as `malformed` (a misleading reason that
 * implies the model produced bad output, when really the run was cut short).
 * Detect the truncation/error markers and short-circuit to `model_error`.
 */
function isResultErrorEvent(resultEvent: Record<string, unknown> | null): boolean {
  if (!resultEvent) return false
  if (resultEvent.is_error === true) return true
  const subtype = typeof resultEvent.subtype === 'string' ? resultEvent.subtype : ''
  // `error_max_turns` is the canonical truncation subtype; treat any
  // `error_*` subtype as a model-side error rather than malformed output.
  return subtype === 'error_max_turns' || subtype.startsWith('error_')
}

function buildRefineArgs(
  adapter: ProviderAdapter,
  model: string,
  systemPrompt: string,
  sessionId: string,
): { args: string[]; options: SpawnOptions } {
  const action = sessionId && adapter.capabilities.nativeResume ? 'chat-resume' : 'spec-gen'
  // Chat adapters intentionally keep resumed Explore prompts short because the
  // app-managed cwd already carries the normal Explore stance. Contract Refine
  // is different: its schema is invocation-specific and must be present on the
  // resumed turn. Providers without a native system-prompt flag therefore need
  // the schema folded here, exactly once, before their chat-resume builder
  // deliberately ignores `systemPrompt`.
  const foldForResume = action === 'chat-resume' && !adapter.capabilities.systemPromptArg
  const options: SpawnOptions = {
    prompt: foldForResume
      ? `${systemPrompt}\n\n---\n\n${CONTRACT_MARKER_USER_MESSAGE}`
      : CONTRACT_MARKER_USER_MESSAGE,
    model,
    systemPrompt: foldForResume ? undefined : systemPrompt,
    sessionId,
    toolPolicy: 'none',
    maxTurns: 1,
  }
  return { args: adapter.buildArgs(action, options), options }
}

/** Build the pure-output, no-resume invocation used by Quick Refine and by the
 * one-time compatibility recovery for cwd-scoped Explore sessions. */
function buildFreshRefineArgs(
  adapter: ProviderAdapter,
  model: string,
  title: string,
  description: string,
): { args: string[]; options: SpawnOptions } {
  const systemPrompt = [
    buildContractRefineSystemPrompt(),
    '',
    '## Spec under refinement',
    '',
    '### Title',
    title,
    '',
    '### Description',
    description,
  ].join('\n')

  const options: SpawnOptions = {
    prompt: CONTRACT_MARKER_USER_MESSAGE,
    model,
    systemPrompt,
    toolPolicy: 'none',
    maxTurns: 1,
  }
  return { args: adapter.buildArgs('spec-gen', options), options }
}

/** Match only Claude's missing cwd-scoped session diagnostic. The CLI has
 * emitted it both as stderr and inside structured result payloads, so inspect
 * all captured provider output while keeping unrelated failures ineligible. */
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

/**
 * Build the spawn argv + cwd for the refine turn. Exported for tests.
 */
export function prepareContractRefineSpawn(
  deps: Pick<ContractRefineDeps, 'projectSlug' | 'projectPath' | 'projectName' | 'providerId'>,
  conversation: { model: string | null; session_id: string | null; context_scope?: string | null; provider?: string | null },
): { args: string[]; cwd: string; systemPrompt: string; env?: NodeJS.ProcessEnv; options: SpawnOptions; adapter: ProviderAdapter } {
  const systemPrompt = buildContractRefineSystemPrompt()
  let mcpEnabled = false
  if (conversation.context_scope) {
    try {
      const scope = JSON.parse(conversation.context_scope) as { mcp?: boolean }
      mcpEnabled = !!scope?.mcp
    } catch {
      /* default false */
    }
  }
  // The refine `--resume`s the Explore conversation's session, so it MUST spawn
  // from the SAME cwd the Explore turn used — otherwise claude looks in a
  // different per-cwd session store and fails with "No conversation found with
  // session ID …" (the Desktop-tier bug). chat-manager `_resolveSpawnCwd` for an
  // Explore turn uses:
  //   - mcp ON  → the relocate-artifacts gate (workspace when relocated, else
  //     `project.path`); `SPECRAILS_EXPLORE_LEGACY_CWD=1` forces `project.path`,
  //   - mcp OFF → the app-managed explore-cwd.
  // We mirror that EXACTLY here. The refine uses no tools (`--tools __none__`)
  // and its prompt rides on `--system-prompt`, so it needs
  // neither the workspace's `.mcp.json` nor its `.claude/commands`. The env is
  // mirrored too so the legacy-cwd escape hatch remains byte-identical.
  const exec = resolveProjectExecution({ slug: deps.projectSlug, path: deps.projectPath })
  let env: NodeJS.ProcessEnv | undefined
  let cwd: string
  if (mcpEnabled) {
    // Match the Explore mcp-on spawn cwd through the same gate + escape hatch.
    if (process.env.SPECRAILS_EXPLORE_LEGACY_CWD === '1') {
      cwd = deps.projectPath
    } else {
      cwd = exec.cwd
      if (exec.relocated) env = { ...process.env, ...exec.env }
    }
  } else {
    try {
      cwd = ensureExploreCwd({
        slug: deps.projectSlug,
        projectPath: deps.projectPath,
        projectName: deps.projectName,
      })
    } catch {
      // Match ChatManager's fail-closed fallback for an unavailable
      // app-managed Explore cwd.
      cwd = deps.projectPath
    }
  }
  const adapter = getAdapter(conversation.provider ?? deps.providerId ?? 'claude')
  const model = conversation.model ?? adapter.defaultModel()
  const built = buildRefineArgs(adapter, model, systemPrompt, conversation.session_id ?? '')
  return { args: built.args, cwd, systemPrompt, env, options: built.options, adapter }
}

/** Grace before SIGKILL-escalating a child that swallowed SIGTERM. */
const REFINE_SIGKILL_GRACE_MS = 2_000

/**
 * BUG-PARSER-01: tear down the FULL process subtree on timeout, mirroring the
 * shared `spawn-lifecycle.ts` teardown. A bare `child.kill('SIGTERM')` leaves
 * grandchildren (cmd.exe / npx wrappers) orphaned and never force-kills a
 * signal-swallowing CLI. We treeKill SIGTERM, then SIGKILL-escalate after a
 * grace window. The escalation timer is returned so the close handler can clear
 * it. Inlined here (not a shared module) per file-ownership constraints.
 *
 * `kill` is injectable for tests so the timeout path can be asserted without
 * spawning a real `ps`/`taskkill` against a fake pid.
 */
type TreeKiller = (pid: number, signal: string, cb?: (err?: Error) => void) => void

function escalateKill(
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
  }, REFINE_SIGKILL_GRACE_MS)
  // Don't let the escalation timer keep the event loop alive.
  if (typeof escalation.unref === 'function') escalation.unref()
  return escalation
}

/**
 * Test-friendly inner runner: takes a child-like object and returns the parsed
 * outcome (text + result event + close code). Does NOT touch the DB or the
 * file system — the caller wires those.
 */
export function readRefineChildOutput(
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
    const stdout = child.stdout
    let stderrBuf = ''
    const onStderrData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      stderrBuf += s
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
    }
    if (child.stderr) child.stderr.on('data', onStderrData)
    let killEscalation: NodeJS.Timeout | null = null
    const reader = createInterface({ input: stdout, crlfDelay: Infinity })
    let outputClosed = false
    const closeOutputReaders = () => {
      if (outputClosed) return
      outputClosed = true
      reader.removeAllListeners('line')
      try { reader.close() } catch { /* already closed */ }
      if (child.stderr) child.stderr.off('data', onStderrData)
      if (!stdout.destroyed) stdout.destroy()
      if (child.stderr && !child.stderr.destroyed) child.stderr.destroy()
    }
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
      killEscalation = escalateKill(child.pid, kill)
      closeOutputReaders()
      if (!settled) {
        settled = true
        resolve({ fullText, resultEvent, code: null, timedOut: true })
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      // The child exited (possibly because SIGTERM was honoured) — cancel the
      // pending SIGKILL escalation.
      if (killEscalation) { clearTimeout(killEscalation); killEscalation = null }
      closeOutputReaders()
      if (settled) return
      settled = true
      if (code !== 0 && stderrBuf) {
        console.log(`[contract-refine-runner] child stderr: ${JSON.stringify(stderrBuf.slice(-2000))}`)
      }
      resolve({ fullText, resultEvent, code, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      if (killEscalation) { clearTimeout(killEscalation); killEscalation = null }
      closeOutputReaders()
      console.log(`[contract-refine-runner] child error: ${(err as Error).message}; stderr=${JSON.stringify(stderrBuf.slice(-2000))}`)
      if (settled) return
      settled = true
      resolve({ fullText, resultEvent, code: -1, timedOut })
    })
  })
}

/**
 * Patch a ticket's description in place: append the rendered Contract Layer
 * markdown to the user-authored body. Returns the updated Ticket, or null
 * when the ticket id is unknown.
 */
export function applyContractLayerToTicket(
  filePath: string,
  ticketId: number,
  layer: ContractLayer,
  nowIso: string,
): Ticket | null {
  let updated: Ticket | null = null
  mutateStore(filePath, (s: TicketStore) => {
    const t = s.tickets[String(ticketId)]
    if (!t) return
    t.description = appendContractLayerToDescription(t.description, layer)
    t.updated_at = nowIso
    updated = t
  })
  return updated
}

/**
 * Run Contract Refine for the given conversation + ticket (normally one
 * invocation; at most two for the narrow missing-session compatibility path).
 *
 * Returns a Promise that resolves with the outcome. Side effects:
 *  - On success: patches the ticket's description, broadcasts `ticket_updated`
 *    (in the caller-supplied shape via broadcast), records `ai_invocations`.
 *  - On failure: broadcasts `explore.contract_refine_failed`, records
 *    `ai_invocations` with status=failed/aborted.
 *
 * Early-returns with `reason='disabled'` when the per-project toggle is off,
 * the kill switch is active, the conversation is not Explore, or no
 * `session_id` exists yet (no parent turn to --resume).
 */
export async function runContractRefine(
  deps: ContractRefineDeps,
  conversationId: string,
  ticketId: number,
): Promise<ContractRefineOutcome> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? REFINE_TIMEOUT_MS
  const spawn = deps.spawn ?? spawnAiCli

  console.log(`[contract-refine-runner] entry conv=${conversationId} ticket=${ticketId}`)
  if (isExploreContractRefineKillSwitchActive()) {
    console.log(`[contract-refine-runner] skip: kill switch active`)
    return { ok: false, reason: 'disabled', ticketId, conversationId }
  }

  const conversation = getConversation(deps.db, conversationId)
  if (!conversation || conversation.kind !== 'explore') {
    console.log(`[contract-refine-runner] skip: conversation missing or not explore (kind=${conversation?.kind})`)
    return { ok: false, reason: 'not-explore', ticketId, conversationId }
  }

  const adapter = getAdapter(conversation.provider ?? deps.providerId ?? 'claude')
  if (adapter.capabilities.structuredActions !== true) {
    console.log(`[contract-refine-runner] skip: provider '${adapter.id}' does not support structured actions`)
    return { ok: false, reason: 'provider-unsupported', ticketId, conversationId }
  }

  // Per-conversation gating: contractRefine on the conversation's stored
  // context_scope is the only source of truth. Legacy null/missing scope or
  // a malformed JSON blob is treated as opted out.
  if (!deps.ignoreConversationScope) {
    let convoOptIn = false
    if (conversation.context_scope) {
      try {
        const scope = JSON.parse(conversation.context_scope) as { contractRefine?: unknown }
        if (typeof scope?.contractRefine === 'boolean') convoOptIn = scope.contractRefine
      } catch { /* malformed scope; treat as opted out */ }
    }
    if (!convoOptIn) {
      console.log(`[contract-refine-runner] skip: conversation scope opted out (contractRefine!=true)`)
      return { ok: false, reason: 'scope-disabled', ticketId, conversationId }
    }
  }
  if (!conversation.session_id) {
    console.log(`[contract-refine-runner] skip: no session_id on conversation ${conversationId}`)
    return { ok: false, reason: 'no-session', ticketId, conversationId }
  }
  const admission = captureProcessAdmission(deps.projectId)
  console.log(`[contract-refine-runner] spawning refine model=${conversation.model} session=${conversation.session_id}`)
  deps.broadcast({
    type: 'explore.contract_refine_started',
    projectId: deps.projectId,
    provider: adapter.id,
    ticketId,
    timestamp: now().toISOString(),
  })

  const { args, cwd, env: refineEnv, options: refineOptions } = prepareContractRefineSpawn(
    {
      projectSlug: deps.projectSlug,
      projectPath: deps.projectPath,
      projectName: deps.projectName,
      providerId: adapter.id,
    },
    conversation,
  )

  const startedAt = now().toISOString()
  // Spawn/stream/timeout/settlement is owned by the shared spawn-lifecycle; the
  // contract-refine-specific raw parse (fullText from assistant text blocks,
  // the raw result event) and all finalize/record/broadcast logic stay here.
  // Keeping the invocation result in one shape also lets the narrowly-gated
  // missing-session recovery re-enter the exact same finalization path.
  const invoke = async (invocationArgs: string[], invocationOptions: SpawnOptions) => {
    let fullText = ''
    let resultEvent: Record<string, unknown> | null = null
    const run = await runAiCliInvocation({
      adapter,
      binary: adapter.binary,
      argv: invocationArgs,
      cwd,
      env: buildProviderEnv(adapter, invocationOptions, refineEnv ?? process.env),
      spawn,
      timeoutMs,
      onSpawn: (child) => trackTransientChild(deps.projectId, child),
      onEvent: (event) => {
        if (event.kind === 'text-delta') {
          fullText += event.text
        } else if (event.kind === 'result') {
          resultEvent = event.payload
        }
      },
    })
    return {
      fullText,
      resultEvent,
      code: run.code,
      timedOut: run.timedOut,
      spawnFailed: run.spawnFailed,
      stderrTail: run.stderrTail,
      events: run.events,
    }
  }

  let result = await invoke(args, refineOptions)
  if (!admission.isCurrent()) {
    return { ok: false, reason: 'aborted', ticketId, conversationId }
  }

  // A pre-relocation Explore session was created under the repo cwd and cannot
  // be resumed after the corrected mcp=true route moves to the workspace.
  // Recover only that exact provider failure, once, and never by returning to
  // the repo. The fresh turn is explicitly seeded because it has no resumed
  // conversation context.
  const resumedFromRelocatedWorkspace =
    refineEnv?.SPECRAILS_WORKSPACE_DIR === cwd && cwd !== deps.projectPath
  const resumeFailed =
    !result.spawnFailed &&
    !result.timedOut &&
    (result.code !== 0 || !result.resultEvent || isResultErrorEvent(result.resultEvent))
  const missingSessionDiagnostic =
    containsMissingClaudeSessionDiagnostic(result.fullText) ||
    containsMissingClaudeSessionDiagnostic(result.resultEvent) ||
    containsMissingClaudeSessionDiagnostic(result.stderrTail)

  if (adapter.id === 'claude' && resumedFromRelocatedWorkspace && resumeFailed && missingSessionDiagnostic) {
    let ticket: Ticket | null = null
    try {
      ticket = readStore(resolveContractTicketsPath(deps.projectPath)).tickets[String(ticketId)] ?? null
    } catch (err) {
      console.error('[contract-refine-runner] unable to read ticket for missing-session recovery:', err)
    }

    if (ticket) {
      console.warn(`[contract-refine-runner] resume session unavailable; retrying once fresh from workspace ticket=${ticketId}`)
      const fresh = buildFreshRefineArgs(
        adapter,
        conversation.model ?? adapter.defaultModel(),
        ticket.title,
        ticket.description,
      )
      result = await invoke(fresh.args, fresh.options)
      if (!admission.isCurrent()) {
        return { ok: false, reason: 'aborted', ticketId, conversationId }
      }
    }
  }

  const finishedAt = now().toISOString()
  if (result.spawnFailed) {
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'crashed', ticketId, conversationId }
  }
  console.log(`[contract-refine-runner] spawn done code=${result.code} timedOut=${result.timedOut} hasResult=${!!result.resultEvent} textBytes=${result.fullText.length}`)

  if (result.timedOut) {
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'aborted', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'timeout',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'timeout', ticketId, conversationId }
  }
  const providerError = result.events.some((event) => event.kind === 'error')
  if (result.code !== 0 || providerError || !result.fullText.trim()) {
    const r = result.resultEvent as Record<string, unknown> | null
    console.log(
      `[contract-refine-runner] non-zero exit code=${result.code} ` +
      `subtype=${r?.subtype ?? '-'} is_error=${r?.is_error ?? '-'} ` +
      `num_turns=${r?.num_turns ?? '-'} ` +
      `textTail=${JSON.stringify(result.fullText.slice(-400))}`,
    )
    if (r) console.log(`[contract-refine-runner] result event: ${JSON.stringify(r).slice(0, 2000)}`)
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: providerError || result.resultEvent ? 'model_error' : 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: providerError || result.resultEvent ? 'model_error' : 'crashed', ticketId, conversationId }
  }

  // BUG-PARSER-04: exit-0 but the result event flags an error / max-turns
  // truncation — classify as model_error, not malformed.
  if (result.resultEvent && isResultErrorEvent(result.resultEvent)) {
    const r = result.resultEvent as Record<string, unknown>
    console.log(`[contract-refine-runner] result error event subtype=${r.subtype ?? '-'} is_error=${r.is_error ?? '-'}`)
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'model_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'model_error', ticketId, conversationId }
  }

  const parse = parseContractLayerBlock(result.fullText)
  console.log(`[contract-refine-runner] parse ok=${parse.ok} reason=${!parse.ok ? parse.reason : '-'} firstChars=${JSON.stringify(result.fullText.slice(0, 200))}`)
  if (!parse.ok) {
    const reason: RefineFailureReason = parse.reason === 'parser-error'
      ? 'parser_error'
      : 'malformed'
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason,
      timestamp: finishedAt,
    })
    return { ok: false, reason, ticketId, conversationId }
  }

  // Patch the ticket description.
  let updated: Ticket | null = null
  try {
    const filePath = resolveContractTicketsPath(deps.projectPath)
    updated = applyContractLayerToTicket(filePath, ticketId, parse.value, finishedAt)
  } catch (err) {
    console.error('[contract-refine-runner] PATCH failed:', err)
    recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'parser_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'parser_error', ticketId, conversationId }
  }

  recordSafely(deps, adapter, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'success', result.events)

  if (updated) {
    deps.broadcast({
      type: 'ticket_updated',
      ticket: updated,
      projectId: deps.projectId,
      timestamp: finishedAt,
    })
  }
  deps.broadcast({ type: 'spending.invalidated', projectId: deps.projectId })

  return { ok: true, ticketId, conversationId }
}

/**
 * Quick-mode variant: fire a single Contract Refine attempt with no parent
 * Explore conversation (no `--resume`). The runner seeds the model with the
 * just-generated spec body inside the system prompt as one-shot context.
 *
 * Used by `POST /tickets/generate-spec` when `contractRefine: true` is on the
 * request body and the project setting + kill switch permit it.
 */
export async function runContractRefineForQuick(
  deps: ContractRefineDeps,
  ticketId: number,
  generatedTitle: string,
  generatedDescription: string,
  model: string | null = null,
): Promise<ContractRefineOutcome> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? REFINE_TIMEOUT_MS
  const spawn = deps.spawn ?? spawnAiCli

  console.log(`[contract-refine-runner] quick-entry ticket=${ticketId}`)
  if (isExploreContractRefineKillSwitchActive()) {
    console.log(`[contract-refine-runner] quick skip: kill switch active`)
    return { ok: false, reason: 'disabled', ticketId, conversationId: '' }
  }
  const admission = captureProcessAdmission(deps.projectId)
  const adapter = getAdapter(deps.providerId ?? 'claude')
  if (adapter.capabilities.structuredActions !== true) {
    return { ok: false, reason: 'provider-unsupported', ticketId, conversationId: '' }
  }
  const resolvedModel = model ?? adapter.defaultModel()

  const built = buildFreshRefineArgs(
    adapter,
    resolvedModel,
    generatedTitle,
    generatedDescription,
  )

  const startedAt = now().toISOString()
  deps.broadcast({
    type: 'explore.contract_refine_started',
    projectId: deps.projectId,
    provider: adapter.id,
    ticketId,
    timestamp: startedAt,
  })
  // Relocate-artifacts gate: spawn from the workspace + SPECRAILS_REPO_DIR when
  // relocated, else cwd = project.path + process.env (byte-identical legacy).
  const quickExec = resolveProjectExecution({ slug: deps.projectSlug, path: deps.projectPath })
  let fullText = ''
  let resultEvent: Record<string, unknown> | null = null
  const run = await runAiCliInvocation({
    adapter,
    binary: adapter.binary,
    argv: built.args,
    cwd: quickExec.cwd,
    env: buildProviderEnv(
      adapter,
      built.options,
      quickExec.relocated ? { ...process.env, ...quickExec.env } : process.env,
    ),
    spawn,
    timeoutMs,
    onSpawn: (child) => trackTransientChild(deps.projectId, child),
    onEvent: (event) => {
      if (event.kind === 'text-delta') fullText += event.text
      else if (event.kind === 'result') resultEvent = event.payload
    },
  })
  const result = {
    fullText,
    resultEvent,
    code: run.code,
    timedOut: run.timedOut,
    spawnFailed: run.spawnFailed,
    events: run.events,
  }
  if (!admission.isCurrent()) {
    return { ok: false, reason: 'aborted', ticketId, conversationId: '' }
  }
  const finishedAt = now().toISOString()
  console.log(`[contract-refine-runner] quick spawn done code=${result.code} timedOut=${result.timedOut} textBytes=${result.fullText.length}`)

  if (result.spawnFailed) {
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'crashed', ticketId, conversationId: '' }
  }
  if (result.timedOut) {
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'aborted', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'timeout',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'timeout', ticketId, conversationId: '' }
  }
  const providerError = result.events.some((event) => event.kind === 'error')
  if (result.code !== 0 || providerError || !result.fullText.trim()) {
    const r = result.resultEvent as Record<string, unknown> | null
    console.log(
      `[contract-refine-runner] quick non-zero exit code=${result.code} ` +
      `subtype=${r?.subtype ?? '-'} is_error=${r?.is_error ?? '-'} ` +
      `num_turns=${r?.num_turns ?? '-'} ` +
      `textTail=${JSON.stringify(result.fullText.slice(-400))}`,
    )
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: providerError || result.resultEvent ? 'model_error' : 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: providerError || result.resultEvent ? 'model_error' : 'crashed', ticketId, conversationId: '' }
  }

  // BUG-PARSER-04: exit-0 but the result event flags an error / max-turns
  // truncation — classify as model_error, not malformed.
  if (result.resultEvent && isResultErrorEvent(result.resultEvent)) {
    const r = result.resultEvent as Record<string, unknown>
    console.log(`[contract-refine-runner] quick result error event subtype=${r.subtype ?? '-'} is_error=${r.is_error ?? '-'}`)
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'model_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'model_error', ticketId, conversationId: '' }
  }

  const parse = parseContractLayerBlock(result.fullText)
  if (!parse.ok) {
    const reason: RefineFailureReason = parse.reason === 'parser-error' ? 'parser_error' : 'malformed'
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason,
      timestamp: finishedAt,
    })
    return { ok: false, reason, ticketId, conversationId: '' }
  }

  let updated: Ticket | null = null
  try {
    const filePath = resolveContractTicketsPath(deps.projectPath)
    updated = applyContractLayerToTicket(filePath, ticketId, parse.value, finishedAt)
  } catch (err) {
    console.error('[contract-refine-runner] quick PATCH failed:', err)
    recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'failed', result.events)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      provider: adapter.id,
      ticketId,
      reason: 'parser_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'parser_error', ticketId, conversationId: '' }
  }

  recordSafelyQuick(deps, adapter, ticketId, resolvedModel, startedAt, finishedAt, 'success', result.events)

  if (updated) {
    deps.broadcast({
      type: 'ticket_updated',
      ticket: updated,
      projectId: deps.projectId,
      timestamp: finishedAt,
    })
  }
  deps.broadcast({ type: 'spending.invalidated', projectId: deps.projectId })

  return { ok: true, ticketId, conversationId: '' }
}

function recordSafelyQuick(
  deps: ContractRefineDeps,
  adapter: ProviderAdapter,
  ticketId: number,
  model: string | null | undefined,
  startedAt: string,
  finishedAt: string,
  status: 'success' | 'failed' | 'aborted',
  events: readonly AdapterEvent[],
): void {
  try {
    const { result: normalised, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: model ?? adapter.defaultModel(),
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    })
    recordInvocation(deps.db, {
      id: randomUUID(),
      project_id: deps.projectId,
      provider: adapter.id,
      surface: 'quick-spec',
      surface_ref_id: `contract-refine:${ticketId}`,
      conversation_id: null,
      ticket_id: ticketId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      total_cost_usd_estimated: estimated,
      ...normalised,
      model: normalised.model ?? model ?? undefined,
    })
  } catch (err) {
    console.error('[contract-refine-runner] quick recordInvocation failed:', err)
  }
}

function recordSafely(
  deps: ContractRefineDeps,
  adapter: ProviderAdapter,
  conversationId: string,
  ticketId: number,
  model: string | null | undefined,
  startedAt: string,
  finishedAt: string,
  status: 'success' | 'failed' | 'aborted',
  events: readonly AdapterEvent[],
): void {
  try {
    const { result: normalised, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: model ?? adapter.defaultModel(),
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    })
    recordInvocation(deps.db, {
      id: randomUUID(),
      project_id: deps.projectId,
      provider: adapter.id,
      surface: 'explore-spec',
      surface_ref_id: `contract-refine:${conversationId}`,
      conversation_id: conversationId,
      ticket_id: ticketId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      total_cost_usd_estimated: estimated,
      ...normalised,
      model: normalised.model ?? model ?? undefined,
    })
  } catch (err) {
    console.error('[contract-refine-runner] recordInvocation failed:', err)
  }
}
