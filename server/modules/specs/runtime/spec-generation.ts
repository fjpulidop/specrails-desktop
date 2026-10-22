/**
 * Spec generation use case — turns free text (an idea, a derived proposal, a
 * conversation summary) into a structured Specrails spec through one
 * provider `spec-gen` spawn, then persists it as a NEW ticket or REWRITES an
 * existing ticket in place (same id; title, description incl. acceptance
 * criteria, labels, priority and short summary replaced in the same format).
 *
 * `startSpecGeneration` spawns synchronously (so argument/adapter failures
 * surface to the caller before it acknowledges anything) and returns a `done`
 * promise; `generateSpecFromText` is the awaitable form. Transport concerns —
 * HTTP validation, `spec_gen_*` / `ticket_*` WebSocket messages, attachment
 * migration, Jira promotion — stay with the caller through `hooks`.
 *
 * Contract Layer: when `contractRefine` is set, `runContractRefineForQuick`
 * is scheduled on the same provider after the ticket is persisted and the
 * `onPersisted` hook has run, exactly as Quick Add Spec does.
 */
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { DbInstance } from '../../../db'
import { getAdapter } from '../../../providers'
import {
  buildProviderEnv, parseStreamEvents, pureOutputToolPolicy, supportsToolPolicy,
} from '../../../providers/runtime'
import type { AdapterEvent, SpawnOptions } from '../../../providers/types'
import { getProjectRepositories, type RepositoryProject } from '../../../project-repositories'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { spawnAiCli } from '../../../util/cli-prompt'
import { trackTransientChild } from '../../../transient-children'
import { USER_ATTACHMENT_SYSTEM_NOTE } from '../../../attachment-manager'
import { recordInvocation, type Surface } from '../../accounting/runtime/ai-invocations'
import { finaliseInvocationResult } from '../../accounting/runtime/result-event'
import {
  buildScopedSystemPromptPrefix, toolFlagsForScope, type ContextScope,
} from '../../conversations/runtime/context-scope'
import { runContractRefineForQuick } from './contract-refine-runner'
import { hasGeneratedSpecTitle, parseGeneratedSpec, type GeneratedSpec } from './generated-spec-parser'
import { mutateStore, type Ticket } from './ticket-store'

type ToolPolicy = NonNullable<SpawnOptions['toolPolicy']>

/** Wall-clock cap: 'full' scope can legitimately run minutes; --max-turns
 *  bounds turns, not time. */
export const GENERATE_SPEC_TIMEOUT_MS = 8 * 60 * 1000

export type SpecGenerationProject = RepositoryProject & { id: string; slug: string; path: string; name: string }

export interface SpecGenerationDeps {
  db: DbInstance
  project: SpecGenerationProject
  /** Ticket store file (workspace-relocated path when applicable). */
  ticketStorePath: string
  ticketWatcher: { notifyDesktopWrite(revision: number): void }
  /** Loose broadcaster (accounting invalidation + Contract Layer events). */
  broadcast: (msg: unknown) => void
  /** Process admission of the owning project; a stale admission drops output. */
  admission: { isCurrent(): boolean }
}

export interface SpecGenerationAttachments {
  /** Extracted text resources (presence switches the codebase rule). */
  textBlocks: string[]
  imageFlags: string[]
  imagePaths: string[]
}

export interface SpecGenerationHooks {
  onDelta?: (text: string) => void
  /** Runs after the ticket is persisted, before Contract Layer scheduling and
   *  accounting. Return `'abort'` to stop (no refine, no accounting row);
   *  throwing reports `Failed to create ticket` (the write is kept). */
  onPersisted?: (ticket: Ticket, kind: 'created' | 'rewritten') => Promise<'abort' | void> | 'abort' | void
  /** Spawn failure, timeout, empty/failed output or persistence failure. */
  onError?: (error: string) => void
}

