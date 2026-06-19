/**
 * Contract Refine Runner
 *
 * Standalone runner that spawns a single Claude turn to produce the
 * Contract Layer for a just-committed Explore Spec ticket. Lives outside the
 * ChatManager lifecycle for now (design.md D3 — "thin sibling helper" option):
 * the refine is fire-and-forget, single-attempt, 60 s budget, no idle-kill /
 * crash-respawn semantics.
 *
 * See openspec/changes/explore-spec-contract-refine.
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { ChildProcess } from 'node:child_process'
import { spawnAiCli } from './util/cli-prompt'
import { runAiCliInvocation } from './spawn-lifecycle'
import { getAdapter } from './providers/registry'
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
import { normaliseResultEvent } from './result-event'
import { mutateStore, resolveTicketStoragePath, type Ticket, type TicketStore } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'

const REFINE_TIMEOUT_MS = 60_000

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
  | 'parser_error'
  | 'provider-unsupported'

export interface ContractRefineDeps {
  db: DbInstance
  projectId: string
  projectSlug: string
  projectPath: string
  projectName: string
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

function normalizeClaudeCodeModel(model: string | null | undefined): string {
  if (!model || typeof model !== 'string') return 'sonnet'
  return model
}

function buildRefineArgs(model: string, systemPrompt: string, sessionId: string): string[] {
  return [
    '--model', normalizeClaudeCodeModel(model),
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', systemPrompt,
    '--disallowedTools', 'Read,Grep,Glob,Bash',
    '--resume', sessionId,
    '--max-turns', '1',
    '-p', CONTRACT_MARKER_USER_MESSAGE,
  ]
}

/**
 * Build the spawn argv + cwd for the refine turn. Exported for tests.
 */
export function prepareContractRefineSpawn(
  deps: Pick<ContractRefineDeps, 'projectSlug' | 'projectPath' | 'projectName'>,
  conversation: { model: string | null; session_id: string | null; context_scope?: string | null },
): { args: string[]; cwd: string; systemPrompt: string; env?: NodeJS.ProcessEnv } {
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
  // Relocate-artifacts: when mcp is on, the spawn cwd is the project's spec root,
  // which becomes the workspace when relocated (else project.path). When mcp is
  // off the explore-cwd is used as before. Env carries SPECRAILS_REPO_DIR for the
  // relocated case so source/openspec I/O re-points into the repo.
  const exec = resolveProjectExecution({ slug: deps.projectSlug, path: deps.projectPath })
  let cwd = exec.cwd
  let env: NodeJS.ProcessEnv | undefined = exec.relocated ? { ...process.env, ...exec.env } : undefined
  if (!mcpEnabled) {
    try {
      cwd = ensureExploreCwd({
        slug: deps.projectSlug,
        projectPath: deps.projectPath,
        projectName: deps.projectName,
      })
      // explore-cwd reaches the repo via its own `./project` link; keep the
      // relocation env so SPECRAILS_REPO_DIR is still exported when relocated.
    } catch {
      cwd = exec.cwd
    }
  }
  const args = buildRefineArgs(conversation.model ?? 'sonnet', systemPrompt, conversation.session_id ?? '')
  return { args, cwd, systemPrompt, env }
}

/**
 * Test-friendly inner runner: takes a child-like object and returns the parsed
 * outcome (text + result event + close code). Does NOT touch the DB or the
 * file system — the caller wires those.
 */
export function readRefineChildOutput(
  child: ChildProcess,
  timeoutMs: number,
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
    let stderrBuf = ''
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        stderrBuf += s
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
      })
    }
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
      try { child.kill('SIGTERM') } catch { /* best effort */ }
      if (!settled) {
        settled = true
        resolve({ fullText, resultEvent, code: null, timedOut: true })
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0 && stderrBuf) {
        console.log(`[contract-refine-runner] child stderr: ${JSON.stringify(stderrBuf.slice(-2000))}`)
      }
      resolve({ fullText, resultEvent, code, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
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
 * Fire a single Contract Refine attempt for the given conversation + ticket.
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

  // Contract Layer refinement is a Claude-only capability (it `--resume`s the
  // Explore session and invokes the `/specrails:contract-refine` slash command,
  // neither of which Codex supports). Skip defensively when the conversation
  // ran on a non-claude engine; the Add Spec UI already hides the toggle for
  // those, but a manually-crafted scope must never spawn the wrong CLI.
  if (conversation.provider && conversation.provider !== 'claude') {
    console.log(`[contract-refine-runner] skip: provider '${conversation.provider}' does not support contract refine`)
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
  console.log(`[contract-refine-runner] spawning refine model=${conversation.model} session=${conversation.session_id}`)
  deps.broadcast({
    type: 'explore.contract_refine_started',
    projectId: deps.projectId,
    ticketId,
    timestamp: now().toISOString(),
  })

  const { args, cwd, env: refineEnv } = prepareContractRefineSpawn(
    {
      projectSlug: deps.projectSlug,
      projectPath: deps.projectPath,
      projectName: deps.projectName,
    },
    conversation,
  )

  const startedAt = now().toISOString()
  // Spawn/stream/timeout/settlement is owned by the shared spawn-lifecycle; the
  // contract-refine-specific raw parse (fullText from assistant text blocks,
  // the raw result event) and ALL finalize/record/broadcast logic stay here,
  // byte-for-byte, so behaviour is unchanged (it still records via the legacy
  // recordSafely path).
  let fullText = ''
  let resultEvent: Record<string, unknown> | null = null
  const run = await runAiCliInvocation({
    adapter: getAdapter('claude'),
    binary: 'claude',
    argv: args,
    cwd,
    env: refineEnv ?? process.env,
    spawn,
    timeoutMs,
    onStdoutLine: (line) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { return }
      if (!parsed) return
      const type = parsed.type as string
      if (type === 'result') {
        resultEvent = parsed
      } else if (type === 'assistant') {
        const message = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined
        for (const b of (message?.content ?? [])) {
          if (b.type === 'text' && typeof b.text === 'string') fullText += b.text
        }
      }
    },
  })
  if (run.spawnFailed) {
    recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, now().toISOString(), 'failed', null)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'crashed',
      timestamp: now().toISOString(),
    })
    return { ok: false, reason: 'crashed', ticketId, conversationId }
  }
  const result = { fullText, resultEvent, code: run.code, timedOut: run.timedOut }
  const finishedAt = now().toISOString()
  console.log(`[contract-refine-runner] spawn done code=${result.code} timedOut=${result.timedOut} hasResult=${!!result.resultEvent} textBytes=${result.fullText.length}`)

  if (result.timedOut) {
    recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'aborted', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'timeout',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'timeout', ticketId, conversationId }
  }
  if (result.code !== 0 || !result.resultEvent) {
    const r = result.resultEvent as Record<string, unknown> | null
    console.log(
      `[contract-refine-runner] non-zero exit code=${result.code} ` +
      `subtype=${r?.subtype ?? '-'} is_error=${r?.is_error ?? '-'} ` +
      `num_turns=${r?.num_turns ?? '-'} ` +
      `textTail=${JSON.stringify(result.fullText.slice(-400))}`,
    )
    if (r) console.log(`[contract-refine-runner] result event: ${JSON.stringify(r).slice(0, 2000)}`)
    recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: result.resultEvent ? 'model_error' : 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: result.resultEvent ? 'model_error' : 'crashed', ticketId, conversationId }
  }

  const parse = parseContractLayerBlock(result.fullText)
  console.log(`[contract-refine-runner] parse ok=${parse.ok} reason=${!parse.ok ? parse.reason : '-'} firstChars=${JSON.stringify(result.fullText.slice(0, 200))}`)
  if (!parse.ok) {
    const reason: RefineFailureReason = parse.reason === 'parser-error'
      ? 'parser_error'
      : 'malformed'
    recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
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
    recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'parser_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'parser_error', ticketId, conversationId }
  }

  recordSafely(deps, conversationId, ticketId, conversation.model, startedAt, finishedAt, 'success', result.resultEvent)

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

  const systemPrompt = [
    buildContractRefineSystemPrompt(),
    '',
    '## Spec under refinement',
    '',
    `### Title`,
    generatedTitle,
    '',
    `### Description`,
    generatedDescription,
  ].join('\n')

  const args = [
    '--model', model ?? 'sonnet',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', systemPrompt,
    '--disallowedTools', 'Read,Grep,Glob,Bash',
    '--max-turns', '1',
    '-p', CONTRACT_MARKER_USER_MESSAGE,
  ]

  const startedAt = now().toISOString()
  deps.broadcast({
    type: 'explore.contract_refine_started',
    projectId: deps.projectId,
    ticketId,
    timestamp: startedAt,
  })
  // Relocate-artifacts gate: spawn from the workspace + SPECRAILS_REPO_DIR when
  // relocated, else cwd = project.path + process.env (byte-identical legacy).
  const quickExec = resolveProjectExecution({ slug: deps.projectSlug, path: deps.projectPath })
  let child: ChildProcess
  try {
    child = spawn('claude', args, {
      env: quickExec.relocated ? { ...process.env, ...quickExec.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: quickExec.cwd,
    })
  } catch (err) {
    recordSafelyQuick(deps, ticketId, model, startedAt, now().toISOString(), 'failed', null)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'crashed',
      timestamp: now().toISOString(),
    })
    return { ok: false, reason: 'crashed', ticketId, conversationId: '' }
  }

  const result = await readRefineChildOutput(child, timeoutMs)
  const finishedAt = now().toISOString()
  console.log(`[contract-refine-runner] quick spawn done code=${result.code} timedOut=${result.timedOut} textBytes=${result.fullText.length}`)

  if (result.timedOut) {
    recordSafelyQuick(deps, ticketId, model, startedAt, finishedAt, 'aborted', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'timeout',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'timeout', ticketId, conversationId: '' }
  }
  if (result.code !== 0 || !result.resultEvent) {
    const r = result.resultEvent as Record<string, unknown> | null
    console.log(
      `[contract-refine-runner] quick non-zero exit code=${result.code} ` +
      `subtype=${r?.subtype ?? '-'} is_error=${r?.is_error ?? '-'} ` +
      `num_turns=${r?.num_turns ?? '-'} ` +
      `textTail=${JSON.stringify(result.fullText.slice(-400))}`,
    )
    recordSafelyQuick(deps, ticketId, model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: result.resultEvent ? 'model_error' : 'crashed',
      timestamp: finishedAt,
    })
    return { ok: false, reason: result.resultEvent ? 'model_error' : 'crashed', ticketId, conversationId: '' }
  }

  const parse = parseContractLayerBlock(result.fullText)
  if (!parse.ok) {
    const reason: RefineFailureReason = parse.reason === 'parser-error' ? 'parser_error' : 'malformed'
    recordSafelyQuick(deps, ticketId, model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
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
    recordSafelyQuick(deps, ticketId, model, startedAt, finishedAt, 'failed', result.resultEvent)
    deps.broadcast({
      type: 'explore.contract_refine_failed',
      projectId: deps.projectId,
      ticketId,
      reason: 'parser_error',
      timestamp: finishedAt,
    })
    return { ok: false, reason: 'parser_error', ticketId, conversationId: '' }
  }

  recordSafelyQuick(deps, ticketId, model, startedAt, finishedAt, 'success', result.resultEvent)

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
  ticketId: number,
  model: string | null | undefined,
  startedAt: string,
  finishedAt: string,
  status: 'success' | 'failed' | 'aborted',
  resultEvent: Record<string, unknown> | null,
): void {
  try {
    const normalised = resultEvent ? normaliseResultEvent(resultEvent, 'claude') : {}
    recordInvocation(deps.db, {
      id: randomUUID(),
      project_id: deps.projectId,
      provider: 'claude',
      surface: 'quick-spec',
      surface_ref_id: `contract-refine:${ticketId}`,
      conversation_id: null,
      ticket_id: ticketId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      ...normalised,
      model: (resultEvent?.model as string | undefined) ?? model ?? undefined,
    })
  } catch (err) {
    console.error('[contract-refine-runner] quick recordInvocation failed:', err)
  }
}

function recordSafely(
  deps: ContractRefineDeps,
  conversationId: string,
  ticketId: number,
  model: string | null | undefined,
  startedAt: string,
  finishedAt: string,
  status: 'success' | 'failed' | 'aborted',
  resultEvent: Record<string, unknown> | null,
): void {
  try {
    const normalised = resultEvent ? normaliseResultEvent(resultEvent, 'claude') : {}
    recordInvocation(deps.db, {
      id: randomUUID(),
      project_id: deps.projectId,
      provider: 'claude',
      surface: 'explore-spec',
      surface_ref_id: `contract-refine:${conversationId}`,
      conversation_id: conversationId,
      ticket_id: ticketId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      ...normalised,
      model: (resultEvent?.model as string | undefined) ?? model ?? undefined,
    })
  } catch (err) {
    console.error('[contract-refine-runner] recordInvocation failed:', err)
  }
}