export interface GenerateSpecFromTextInput {
  /** Free text the spec is generated from. */
  text: string
  provider: string
  /** Resolved, provider-valid model. */
  model: string
  /** Context Awareness controls (`full` grants read-only codebase tools). */
  scope: ContextScope
  /** Rewrite this ticket in place instead of creating a new one. */
  ticketId?: number
  /** Repository targets (multi-repository projects; prompt + new-ticket scope). */
  repositoryIds?: string[]
  /** Evaluated at persist time for new tickets; throwing fails persistence. */
  resolveRepositoryScope?: () => { repositoryIds?: string[] }
  attachments?: SpecGenerationAttachments
  /** Schedule the Contract Layer (`runContractRefineForQuick`) after persist.
   *  `await: true` (Flow settlement) runs it before the outcome resolves, so
   *  whatever follows (a Jira issue create) sees the complete spec. */
  contractRefine?: { model: string | null; await?: boolean } | null
  /** Correlation id (accounting `surface_ref_id`). Default: random. */
  requestId?: string
  /** Accounting surface. Default `quick-spec`. */
  surface?: Surface
  hooks?: SpecGenerationHooks
}

export type SpecGenerationOutcome =
  | { ok: true; requestId: string; ticket: Ticket; kind: 'created' | 'rewritten'; spec: GeneratedSpec }
  | { ok: false; requestId: string; error: string }

export class SpecGenerationToolPolicyError extends Error {
  readonly code = 'provider_tool_policy_unsupported'
  constructor(readonly provider: string, readonly requiredPolicy: 'read-only' | 'pure-output') {
    super(`Provider ${provider} cannot run spec generation with a ${requiredPolicy} tool policy`)
    this.name = 'SpecGenerationToolPolicyError'
  }
}

/** Tool policy for a spec-gen spawn, or null when the adapter cannot honour it. */
export function resolveSpecGenerationToolPolicy(provider: string, scope: Pick<ContextScope, 'full'>): ToolPolicy | null {
  const adapter = getAdapter(provider)
  return scope.full
    ? (supportsToolPolicy(adapter, 'read-only') ? 'read-only' : null)
    : pureOutputToolPolicy(adapter)
}

export function buildSpecGenerationPrompts(input: {
  project: SpecGenerationProject
  text: string
  scope: ContextScope
  repositoryIds?: string[]
  attachments?: SpecGenerationAttachments
}): { systemPrompt: string; userPrompt: string; hasAttachments: boolean } {
  const { project, scope } = input
  let hasAttachments = false
  let userPrompt = `Generate a spec for the following idea:\n\n${input.text.trim()}`
  if (input.attachments && input.attachments.textBlocks.length > 0) {
    hasAttachments = true
    userPrompt = `${userPrompt}\n\n## Attached Resources\n\n${input.attachments.textBlocks.join('\n\n')}`
  }
  // Relocate-artifacts: tickets read from the workspace when relocated.
  const specRoot = (() => {
    const e = resolveProjectExecution({ slug: project.slug, path: project.path })
    return e.relocated && e.workspaceDir ? e.workspaceDir : project.path
  })()
  const specsPrefix = buildScopedSystemPromptPrefix(scope, project.path, specRoot)

  const codebaseRule = scope.full
    ? `- You MAY use Read, Grep, and Glob to inspect the project codebase. Bash is not available.`
    : hasAttachments
      ? `- Do NOT explore the project codebase. The resources inside <user-attachment> blocks below are pre-loaded context the user intentionally provided — read and use them freely.`
      : `- Do NOT read any files or explore the codebase. Work purely from the user's description.`

  // The specrails-tickets prefix (scope.specrails) dumps every ticket into the
  // prompt as informational context; without an explicit dedup instruction the
  // model still proposes near-duplicates. Gated on the toggle.
  const dedupRule = scope.specrails
    ? `- The "Specrails Tickets" section above lists every ticket already in the backlog. Do NOT propose a duplicate or a near-duplicate of any of them. If the user's idea is already covered by an existing ticket, say so in "Problem Statement" and pick a *different* angle / sub-feature / next step that builds on the existing one — do not repeat it.\n`
    : ''

  const backlogRecommendationRule = scope.specrails
    ? `- If the user's idea asks for the "next best spec" or a backlog recommendation, use the existing tickets and OpenSpec context to choose one concrete next spec. Do not respond with generic product directions.\n`
    : ''

  let systemPrompt =
    `You are a senior product engineer generating a structured spec proposal.\n\n` +
    (specsPrefix ? `${specsPrefix}\n\n` : '') +
    `RULES:\n` +
    `${codebaseRule}\n` +
    dedupRule +
    backlogRecommendationRule +
    `- Do NOT create files, tickets, or issues.\n` +
    `- Output ONLY the structured markdown below. No preamble, no explanation.\n\n` +
    `REQUIRED FORMAT:\n` +
    `## Spec Title\n[Concise, action-oriented title]\n\n` +
    `## Labels\n[2-4 short kebab-case tags categorising the spec — comma-separated on one line, e.g. "ui, settings, dark-mode". Lowercase, no spaces inside a tag.]\n\n` +
    `## Problem Statement\n[2-3 sentences]\n\n` +
    `## Proposed Solution\n[3-5 sentences]\n\n` +
    `## Out of Scope\n[Bullet list]\n\n` +
    `## Acceptance Criteria\n[Numbered list of testable outcomes]\n\n` +
    `## Technical Considerations\n[Bullet list]\n\n` +
    `## Estimated Complexity\n[Low/Medium/High/Very High + one sentence justification]\n\n` +
    `## Short Summary\n[One or two plain-language sentences, max 120 characters total, that capture the essence of this spec for a dashboard postit. No markdown, no bullets, no headings.]`

  if (hasAttachments) systemPrompt = `${systemPrompt}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`

  const repositories = getProjectRepositories(project)
  if (repositories.length > 1) {
    systemPrompt += `\n\nThis logical project has one shared backlog across these repositories: ${JSON.stringify(repositories.map(({ id, name, path, isPrimary, kind }) => ({ id, name, path, isPrimary, kind })))}.\nThis spec targets repository IDs: ${JSON.stringify(input.repositoryIds ?? [repositories.find((repo) => repo.isPrimary)!.id])}. Describe cross-repository contracts when selected; do not create separate tickets per repository.`
  }
  return { systemPrompt, userPrompt, hasAttachments }
}

/**
 * Persist a generated spec: create a new `propose-spec` ticket, or rewrite
 * `ticketId` in place keeping its id, status, metadata, comments, ownership
 * and attachments. Returns null when the ticket to rewrite does not exist.
 */
export function persistGeneratedSpec(
  deps: Pick<SpecGenerationDeps, 'ticketStorePath' | 'ticketWatcher'>,
  spec: GeneratedSpec,
  target: { ticketId?: number; repositoryScope?: { repositoryIds?: string[] } },
): { ticket: Ticket; kind: 'created' | 'rewritten' } | null {
  const now = new Date().toISOString()
  let persisted: Ticket | undefined
  let kind: 'created' | 'rewritten' = 'created'
  const store = mutateStore(deps.ticketStorePath, (s) => {
    if (target.ticketId !== undefined) {
      const existing = s.tickets[String(target.ticketId)]
      if (!existing) return
      const rewritten: Ticket = {
        ...existing,
        title: spec.title,
        description: spec.description,
        priority: spec.priority,
        labels: spec.labels,
        short_summary: spec.shortSummary,
        updated_at: now,
      }
      s.tickets[String(target.ticketId)] = rewritten
      persisted = rewritten
      kind = 'rewritten'
      return
    }
    const id = s.next_id++
    const ticket: Ticket = {
      ...(target.repositoryScope ?? {}),
      id,
      title: spec.title,
      description: spec.description,
      status: 'todo',
      priority: spec.priority,
      labels: spec.labels,
      assignee: null,
      prerequisites: [],
      metadata: {},
      comments: [],
      origin_conversation_id: null,
      is_epic: false,
      parent_epic_id: null,
      execution_order: null,
      short_summary: spec.shortSummary,
      created_at: now,
      updated_at: now,
      created_by: 'sr-product-engineer',
      source: 'propose-spec',
    }
    s.tickets[String(id)] = ticket
    persisted = ticket
  })
  if (!persisted) return null
  deps.ticketWatcher.notifyDesktopWrite(store.revision)
  return { ticket: persisted, kind }
}

/**
 * Spawn the provider `spec-gen` run. Synchronous up to the spawn: a throw here
 * means nothing was started. `done` always resolves (never rejects).
 */
export function startSpecGeneration(
  deps: SpecGenerationDeps,
  input: GenerateSpecFromTextInput,
): { requestId: string; done: Promise<SpecGenerationOutcome> } {
  const { project, admission } = deps
  const projectId = project.id
  const provider = input.provider
  const requestId = input.requestId ?? randomUUID()
  const hooks = input.hooks ?? {}
  const scope = input.scope
  const adapter = getAdapter(provider)
  const toolPolicy = resolveSpecGenerationToolPolicy(provider, scope)
  if (!toolPolicy) throw new SpecGenerationToolPolicyError(provider, scope.full ? 'read-only' : 'pure-output')

  const { systemPrompt, userPrompt, hasAttachments } = buildSpecGenerationPrompts({
    project, text: input.text, scope, repositoryIds: input.repositoryIds, attachments: input.attachments,
  })
  const imageFlags = input.attachments?.imageFlags ?? []
  const imagePaths = input.attachments?.imagePaths ?? []

  // Spawn args are adapter-driven. For Claude the `--tools` flag set comes from
  // `toolFlagsForScope(scope)` which the adapter doesn't model — pass them
  // through `extraArgs` after COMMON_FLAGS, with `imageFlags` (Claude-only).
  const toolFlags = provider === 'claude' ? toolFlagsForScope(scope) : { args: [] }
  // Full scope grants Read/Grep/Glob; 15 turns leaves headroom for exploring
  // before writing while --max-turns still bounds runaway loops.
  const claudeMaxTurns = scope.full ? 15 : (hasAttachments ? 3 : 1)
  const specGenOptions: SpawnOptions = {
    prompt: userPrompt,
    systemPrompt,
    model: input.model,
    toolPolicy,
    maxTurns: provider === 'claude' ? claudeMaxTurns : undefined,
    extraArgs: provider === 'claude' ? [...toolFlags.args, ...imageFlags] : undefined,
    // "My approved MCPs" (scope.userMcp) loads the developer's user-scope,
    // plugin and connector MCP servers (claude-only). Project `.mcp.json` is
    // discovered natively from the spawn cwd.
    loadUserEnv: adapter.capabilities.userMcp === true && scope.userMcp,
    imagePaths: adapter.capabilities.supportsImageInput ? imagePaths : undefined,
  }
  const args = adapter.buildArgs('spec-gen', specGenOptions)
  const binary = adapter.binary

  // Relocate-artifacts gate: spawn from the workspace + SPECRAILS_REPO_DIR when
  // relocated, else cwd = project.path + process.env (byte-identical legacy).
  const specGenExec = resolveProjectExecution({ slug: project.slug, path: project.path })
  let specGenEnv: NodeJS.ProcessEnv = process.env
  if (specGenExec.relocated) {
    specGenEnv = { ...process.env, ...specGenExec.env }
    if (adapter.id === 'gemini') specGenEnv = { ...specGenEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  }
  // spawnAiCli reroutes multi-line argv values through stdin on Windows.
  console.log(`[project-router] spec-gen spawn: ${binary} (cwd=${specGenExec.cwd}, requestId=${requestId})`)
  const child = spawnAiCli(binary, args, {
    env: buildProviderEnv(adapter, specGenOptions, specGenEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: specGenExec.cwd,
  })
  // Register so removeProject()/shutdown() can tree-kill this otherwise
  // untracked child (auto-unregisters on close/error).
  trackTransientChild(projectId, child)

  let resolveDone!: (outcome: SpecGenerationOutcome) => void
  const done = new Promise<SpecGenerationOutcome>((resolve) => { resolveDone = resolve })
  let failure: string | null = null
  const fail = (error: string): void => {
    failure = error
    hooks.onError?.(error)
  }

  // Watchdog: a hung CLI would otherwise leak this child + its readline.
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    watchdog = null
    if (child.pid) {
      try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
    }
    if (!admission.isCurrent()) return
    fail(`Spec generation timed out after ${Math.round(GENERATE_SPEC_TIMEOUT_MS / 1000)}s`)
  }, GENERATE_SPEC_TIMEOUT_MS)
  if (typeof watchdog.unref === 'function') watchdog.unref()
  const clearWatchdog = (): void => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null }
  }

  let stderrBuf = ''
  /* c8 ignore start -- diagnostic-only; fires only when the CLI writes stderr */
  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString()
    stderrBuf += s
    console.error(`[project-router] spec-gen stderr (${requestId}): ${s.trimEnd()}`)
  })
  /* c8 ignore stop */

  // Without this listener, ENOENT propagates as an unhandled 'error' event and
  // crashes the app process.
  /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
  child.on('error', (err) => {
    clearWatchdog()
    console.error(`[project-router] spec-gen spawn failed (${binary}): ${err.message}`)
    if (!admission.isCurrent()) return
    fail(`Failed to launch ${binary}: ${err.message}`)
    resolveDone({ ok: false, requestId, error: failure! })
  })
  /* c8 ignore stop */

  let buffer = ''
  let lastResultEvent: Record<string, unknown> | null = null
  // Canonical adapter events feed finaliseInvocationResult on close.
  const adapterEvents: AdapterEvent[] = []
  const turnStartedAt = new Date().toISOString()
  const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  stdoutReader.on('line', (line) => {
    if (!admission.isCurrent()) return
    const eventsForLine = parseStreamEvents(adapter, line)
    adapterEvents.push(...eventsForLine)
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(line) } catch { /* skip */ }
    if (parsed && eventsForLine.some((event) => event.kind === 'result')) {
      lastResultEvent = parsed
    }
    for (const event of eventsForLine) {
      if (event.kind !== 'text-delta' || !event.text) continue
      buffer += event.text
      hooks.onDelta?.(event.text)
    }
  })

  child.on('close', async (code) => {
    clearWatchdog()
    if (!admission.isCurrent()) {
      resolveDone({ ok: false, requestId, error: 'Project is being removed' })
      return
    }
    let persistedTicketId: number | null = null
    let outcome: SpecGenerationOutcome | null = null

    // A claude run that burns --max-turns exits non-zero with subtype
    // error_max_turns but may already have emitted a complete spec: salvage it.
    const resultSubtype = (lastResultEvent?.subtype as string | undefined) ?? null
    const hasUsableSpec = buffer.trim().length > 0 && hasGeneratedSpecTitle(buffer)
    const salvageMaxTurns = code !== 0 && resultSubtype === 'error_max_turns' && hasUsableSpec

    if ((code === 0 && buffer.trim()) || salvageMaxTurns) {
      if (salvageMaxTurns) {
        console.warn(
          `[project-router] spec-gen salvaged partial output after error_max_turns (${requestId}); ` +
            `consider raising --max-turns if this recurs`,
        )
      }
      const spec = parseGeneratedSpec(buffer, input.text.trim().slice(0, 80))
      try {
        const repositoryScope = input.ticketId === undefined ? input.resolveRepositoryScope?.() : undefined
        const persisted = persistGeneratedSpec(deps, spec, { ticketId: input.ticketId, repositoryScope })
        if (!persisted) throw new Error(`Ticket ${input.ticketId} not found`)
        persistedTicketId = persisted.ticket.id
        const next = await hooks.onPersisted?.(persisted.ticket, persisted.kind)
        if (next === 'abort') {
          resolveDone({ ok: true, requestId, ticket: persisted.ticket, kind: persisted.kind, spec })
          return
        }
        outcome = { ok: true, requestId, ticket: persisted.ticket, kind: persisted.kind, spec }

        // Contract Layer runs on the same selected provider.
        if (input.contractRefine) {
          const refineTicketId = persisted.ticket.id
          const refineTitle = persisted.ticket.title
          const refineDescription = persisted.ticket.description
          const refineModel = input.contractRefine.model
          if (input.contractRefine.await) {
            if (admission.isCurrent()) await scheduleContractLayer(deps, provider, refineTicketId, refineTitle, refineDescription, refineModel)
          } else process.nextTick(() => {
            if (!admission.isCurrent()) return
            void scheduleContractLayer(deps, provider, refineTicketId, refineTitle, refineDescription, refineModel)
          })
        }
      } catch (err) {
        console.error('[project-router] generate-spec ticket creation error:', err)
        fail(input.ticketId === undefined ? 'Failed to create ticket' : 'Failed to rewrite ticket')
      }
    } else {
      const reason = code === 0
        ? 'Empty response from AI'
        : resultSubtype === 'error_max_turns'
          ? 'AI hit its turn limit before finishing the spec. Try again, or narrow the idea / turn off full-codebase context.'
          : `Process exited with code ${code}`
      console.error(
        `[project-router] spec-gen failed (${requestId}): ${reason}` +
          (stderrBuf.trim() ? `\n  stderr: ${stderrBuf.trim()}` : '') +
          (buffer.trim() ? `\n  stdout-buffer: ${buffer.trim().slice(0, 500)}` : ''),
      )
      fail(reason)
    }

    // ai_invocations capture. Always emit a row, success or fail.
    try {
      // Adapter-driven finalisation: claude passes its native total_cost_usd
      // through; codex (nativeCostUsd:false) gets a pricing-table estimate.
      const { result: normalised, estimated } = finaliseInvocationResult(
        adapter,
        adapterEvents,
        { fallbackModel: input.model },
      )
      const wallMs = Date.now() - new Date(turnStartedAt).getTime()
      recordInvocation(deps.db, {
        id: randomUUID(),
        project_id: projectId,
        provider: adapter.id,
        surface: input.surface ?? 'quick-spec',
        surface_ref_id: requestId,
        ticket_id: persistedTicketId,
        // A delivered ticket (clean or error_max_turns salvage) is 'success'.
        status: persistedTicketId !== null ? 'success' : 'failed',
        started_at: turnStartedAt,
        finished_at: new Date().toISOString(),
        total_cost_usd_estimated: estimated,
        ...normalised,
        duration_ms: normalised.duration_ms ?? wallMs,
      })
      deps.broadcast({ type: 'spending.invalidated', projectId })
    } catch (err) {
      console.error('[project-router] generate-spec recordInvocation failed:', err)
    }
    resolveDone(outcome ?? { ok: false, requestId, error: failure ?? 'Spec generation failed' })
  })

  return { requestId, done }
}

function scheduleContractLayer(
  deps: SpecGenerationDeps,
  provider: string,
  ticketId: number,
  title: string,
  description: string,
  model: string | null,
): Promise<unknown> {
  return runContractRefineForQuick(
    {
      db: deps.db,
      projectId: deps.project.id,
      projectSlug: deps.project.slug,
      projectPath: deps.project.path,
      projectName: deps.project.name,
      providerId: provider,
      broadcast: deps.broadcast,
    },
    ticketId,
    title,
    description,
    model,
  ).catch((err: unknown) => {
    console.error('[project-router] runContractRefineForQuick error:', err)
  })
}

/** Awaitable spec generation: create a new spec ticket, or rewrite `ticketId`
 *  in place. Throws only when the spawn cannot start. */
export function generateSpecFromText(
  deps: SpecGenerationDeps,
  input: GenerateSpecFromTextInput,
): Promise<SpecGenerationOutcome> {
  return startSpecGeneration(deps, input).done
}
