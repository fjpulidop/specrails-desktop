// Domain routes extracted from project-router.ts (tickets).
// Registered on the shared router by createProjectRouter — behaviour-preserving.
import fs from 'fs'
import path from 'path'
import { Router, Request, Response, NextFunction } from 'express'
import { newId as uuidv4 } from './ids'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import {
  listJobs, getJob, getJobEvents, purgeJobs, deleteJob, getProjectActivity,
  createConversation, listConversations, getConversation,
  deleteConversation, updateConversation, getMessages,
  getStats, getPipelineJobs,
  createProposal, getProposal, listProposals, deleteProposal,
  createTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate,
  getProjectSettings, updateProjectSettings,
  getQuickContractRefineLast, setQuickContractRefineLast, hasQuickContractRefineLast,
  getTelemetryBlob, getTelemetrySummaries, getJobsWithTelemetry, hasJobTelemetry,
} from './db'
import { createDiagnosticZip } from './telemetry-export'
import { getProjectSetupSession } from './desktop-db'
import { ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError, DEFAULT_ZOMBIE_TIMEOUT_MS } from './queue-manager'
import type { JobPriority } from './types'
import { VALID_PRIORITIES } from './types'
import { resolveCommand } from './command-resolver'
import { getAdapter } from './providers'
import { createHooksRouter, getPhaseStates } from './hooks'
import { getConfig, fetchIssues } from './config'
import { runContractRefine, runContractRefineForQuick } from './contract-refine-runner'
import { isExploreContractRefineKillSwitchActive } from './explore-contract-refine'
import { runSmash, runSmashUndo, applyDeleteEpicChildren, checkSmashEligibility } from './smash-runner'
import { isSpecsSmashKillSwitchActive } from './explore-smash'
import { recordInvocation, updateTicketIdForConversation, getTicketSpendingSummary } from './ai-invocations'
import { getContextBudget } from './context-budget'
import {
  getLastContextScope, setLastContextScope, normalizeContextScope,
  setConversationContextScope, getConversationContextScope,
  buildScopedSystemPromptPrefix, toolFlagsForScope, defaultBootScope,
  type ContextScope,
} from './context-scope'
import { finaliseInvocationResult } from './result-event'
import { CORE_PACKAGE_SPEC } from './core-package'
import type { AdapterEvent } from './providers/types'
import { getSpending, getInvocations, parseSpendingFilters } from './spending'
import { randomUUID } from 'crypto'
import {
  getModelsForProvider,
  getProviderDefault,
  isValidModelForProvider,
  type SpecProvider,
} from './spec-models'
import { resolveProvider, validateRequestedProvider, isMultiProvider } from './provider-selection'
import type { ChatConversationRow, JobTemplate, JobRow } from './types'
import { readChanges } from './changes-reader'
import { getProjectMetrics } from './metrics'
import {
  resolveTicketStoragePath, readStore, mutateStore, filterTickets,
  isValidStatus, isValidPriority, validatePriorityForStatus,
  resolveTicketsFromCommand,
  clampShortSummary,
  type Ticket,
} from './ticket-store'
import { generateAutoTitle } from './explore-draft-title'
import type { TicketCreatedMessage, TicketUpdatedMessage, TicketDeletedMessage, TicketAiEditStreamMessage, TicketAiEditDoneMessage, TicketAiEditErrorMessage, SpecGenStreamMessage, SpecGenDoneMessage, SpecGenErrorMessage, LocalTicket } from './types'
import { spawnAiCli } from './util/cli-prompt'
import { trackTransientChild } from './transient-children'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import { resolveProjectExecution } from './workspace-resolution'
import multer from 'multer'
import { createRailsRouter } from './rails-router'
import { createProfilesRouter } from './profiles-router'
import { createPluginsRouter } from './plugins-router'
import { createCodeExplorerRouter } from './code-explorer-router'
import {
  getDesktopTerminalSettings,
  getProjectOverride,
  patchProjectOverride,
  resolveTerminalSettings,
  TerminalSettingsValidationError,
} from './terminal-settings'
import { listMarks } from './terminal-marks-store'
import { attachmentManager, isSupportedUploadedFile, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { isBrowserCaptureEnabled } from './feature-flags'
import { BrowserLimitExceededError, BrowserLaunchError } from './browser-capture-types'
import type { CaptureRect } from './browser-capture-types'
import {
  getTerminalManager,
  TerminalLimitExceededError,
  TerminalNotFoundError,
  TerminalNameInvalidError,
  TerminalSpawnError,
  TERMINAL_MAX_PER_PROJECT,
} from './terminal-manager'
import {
  type ProjectRoutesDeps,
  type ModelAlias,
  TERMINAL_PANEL_ENABLED,
  VALID_MODEL_ALIASES,
  readAgentModels,
  applyModelConfig,
  serializeInstallConfigYaml,
  stripSpecMetadataSections,
  extractShortSummary,
  deriveFallbackShortSummary,
  lightlyStructurePrompt,
  formatDescriptionWithCriteria,
  resolveDefaultSpecModel,
} from './project-router-helpers'

/**
 * Add Spec on a Jira-backed project: promote the freshly-created LOCAL ticket to
 * a Jira issue (best-effort, server-side). The per-spec `createLocal` escape
 * hatch keeps it local. On any failure the ticket simply stays local and a
 * non-fatal warning is broadcast — a spec is never lost to a Jira error.
 */
async function maybePromoteSpecToJira(
  c: ProjectContext,
  ticketId: number,
  createLocal: boolean,
  broadcast: (m: unknown) => void,
): Promise<void> {
  // jiraSyncManager is always present in production (constructed per project);
  // guard defensively so partial test contexts and a disabled feature are no-ops.
  if (createLocal || !c.jiraSyncManager?.isActive()) return
  try {
    const r = await c.jiraSyncManager.promoteTicketToJira(ticketId)
    if (!r.ok) {
      broadcast({ type: 'jira.sync_error', projectId: c.project.id, reason: `Kept as a local spec — couldn't create it in Jira: ${r.error}` })
    }
  } catch (err) {
    console.error('[project-router] jira promote failed:', err)
  }
}

export function registerTicketsRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
  // ─── Tickets ──────────────────────────────────────────────────────────────────

  /** Resolve the ticket storage file path for a project */

  // GET /:projectId/tickets — List all tickets with optional filters
  router.get('/:projectId/tickets', (req: Request, res: Response) => {
    try {
      const filePath = ticketPath(req)
      const store = readStore(filePath)
      const allTickets = Object.values(store.tickets)
      const filtered = filterTickets(allTickets, {
        status: req.query.status as string | undefined,
        label: req.query.label as string | undefined,
        q: req.query.q as string | undefined,
      })
      // Sort by updated_at descending
      filtered.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      res.json({ tickets: filtered, revision: store.revision, total: allTickets.length })
    } catch (err) {
      console.error('[project-router] ticket list error:', err)
      res.status(500).json({ error: 'Failed to read tickets' })
    }
  })

  // GET /:projectId/tickets/:id — Get single ticket
  router.get('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = req.params.id as string
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'Invalid ticket ID' }); return
    }
    try {
      const store = readStore(ticketPath(req))
      const ticket = store.tickets[ticketId]
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      res.json({ ticket, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket get error:', err)
      res.status(500).json({ error: 'Failed to read ticket' })
    }
  })

  // POST /:projectId/tickets/generate-spec — Fast AI spec generation (no codebase exploration)
  router.post('/:projectId/tickets/generate-spec', async (req: Request, res: Response) => {
    const idea = req.body?.idea as string | undefined
    if (!idea?.trim()) {
      res.status(400).json({ error: 'idea is required' }); return
    }
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? (req.body.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const pendingSpecId = typeof req.body?.pendingSpecId === 'string' ? (req.body.pendingSpecId as string) : null
    if (attachmentIds.length > 0 && !pendingSpecId) {
      res.status(400).json({ error: 'pendingSpecId is required when attachmentIds are provided' }); return
    }

    const { project, broadcast, ticketWatcher } = ctx(req)
    // Multi-provider: optional aiEngine (alias provider) picks the engine for
    // this Quick spec; must be installed on the project. Omitting it uses the
    // primary provider.
    const requestedEngine = req.body?.aiEngine ?? req.body?.provider
    const engineCheck = validateRequestedProvider(project, requestedEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error }); return
    }
    const provider: SpecProvider = engineCheck.provider as SpecProvider

    // Resolve and validate the model. Order:
    //   - Body had a `model` and it's valid → use it.
    //   - Body had a `model` and it's invalid → 400 with the allow-list.
    //   - Body had no `model` → fall back to project default.
    const rawModel = req.body?.model
    let resolvedModel: string
    if (rawModel === undefined || rawModel === null || rawModel === '') {
      resolvedModel = resolveDefaultSpecModel({ projectPath: project.path, slug: project.slug, provider })
    } else if (isValidModelForProvider(rawModel, provider)) {
      resolvedModel = rawModel
    } else {
      res.status(400).json({
        error: `Invalid model "${String(rawModel)}" for provider "${provider}"`,
        allowed: getModelsForProvider(provider).map((m) => m.value),
      })
      return
    }

    const requestId = uuidv4()
    const projectId = project.id
    const filePath = ticketPath(req)

    let hasAttachments = false
    let baseUserPrompt = `Generate a spec for the following idea:\n\n${idea.trim()}`
    let imageFlags: string[] = []
    if (attachmentIds.length > 0 && pendingSpecId) {
      try {
        const extracted = await attachmentManager.getClaudeArgs(project.slug, pendingSpecId, attachmentIds)
        imageFlags = extracted.imageFlags
        if (extracted.textBlocks.length > 0) {
          hasAttachments = true
          baseUserPrompt = `${baseUserPrompt}\n\n## Attached Resources\n\n${extracted.textBlocks.join('\n\n')}`
        }
      } catch (err) {
        console.error('[project-router] generate-spec attachment extraction error:', err)
      }
    }

    // Parse contextScope from body. Quick and Explore share the same Context
    // Awareness controls; Quick still keeps Contract Refine as a top-level
    // field for the refine scheduler.
    const rawScope = req.body?.contextScope
    // Contract Layer is Claude-only — force it off for any non-claude engine
    // (defence-in-depth; the Quick UI hides the toggle for those).
    const quickContractRefine = provider !== 'claude'
      ? false
      : typeof req.body?.contractRefine === 'boolean'
      ? req.body.contractRefine
      : typeof rawScope?.contractRefine === 'boolean'
        ? rawScope.contractRefine
      : false
    const quickScope: ContextScope = {
      specrails: typeof rawScope?.specrails === 'boolean' ? rawScope.specrails : false,
      openspec: typeof rawScope?.openspec === 'boolean' ? rawScope.openspec : false,
      full: typeof rawScope?.full === 'boolean' ? rawScope.full : false,
      // Quick spawns from project.path, so project `.mcp.json` (the `mcp`
      // toggle) is discovered natively. `userMcp` additionally loads the
      // developer's user-scope/plugin/connector MCP servers via the claude
      // adapter's `loadUserEnv` (see below).
      mcp: typeof rawScope?.mcp === 'boolean' ? rawScope.mcp : false,
      contractRefine: quickContractRefine,
      userMcp: typeof rawScope?.userMcp === 'boolean' ? rawScope.userMcp : false,
    }
    // Persist Quick mode Contract Refine choice (per-project last value).
    setQuickContractRefineLast(ctx(req).db, quickContractRefine)

    // Relocate-artifacts: tickets read from the workspace when relocated.
    const quickSpecRoot = (() => {
      const e = resolveProjectExecution({ slug: project.slug, path: project.path })
      return e.relocated && e.workspaceDir ? e.workspaceDir : project.path
    })()
    const specsPrefix = buildScopedSystemPromptPrefix(quickScope, project.path, quickSpecRoot)

    const codebaseRule = quickScope.full
      ? `- You MAY use Read, Grep, and Glob to inspect the project codebase. Bash is not available.`
      : hasAttachments
        ? `- Do NOT explore the project codebase. The resources inside <user-attachment> blocks below are pre-loaded context the user intentionally provided — read and use them freely.`
        : `- Do NOT read any files or explore the codebase. Work purely from the user's description.`

    // The specrails-tickets prefix (when scope.specrails is toggled on)
    // dumps every ticket into the prompt as informational context. Without
    // an explicit dedup instruction the model treats it as background and
    // still proposes a near-duplicate of something already in the backlog.
    // Adding the rule here, gated on `quickScope.specrails`, keeps the
    // "toggle is the only gate" contract the user asked for.
    const dedupRule = quickScope.specrails
      ? `- The "Specrails Tickets" section above lists every ticket already in the backlog. Do NOT propose a duplicate or a near-duplicate of any of them. If the user's idea is already covered by an existing ticket, say so in "Problem Statement" and pick a *different* angle / sub-feature / next step that builds on the existing one — do not repeat it.\n`
      : ''

    const backlogRecommendationRule = quickScope.specrails
      ? `- If the user's idea asks for the "next best spec" or a backlog recommendation, use the existing tickets and OpenSpec context to choose one concrete next spec. Do not respond with generic product directions.\n`
      : ''

    let baseSystemPrompt =
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

    if (hasAttachments) baseSystemPrompt = `${baseSystemPrompt}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`

    const systemPrompt = baseSystemPrompt
    const userPrompt = baseUserPrompt

    // Generate-spec spawn args are adapter-driven. For Claude the `--tools`
    // flag set comes from `toolFlagsForScope(quickScope)` which the adapter
    // doesn't model — pass them through `extraArgs` so they slot in after
    // the standard COMMON_FLAGS. `imageFlags` (also Claude-only) goes the
    // same way. For codex the system prompt folds into the user prompt
    // (no --system-prompt flag) and the extra Claude-only flags are ignored
    // by the codex adapter (it doesn't read extraArgs that don't apply).
    const adapter = getAdapter(provider)
    const toolFlags = provider === 'claude' ? toolFlagsForScope(quickScope) : { args: [] }
    // Full scope grants Read/Grep/Glob. The model spends turns exploring the
    // repo before it writes the spec; 6 was too tight (a few tool calls on a
    // sparse/empty repo hit error_max_turns → exit 1 → opaque failure). 15
    // leaves comfortable headroom while --max-turns still bounds runaway loops.
    const claudeMaxTurns = quickScope.full ? 15 : (hasAttachments ? 3 : 1)
    const args = adapter.buildArgs('spec-gen', {
      prompt: userPrompt,
      systemPrompt,
      model: resolvedModel,
      maxTurns: provider === 'claude' ? claudeMaxTurns : undefined,
      extraArgs: provider === 'claude' ? [...toolFlags.args, ...imageFlags] : undefined,
      // "My approved MCPs" (scope.userMcp) loads the developer's user-scope,
      // plugin, and connector MCP servers (claude-only). Quick already spawns
      // from project.path so project `.mcp.json` is discovered without a flag.
      loadUserEnv: provider === 'claude' && quickScope.userMcp,
    })
    const binary = adapter.binary

    // Relocate-artifacts gate: spawn from the workspace + SPECRAILS_REPO_DIR when
    // relocated, else cwd = project.path + process.env (byte-identical legacy).
    const specGenExec = resolveProjectExecution({ slug: project.slug, path: project.path })
    let specGenEnv: NodeJS.ProcessEnv = process.env
    if (specGenExec.relocated) {
      specGenEnv = { ...process.env, ...specGenExec.env }
      if (adapter.id === 'gemini') specGenEnv = { ...specGenEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
    }
    // spawnAiCli reroutes multi-line argv values through stdin on Windows;
    // POSIX argv path unchanged.
    console.log(`[project-router] spec-gen spawn: ${binary} (cwd=${specGenExec.cwd}, requestId=${requestId})`)
    const child = spawnAiCli(binary, args, {
      env: specGenEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: specGenExec.cwd,
    })
    // Register so removeProject()/shutdown() can tree-kill this otherwise-untracked
    // fire-and-forget child (auto-unregisters on close/error).
    trackTransientChild(projectId, child)

    // Watchdog: unlike ai-edit, generate-spec keeps no cancellable handle, so a
    // hung CLI (network stall, model never emitting a terminating event) would
    // otherwise leak this child + its readline for the app's lifetime. Cap is
    // generous — the 'full' scope can legitimately run minutes and --max-turns
    // bounds turns, not wall-clock. Cleared on close/error.
    const GENERATE_SPEC_TIMEOUT_MS = 8 * 60 * 1000
    let specGenWatchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      specGenWatchdog = null
      if (child.pid) {
        try { treeKill(child.pid, 'SIGTERM') } catch { /* best-effort */ }
      }
      broadcast({
        type: 'spec_gen_error', projectId, requestId,
        error: `Spec generation timed out after ${Math.round(GENERATE_SPEC_TIMEOUT_MS / 1000)}s`,
        timestamp: new Date().toISOString(),
      } as SpecGenErrorMessage)
    }, GENERATE_SPEC_TIMEOUT_MS)
    if (typeof specGenWatchdog.unref === 'function') specGenWatchdog.unref()
    const clearSpecGenWatchdog = () => {
      if (specGenWatchdog) { clearTimeout(specGenWatchdog); specGenWatchdog = null }
    }

    // Capture stderr so failures (auth missing, model errors, etc.) surface
    // in the server log instead of being swallowed.
    let stderrBuf = ''
    /* c8 ignore start -- diagnostic-only; fires only when claude writes stderr */
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stderrBuf += s
      console.error(`[project-router] spec-gen stderr (${requestId}): ${s.trimEnd()}`)
    })
    /* c8 ignore stop */

    // Without this listener, ENOENT (binary missing on PATH) propagates as
    // an unhandled 'error' event and crashes the entire app process.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      clearSpecGenWatchdog()
      console.error(`[project-router] spec-gen spawn failed (${binary}): ${err.message}`)
      const errMsg: SpecGenErrorMessage = {
        type: 'spec_gen_error', projectId, requestId,
        error: `Failed to launch ${binary}: ${err.message}`,
        timestamp: new Date().toISOString(),
      }
      broadcast(errMsg)
    })
    /* c8 ignore stop */

    res.status(202).json({ requestId })

    let buffer = ''
    let lastResultEvent: Record<string, unknown> | null = null
    // Canonical adapter events feed finaliseInvocationResult on close, giving
    // codex a real pricing-table cost estimate (+ estimated flag) and tokens,
    // instead of the legacy hardcoded $0. Accumulated ALONGSIDE the existing
    // buffer/delta plumbing below — never in place of it.
    const adapterEvents: AdapterEvent[] = []
    const turnStartedAt = new Date().toISOString()
    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      const adapterEv = adapter.parseStreamLine(line)
      if (adapterEv) adapterEvents.push(adapterEv)

      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* skip */ }
      if (!parsed) return

      if (provider === 'codex') {
        // Codex `exec --json` emits one event per line. Capture the final
        // `turn.completed` for usage extraction, and accumulate ONLY the
        // assistant_message text — never the command_execution items or
        // wrapper events, otherwise the raw JSONL ends up in the ticket
        // description.
        if ((parsed.type as string) === 'turn.completed') {
          lastResultEvent = parsed
          return
        }
        if ((parsed.type as string) !== 'item.completed') return
        const item = parsed.item as { type?: string; text?: string } | undefined
        if (!item || item.type !== 'agent_message') return
        const newText = (item.text ?? '').trim()
        if (!newText) return
        // Each agent_message is a complete chunk — separate with a blank
        // line so the parser regexes match cleanly across chunks.
        buffer += (buffer.endsWith('\n') || buffer.length === 0 ? '' : '\n') + newText + '\n'
        const msg: SpecGenStreamMessage = {
          type: 'spec_gen_stream', projectId, requestId,
          delta: newText + '\n', timestamp: new Date().toISOString(),
        }
        broadcast(msg)
        return
      }

      if (provider === 'claude') {
        // Claude path.
        if ((parsed.type as string) === 'result') {
          lastResultEvent = parsed
        }

        if ((parsed.type as string) === 'assistant') {
          const msg = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined
          const texts = (msg?.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
          const newText = texts.join('')
          if (newText) {
            buffer += newText
            const wsMsg: SpecGenStreamMessage = {
              type: 'spec_gen_stream', projectId, requestId,
              delta: newText, timestamp: new Date().toISOString(),
            }
            broadcast(wsMsg)
          }
        }
        return
      }

      // Adapter-driven path (gemini + future providers): the adapter already
      // parsed this line into a structured AdapterEvent above (`adapterEv`).
      // Accumulate assistant text deltas into the buffer and capture the result
      // event for usage extraction — mirrors the ai-edit endpoint's else branch.
      // Without this, gemini (which emits `type:'message'`, not `type:'assistant'`)
      // would never accumulate text → empty buffer → "Empty response from AI".
      if (adapterEv?.kind === 'result') {
        lastResultEvent = parsed
      }
      if (adapterEv?.kind === 'text-delta' && adapterEv.text) {
        buffer += adapterEv.text
        const wsMsg: SpecGenStreamMessage = {
          type: 'spec_gen_stream', projectId, requestId,
          delta: adapterEv.text, timestamp: new Date().toISOString(),
        }
        broadcast(wsMsg)
      }
    })

    child.on('close', async (code) => {
      clearSpecGenWatchdog()
      let createdTicketId: number | null = null

      // When claude burns its whole --max-turns budget it exits non-zero with
      // a result event of subtype:error_max_turns — but it may already have
      // emitted a complete spec. Salvage that usable output instead of failing
      // the whole request on an exit code.
      const resultSubtype = (lastResultEvent?.subtype as string | undefined) ?? null
      const hasUsableSpec = buffer.trim().length > 0 && /##\s*Spec Title/i.test(buffer)
      const salvageMaxTurns = code !== 0 && resultSubtype === 'error_max_turns' && hasUsableSpec

      if ((code === 0 && buffer.trim()) || salvageMaxTurns) {
        if (salvageMaxTurns) {
          console.warn(
            `[project-router] spec-gen salvaged partial output after error_max_turns (${requestId}); ` +
              `consider raising --max-turns if this recurs`,
          )
        }
        // Extract title from generated spec
        const titleMatch = buffer.match(/##\s*Spec Title\s*\n+(.+)/)
        const specTitle = titleMatch ? titleMatch[1].trim() : idea.trim().slice(0, 80)

        // Extract complexity for priority mapping
        const complexityMatch = buffer.match(/##\s*Estimated Complexity\s*\n+(\w+)/)
        const complexity = complexityMatch ? complexityMatch[1].toLowerCase() : 'medium'
        const priority = complexity === 'low' ? 'low' : complexity === 'high' || complexity === 'very' ? 'high' : 'medium'

        // Extract labels from the `## Labels` section. Comma- or
        // newline-separated tags, normalised to lowercase kebab-case.
        // `spec-proposal` is always retained as the marker label.
        const labelsMatch = buffer.match(/##\s*Labels\s*\n+([^\n]+(?:\n(?!##)[^\n]+)*)/)
        const claudeLabels: string[] = labelsMatch
          ? labelsMatch[1]
              .replace(/[\[\]]/g, '')
              .split(/[,\n]/)
              .map((s) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
              .filter((s) => s.length > 0 && s.length <= 32)
              .slice(0, 6)
          : []
        const finalLabels = Array.from(new Set(['spec-proposal', ...claudeLabels]))

        const shortSummary = clampShortSummary(extractShortSummary(buffer))
        const description = stripSpecMetadataSections(buffer)

        // Create ticket directly
        try {
          const now = new Date().toISOString()
          let created: import('./ticket-store').Ticket | undefined
          const store = mutateStore(filePath, (s) => {
            const id = s.next_id++
            const ticket: import('./ticket-store').Ticket = {
              id,
              title: specTitle,
              description,
              status: 'todo',
              priority: priority as 'low' | 'medium' | 'high',
              labels: finalLabels,
              assignee: null,
              prerequisites: [],
              metadata: {},
              comments: [],
              origin_conversation_id: null,
              is_epic: false,
              parent_epic_id: null,
              execution_order: null,
              short_summary: shortSummary,
              created_at: now,
              updated_at: now,
              created_by: 'sr-product-engineer',
              source: 'propose-spec',
            }
            s.tickets[String(id)] = ticket
            created = ticket
          })
          ticketWatcher.notifyDesktopWrite(store.revision)
          if (created) createdTicketId = created.id

          // Migrate attachments from pendingSpecId → real ticket id (if any were uploaded).
          // Must complete BEFORE broadcasting ticket_created so WS listeners see the populated attachments[].
          if (pendingSpecId && created) {
            try {
              const migrated = await attachmentManager.renameTicketDir({
                slug: project.slug,
                pendingId: pendingSpecId,
                realTicketId: created.id,
                ticketStorePath: ticketPath(req),
              })
              if (migrated.length > 0) {
                created.attachments = migrated
              }
            } catch (err) {
              console.error('[project-router] generate-spec attachment migration error:', err)
            }
          }

          const ticketMsg: TicketCreatedMessage = {
            type: 'ticket_created', ticket: created! as unknown as LocalTicket,
            projectId, timestamp: new Date().toISOString(),
          }
          broadcast(ticketMsg)

          const doneMsg: SpecGenDoneMessage = {
            type: 'spec_gen_done', projectId, requestId,
            ticket: created! as unknown as LocalTicket, timestamp: new Date().toISOString(),
          }
          broadcast(doneMsg)

          // Add Spec → Jira: promote the new ticket to a Jira issue when the
          // project is Jira-backed (unless the user opted to keep it local).
          void maybePromoteSpecToJira(ctx(req), created!.id, req.body?.createLocal === true, broadcast as (m: unknown) => void)

          // Quick mode Contract Refine: when toggle is on in the request body
          // AND the project setting + kill switch permit it, fire the no-resume
          // Quick refine path asynchronously. Claude-only today — codex
          // contract refine isn't wired (the spawn hardcodes the `claude`
          // binary). Skip silently on codex projects so the ticket lands
          // without the misleading "Contract layer skipped — model_error"
          // toast that the refine kill-switch would otherwise emit.
          if (quickContractRefine && created && provider === 'claude') {
            const refineTicketId = created.id
            const refineTitle = created.title
            const refineDescription = created.description
            const refineModel = (req.body?.model as string | undefined) ?? null
            process.nextTick(() => {
              void runContractRefineForQuick(
                {
                  db: ctx(req).db,
                  projectId: project.id,
                  projectSlug: project.slug,
                  projectPath: project.path,
                  projectName: project.name,
                  broadcast: broadcast as (m: unknown) => void,
                },
                refineTicketId,
                refineTitle,
                refineDescription,
                refineModel,
              ).catch((err: unknown) => {
                console.error('[project-router] runContractRefineForQuick error:', err)
              })
            })
          } else if (quickContractRefine && created && provider === 'codex') {
            console.log(
              `[project-router] quick contract refine skipped for codex project (ticket #${created.id}); ` +
                `feature is claude-only today`,
            )
          }
        } catch (err) {
          console.error('[project-router] generate-spec ticket creation error:', err)
          const errMsg: SpecGenErrorMessage = {
            type: 'spec_gen_error', projectId, requestId,
            error: 'Failed to create ticket', timestamp: new Date().toISOString(),
          }
          broadcast(errMsg)
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
        const msg: SpecGenErrorMessage = {
          type: 'spec_gen_error', projectId, requestId,
          error: reason,
          timestamp: new Date().toISOString(),
        }
        broadcast(msg)
      }

      // ai_invocations capture (surface='quick-spec'). Always emit a row, success or fail.
      try {
        // Adapter-driven finalisation: claude passes its native total_cost_usd
        // through untouched; codex (nativeCostUsd:false) gets a pricing-table
        // estimate from its captured token usage + estimated=true. This
        // replaces the legacy normaliseResultEvent path that hardcoded codex
        // cost to $0 and never set the estimated flag.
        const { result: normalised, estimated } = finaliseInvocationResult(
          adapter,
          adapterEvents,
          { fallbackModel: resolvedModel },
        )
        // extractCodexResult does not surface duration (codex stream carries
        // none); stamp wall-clock so the row's duration isn't lost. Claude's
        // result event already provides duration_ms, so prefer it.
        const wallMs = Date.now() - new Date(turnStartedAt).getTime()
        recordInvocation(ctx(req).db, {
          id: randomUUID(),
          project_id: projectId,
          provider: adapter.id,
          surface: 'quick-spec',
          surface_ref_id: requestId,
          ticket_id: createdTicketId,
          status: code === 0 && buffer.trim() ? 'success' : 'failed',
          started_at: turnStartedAt,
          finished_at: new Date().toISOString(),
          total_cost_usd_estimated: estimated,
          ...normalised,
          duration_ms: normalised.duration_ms ?? wallMs,
        })
        broadcast({ type: 'spending.invalidated', projectId })
      } catch (err) {
        console.error('[project-router] generate-spec recordInvocation failed:', err)
      }
    })
  })

  // POST /:projectId/tickets/save-as-draft — Persist an in-progress Explore session as a draft ticket
  router.post('/:projectId/tickets/save-as-draft', (req: Request, res: Response) => {
    const body = req.body ?? {}
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId is required' }); return
    }
    const providedTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []
    const description = typeof body.description === 'string' ? body.description : ''

    // Optional editTicketId — when present, demote that specific ticket in
    // place instead of looking up by conversationId. Drives the
    // Continue-Editing-on-non-draft flow.
    let editTicketId: number | undefined
    if (body.editTicketId !== undefined && body.editTicketId !== null) {
      if (typeof body.editTicketId !== 'number' || !Number.isFinite(body.editTicketId)) {
        res.status(400).json({ error: 'editTicketId must be a number' }); return
      }
      editTicketId = body.editTicketId
    }

    try {
      const { db, project, broadcast, ticketWatcher } = ctx(req)
      // Require at least one user-submitted turn before accepting a save
      const messages = getMessages(db, conversationId)
      const hasUserTurn = messages.some((m) => m.role === 'user' && (m.content ?? '').trim().length > 0)
      if (!hasUserTurn) {
        res.status(400).json({ error: 'conversation has no user-submitted turn yet' }); return
      }

      const filePath = ticketPath(req)
      const now = new Date().toISOString()

      let saved: Ticket | undefined
      let flippedInPlace = false
      let notFound = false
      const store = mutateStore(filePath, (s) => {
        if (editTicketId !== undefined) {
          const target = s.tickets[String(editTicketId)]
          if (!target) {
            notFound = true
            return
          }
          const title = providedTitle || target.title || generateAutoTitle(messages.map((m) => ({ role: m.role, content: m.content ?? '' })))
          target.title = title
          if (description) target.description = description
          if (labels.length > 0) target.labels = labels
          target.status = 'draft'
          target.priority = null
          target.origin_conversation_id = conversationId
          target.updated_at = now
          saved = target
          flippedInPlace = true
          return
        }
        // Idempotent on conversationId. A ticket from this conversation may
        // already exist as a DRAFT (update in place) OR as a COMMITTED ticket
        // (it was already turned into a real spec) — in the latter case do NOT
        // insert a duplicate draft sharing the same origin_conversation_id
        // (which would also break the delete→conversation cascade). Return the
        // committed ticket unchanged instead.
        const anyExisting = Object.values(s.tickets).find(
          (t) => t.origin_conversation_id === conversationId,
        )
        if (anyExisting && anyExisting.status !== 'draft') {
          saved = anyExisting
          return
        }
        const existing = anyExisting && anyExisting.status === 'draft' ? anyExisting : undefined
        const title = providedTitle || existing?.title || generateAutoTitle(messages.map((m) => ({ role: m.role, content: m.content ?? '' })))
        if (existing) {
          existing.title = title
          if (description) existing.description = description
          if (labels.length > 0) existing.labels = labels
          existing.updated_at = now
          saved = existing
          return
        }
        const id = s.next_id++
        const ticket: Ticket = {
          id,
          title,
          description,
          status: 'draft',
          priority: null,
          labels,
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: conversationId,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          created_at: now,
          updated_at: now,
          created_by: 'sr-explore-spec',
          source: 'explore-draft',
        }
        s.tickets[String(id)] = ticket
        saved = ticket
      })

      if (notFound) {
        res.status(404).json({ error: 'ticket not found' }); return
      }

      ticketWatcher.notifyDesktopWrite(store.revision)
      if (flippedInPlace) {
        const msg: TicketUpdatedMessage = {
          type: 'ticket_updated',
          ticket: saved! as unknown as LocalTicket,
          projectId: project.id,
          timestamp: now,
        }
        broadcast(msg)
        res.status(200).json({ ticket: saved!, revision: store.revision })
        return
      }
      const msg: TicketCreatedMessage | TicketUpdatedMessage = saved!.created_at === saved!.updated_at
        ? { type: 'ticket_created', ticket: saved! as unknown as LocalTicket, projectId: project.id, timestamp: now }
        : { type: 'ticket_updated', ticket: saved! as unknown as LocalTicket, projectId: project.id, timestamp: now }
      broadcast(msg)
      res.status(201).json({ ticket: saved!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] save-as-draft error:', err)
      res.status(500).json({ error: 'Failed to save draft' })
    }
  })

  // POST /:projectId/tickets/from-draft — Commit an Explore Spec draft as a real ticket
  // Two paths:
  //   (1) Legacy: payload has no `draftTicketId` → create a brand-new ticket (status='todo').
  //   (2) Flip in place: payload has `draftTicketId` referencing an existing
  //       status='draft' ticket → update that ticket in place to status='todo',
  //       set priority, replace title/description, preserve origin_conversation_id.
  router.post('/:projectId/tickets/from-draft', async (req: Request, res: Response) => {
    const body = req.body ?? {}
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    if (!rawTitle) {
      res.status(400).json({ error: 'title is required' }); return
    }
    const draftTicketId = typeof body.draftTicketId === 'number' ? body.draftTicketId : null
    const pendingSpecId = typeof body.pendingSpecId === 'string' ? body.pendingSpecId : null
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
    const baseDescription = typeof body.description === 'string' ? body.description.trim() : ''
    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []
    const acceptanceCriteria = Array.isArray(body.acceptanceCriteria)
      ? (body.acceptanceCriteria as unknown[])
          .filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : []
    const priority = isValidPriority(body.priority) ? body.priority : 'medium'

    // Compose the final ticket body. The title is already its own ticket
    // field, so we deliberately do NOT echo it as a `## Spec Title` heading
    // inside the description. The body is just the structured sections from
    // Claude (Problem Statement / Proposed Solution / Out of Scope /
    // Technical Considerations / Estimated Complexity) followed by the
    // Acceptance Criteria bullets.
    const description = formatDescriptionWithCriteria(baseDescription, acceptanceCriteria)

    // Short summary: explicit body field wins; otherwise try extracting a
    // `## Short Summary` section from the description and stripping it.
    let bodyShortSummary: string | null = null
    let descriptionForStore = description
    if (typeof body.shortSummary === 'string') {
      bodyShortSummary = clampShortSummary(body.shortSummary)
    } else {
      const extracted = extractShortSummary(description)
      if (extracted !== null) {
        bodyShortSummary = clampShortSummary(extracted)
        descriptionForStore = description
          .replace(/##\s*Short Summary\s*\n+(?:[^\n]+(?:\n(?!##)[^\n]+)*)\n*/i, '')
          .trim()
      }
    }
    if (bodyShortSummary === null) {
      bodyShortSummary = deriveFallbackShortSummary(rawTitle, descriptionForStore)
    }

    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      let wasFlip = false
      let explicitDraftMissing = false
      const store = mutateStore(filePath, (s) => {
        // Resolve flip target: explicit `draftTicketId` wins; otherwise look up
        // an existing draft ticket whose origin_conversation_id matches the
        // current conversation so a resumed session commits in place even when
        // the client doesn't track the draft id explicitly.
        let flipTarget: Ticket | undefined
        if (draftTicketId !== null) {
          flipTarget = s.tickets[String(draftTicketId)]
          if (!flipTarget) {
            explicitDraftMissing = true
            return
          }
          if (flipTarget.status !== 'draft') {
            // Already committed (lost-response retry / second tab / watchdog
            // re-fire): return the committed ticket idempotently instead of a
            // spurious 404. The draft was flipped on the first call.
            created = flipTarget
            wasFlip = true
            return
          }
        } else if (conversationId) {
          flipTarget = Object.values(s.tickets).find(
            (t) => t.origin_conversation_id === conversationId && t.status === 'draft',
          )
        }
        if (flipTarget) {
          flipTarget.status = 'todo'
          flipTarget.priority = priority
          flipTarget.title = rawTitle
          flipTarget.description = descriptionForStore
          if (labels.length > 0) flipTarget.labels = labels
          flipTarget.updated_at = now
          // Preserve prior short_summary on flip when the model/body omits one;
          // overwrite only when a non-null value is provided.
          if (bodyShortSummary !== null) {
            flipTarget.short_summary = bodyShortSummary
          }
          // origin_conversation_id is intentionally preserved
          created = flipTarget
          wasFlip = true
          return
        }
        // B62: from-draft is idempotent only while the ticket is still a draft.
        // After a successful commit the draft is 'todo', so the draft lookup above
        // no longer matches and a second from-draft for the same conversation
        // would insert a DUPLICATE ticket. If a (now non-draft) ticket already
        // originates from this conversation, return it instead of re-inserting.
        if (conversationId) {
          const alreadyCommitted = Object.values(s.tickets).find(
            (t) => t.origin_conversation_id === conversationId,
          )
          if (alreadyCommitted) {
            created = alreadyCommitted
            wasFlip = true // treat as in-place: broadcast ticket_updated, not created
            return
          }
        }
        // Legacy: insert new ticket
        const id = s.next_id++
        const ticket: Ticket = {
          id,
          title: rawTitle,
          description: descriptionForStore,
          status: 'todo',
          priority,
          labels,
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: conversationId,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: bodyShortSummary,
          created_at: now,
          updated_at: now,
          created_by: 'sr-explore-spec',
          source: 'propose-spec',
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })
      if (explicitDraftMissing) {
        res.status(404).json({ error: 'Draft ticket not found or not in draft status' }); return
      }
      const { broadcast, ticketWatcher, project } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)

      // Migrate attachments from pendingSpecId → real ticket id (mirrors the
      // generate-spec flow). Must complete before broadcasting ticket_created
      // so listeners see the populated attachments[].
      if (pendingSpecId && created) {
        try {
          const migrated = await attachmentManager.renameTicketDir({
            slug: project.slug,
            pendingId: pendingSpecId,
            realTicketId: created.id,
            ticketStorePath: ticketPath(req),
          })
          if (migrated.length > 0) {
            created.attachments = migrated
          }
        } catch (err) {
          console.error('[project-router] from-draft attachment migration error:', err)
        }
      }

      const msg: TicketCreatedMessage | TicketUpdatedMessage = wasFlip
        ? {
            type: 'ticket_updated',
            ticket: created! as unknown as LocalTicket,
            projectId: project.id,
            timestamp: new Date().toISOString(),
          }
        : {
            type: 'ticket_created',
            ticket: created! as unknown as LocalTicket,
            projectId: project.id,
            timestamp: new Date().toISOString(),
          }
      broadcast(msg)

      // Back-fill ticket_id on the conversation's prior ai_invocations rows.
      if (conversationId && created) {
        try {
          const changes = updateTicketIdForConversation(ctx(req).db, conversationId, created.id)
          if (changes > 0) {
            broadcast({ type: 'spending.invalidated', projectId: project.id })
          }
        } catch (err) {
          console.error('[project-router] from-draft ai_invocations back-fill failed:', err)
        }
      }

      res.status(201).json({ ticket: created!, revision: store.revision })

      // Add Spec (Explore) → Jira: promote the committed ticket to a Jira issue
      // when the project is Jira-backed (unless the user opted to keep it local).
      void maybePromoteSpecToJira(ctx(req), created!.id, body.createLocal === true, broadcast as (m: unknown) => void)

      // Fire Contract Refine post-commit (fire-and-forget). Toggle + kill-switch
      // are checked inside runContractRefine. Claude-only today — codex
      // contract refine isn't wired (the spawn hardcodes the `claude`
      // binary). Skip silently on codex projects.
      // Gate on the CONVERSATION's own engine, not the project's PRIMARY
      // provider: a multi-provider project with a non-claude primary can still
      // run an Explore on the claude engine + opt into Contract Refine.
      const convoProvider = conversationId
        ? (getConversation(ctx(req).db, conversationId)?.provider ?? 'claude')
        : null
      if (conversationId && created && convoProvider === 'claude') {
        const createdTicketId = created.id
        const convoId = conversationId
        console.log(`[project-router] from-draft hook: scheduling refine ticket=${createdTicketId} conv=${convoId}`)
        process.nextTick(() => {
          void runContractRefine(
            {
              db: ctx(req).db,
              projectId: project.id,
              projectSlug: project.slug,
              projectPath: project.path,
              projectName: project.name,
              broadcast: broadcast as (m: unknown) => void,
            },
            convoId,
            createdTicketId,
          ).catch((err) => {
            console.error('[project-router] runContractRefine error:', err)
          })
        })
      } else if (conversationId && created && convoProvider && convoProvider !== 'claude') {
        console.log(
          `[project-router] from-draft contract refine skipped for ${convoProvider} conversation (ticket #${created.id})`,
        )
      }
    } catch (err) {
      console.error('[project-router] from-draft create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })

  // POST /:projectId/tickets/from-prompt — Create a spec directly from a
  // free-form prompt (the "Raw" Add-Spec mode). NO AI is invoked: the user's
  // text becomes the ticket description verbatim. The ticket lands as
  // status='todo' (ready for rails) with source='free-prompt'. There is no
  // ai_invocations row (nothing was billed) and no contract-refine (no origin
  // conversation, no description format to refine).
  router.post('/:projectId/tickets/from-prompt', async (req: Request, res: Response) => {
    const body = req.body ?? {}
    const rawDescription = typeof body.description === 'string' ? body.description.trim() : ''
    if (!rawDescription) {
      res.status(400).json({ error: 'description is required' }); return
    }
    // Optional light-structuring (v1: the client always sends `false`; the flag
    // keeps the contract stable for a future non-generative structuring pass).
    const structured = body.structured === true
    const description = structured ? lightlyStructurePrompt(rawDescription) : rawDescription

    // Title: explicit value wins; otherwise derive a single-line summary from
    // the body (reusing the deterministic Explore-draft summarizer).
    const providedTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const title = providedTitle || generateAutoTitle([{ role: 'user', content: rawDescription }])

    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []

    // Priority: validate against the allowed set; default 'medium'. A
    // status='todo' ticket MUST carry a non-null priority (see
    // validatePriorityForStatus), so we never accept null here.
    const priority = isValidPriority(body.priority) ? body.priority : 'medium'
    const validationError = validatePriorityForStatus('todo', priority)
    if (validationError) {
      res.status(400).json({ error: validationError }); return
    }

    const pendingSpecId = typeof body.pendingSpecId === 'string' ? body.pendingSpecId : null
    const shortSummary = deriveFallbackShortSummary(title, description)

    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      const store = mutateStore(filePath, (s) => {
        const id = s.next_id++
        const ticket: Ticket = {
          id,
          title,
          description,
          status: 'todo',
          priority,
          labels,
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: shortSummary,
          created_at: now,
          updated_at: now,
          created_by: 'hub', // legacy on-disk wire value (tickets.json, shared with specrails-core) — do not rename
          source: 'free-prompt',
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })

      const { broadcast, ticketWatcher, project } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)

      // Migrate attachments from pendingSpecId → real ticket id (mirrors the
      // generate-spec / from-draft flow). Must complete before broadcasting so
      // listeners see the populated attachments[].
      if (pendingSpecId && created) {
        try {
          const migrated = await attachmentManager.renameTicketDir({
            slug: project.slug,
            pendingId: pendingSpecId,
            realTicketId: created.id,
            ticketStorePath: ticketPath(req),
          })
          if (migrated.length > 0) {
            created.attachments = migrated
          }
        } catch (err) {
          console.error('[project-router] from-prompt attachment migration error:', err)
        }
      }

      const msg: TicketCreatedMessage = {
        type: 'ticket_created',
        ticket: created! as unknown as LocalTicket,
        projectId: project.id,
        timestamp: new Date().toISOString(),
      }
      broadcast(msg)
      res.status(201).json({ ticket: created!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] from-prompt create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })

  // POST /:projectId/tickets/:id/contract-refine — Manually re-fire refine
  router.post('/:projectId/tickets/:id/contract-refine', async (req: Request, res: Response) => {
    const ticketId = Number.parseInt(String(req.params.id ?? ''), 10)
    if (!Number.isFinite(ticketId)) {
      res.status(400).json({ error: 'invalid ticket id' }); return
    }
    const { project, db, broadcast } = ctx(req)
    if (isExploreContractRefineKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env' }); return
    }
    if (project.provider === 'codex') {
      res.status(409).json({ error: 'contract_refine_unsupported_for_codex' }); return
    }
    // Validate the ticket exists.
    try {
      const filePath = ticketPath(req)
      const { withLock } = await import('./ticket-store')
      const ticket = withLock(filePath, (s) => s.tickets[String(ticketId)])
      if (!ticket) { res.status(404).json({ error: 'ticket not found' }); return }
      if (!ticket.origin_conversation_id) {
        res.status(409).json({ error: 'ticket has no origin conversation' }); return
      }
      const convoId = ticket.origin_conversation_id
      res.status(202).json({ scheduled: true })
      process.nextTick(() => {
        void runContractRefine(
          {
            db,
            projectId: project.id,
            projectSlug: project.slug,
            projectPath: project.path,
            projectName: project.name,
            broadcast: broadcast as (m: unknown) => void,
            ignoreConversationScope: true,
          },
          convoId,
          ticketId,
        ).catch((err) => {
          console.error('[project-router] retry runContractRefine error:', err)
        })
      })
    } catch (err) {
      console.error('[project-router] retry endpoint error:', err)
      res.status(500).json({ error: 'Failed to schedule retry' })
    }
  })

  // POST /:projectId/tickets/:id/smash — Decompose ticket into N children
  router.post('/:projectId/tickets/:id/smash', async (req: Request, res: Response) => {
    const ticketId = Number.parseInt(String(req.params.id ?? ''), 10)
    if (!Number.isFinite(ticketId)) {
      res.status(400).json({ error: 'invalid ticket id' }); return
    }
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const { project, db, broadcast } = ctx(req)
    try {
      const filePath = ticketPath(req)
      const { readStore } = await import('./ticket-store')
      const store = readStore(filePath)
      const gate = checkSmashEligibility(store, ticketId)
      if (!gate.ok) {
        const statusCode = gate.reason === 'ticket-not-found' ? 404 : 409
        res.status(statusCode).json({ error: 'ineligible', reason: gate.reason })
        return
      }
      const rawMode = typeof req.body?.mode === 'string' ? req.body.mode : 'simple'
      const mode: 'simple' | 'full' = rawMode === 'full' ? 'full' : 'simple'
      const model = typeof req.body?.model === 'string' && req.body.model.length > 0 ? req.body.model : null
      res.status(202).json({ scheduled: true, mode })
      process.nextTick(() => {
        void runSmash(
          {
            db,
            projectId: project.id,
            projectSlug: project.slug,
            projectPath: project.path,
            projectName: project.name,
            // Relocate-artifacts: pass the gated tickets-store path so SMASH
            // reads/writes the same store the rails load (workspace when
            // relocated), not a stale repo copy.
            ticketsPath: filePath,
            broadcast: broadcast as (m: unknown) => void,
            mode,
            model,
          },
          ticketId,
        ).catch((err) => {
          console.error('[project-router] runSmash error:', err)
        })
      })
    } catch (err) {
      console.error('[project-router] smash endpoint error:', err)
      res.status(500).json({ error: 'Failed to schedule SMASH' })
    }
  })

  // POST /:projectId/tickets/:id/smash/undo — Reverse a prior SMASH
  router.post('/:projectId/tickets/:id/smash/undo', async (req: Request, res: Response) => {
    const ticketId = Number.parseInt(String(req.params.id ?? ''), 10)
    if (!Number.isFinite(ticketId)) {
      res.status(400).json({ error: 'invalid ticket id' }); return
    }
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const smashedAt = typeof req.body?.smashedAt === 'string' ? req.body.smashedAt : null
    if (!smashedAt) {
      res.status(400).json({ error: 'smashedAt timestamp required' }); return
    }
    const { project, db, broadcast } = ctx(req)
    try {
      const result = await runSmashUndo(
        {
          db,
          projectId: project.id,
          projectSlug: project.slug,
          projectPath: project.path,
          projectName: project.name,
          ticketsPath: ticketPath(req),
          broadcast: broadcast as (m: unknown) => void,
        },
        ticketId,
        smashedAt,
      )
      if (!result.ok) {
        const statusCode = result.reason === 'ticket-not-found' ? 404 : 409
        res.status(statusCode).json({ error: 'undo_failed', reason: result.reason }); return
      }
      res.json({ ok: true, deletedChildren: result.deletedChildren })
    } catch (err) {
      console.error('[project-router] smash/undo endpoint error:', err)
      res.status(500).json({ error: 'Failed to undo SMASH' })
    }
  })

  // DELETE /:projectId/tickets/:id/children — Delete all children of an épica
  router.delete('/:projectId/tickets/:id/children', (req: Request, res: Response) => {
    const ticketId = Number.parseInt(String(req.params.id ?? ''), 10)
    if (!Number.isFinite(ticketId)) {
      res.status(400).json({ error: 'invalid ticket id' }); return
    }
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const { project, broadcast, ticketWatcher } = ctx(req)
    try {
      const filePath = ticketPath(req)
      const result = applyDeleteEpicChildren(filePath, ticketId)
      // Pass the real post-write revision (not 0) so the chokidar echo is
      // suppressed; a hardcoded 0 never matches the on-disk revision and
      // triggers a spurious full-refresh broadcast to every client.
      ticketWatcher.notifyDesktopWrite(result.revision)
      const now = new Date().toISOString()
      for (const id of result.deletedChildren) {
        broadcast({
          type: 'ticket_deleted',
          ticketId: id,
          projectId: project.id,
          timestamp: now,
        } as TicketDeletedMessage)
      }
      res.json({ ok: true, deletedChildren: result.deletedChildren })
    } catch (err) {
      console.error('[project-router] delete-children error:', err)
      res.status(500).json({ error: 'Failed to delete children' })
    }
  })

  // POST /:projectId/tickets — Create new ticket
  router.post('/:projectId/tickets', (req: Request, res: Response) => {
    const { title, description, status, priority, labels, assignee, prerequisites, metadata, source } = req.body ?? {}
    if (!title || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title is required' }); return
    }
    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({ error: 'status must be one of: draft, todo, in_progress, done, cancelled' }); return
    }
    const finalStatus = (status ?? 'todo') as import('./ticket-store').TicketStatus
    const finalPriority = priority === undefined ? (finalStatus === 'draft' ? null : 'medium') : (priority === null ? null : priority)
    const priorityError = validatePriorityForStatus(finalStatus, finalPriority as never)
    if (priorityError) {
      res.status(400).json({ error: priorityError }); return
    }
    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      const store = mutateStore(filePath, (s) => {
        const id = s.next_id++
        const ticket: Ticket = {
          id,
          title: title.trim(),
          description: typeof description === 'string' ? description : '',
          status: finalStatus,
          priority: finalPriority as Ticket['priority'],
          labels: Array.isArray(labels) ? labels.filter((l: unknown) => typeof l === 'string') : [],
          assignee: typeof assignee === 'string' ? assignee : null,
          prerequisites: Array.isArray(prerequisites) ? prerequisites.filter((p: unknown) => typeof p === 'number') : [],
          metadata: typeof metadata === 'object' && metadata !== null ? metadata : {},
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          created_at: now,
          updated_at: now,
          created_by: 'hub', // legacy on-disk wire value (tickets.json, shared with specrails-core) — do not rename
          source: source === 'product-backlog' || source === 'propose-spec' || source === 'manual' ? source : 'hub', // legacy on-disk wire value — do not rename
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })
      const { broadcast, ticketWatcher } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)
      const msg: TicketCreatedMessage = { type: 'ticket_created', ticket: created! as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      res.status(201).json({ ticket: created!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })

  // PATCH /:projectId/tickets/:id — Update ticket fields
  router.patch('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = req.params.id as string
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'Invalid ticket ID' }); return
    }
    const { title, description, status, priority, labels, assignee, prerequisites, metadata, acceptanceCriteria, short_summary } = req.body ?? {}
    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({ error: 'status must be one of: draft, todo, in_progress, done, cancelled' }); return
    }
    if (priority !== undefined && priority !== null && !isValidPriority(priority)) {
      res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' }); return
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      res.status(400).json({ error: 'title cannot be empty' }); return
    }
    if (acceptanceCriteria !== undefined) {
      if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every((c) => typeof c === 'string')) {
        res.status(400).json({ error: 'acceptanceCriteria must be an array of strings' }); return
      }
    }
    try {
      const filePath = ticketPath(req)
      let updated: Ticket | undefined
      let validationError: string | null = null
      const store = mutateStore(filePath, (s) => {
        const ticket = s.tickets[ticketId]
        if (!ticket) return
        const nextStatus = (status ?? ticket.status) as import('./ticket-store').TicketStatus
        const nextPriority = priority === undefined ? ticket.priority : (priority === null ? null : priority)
        const err = validatePriorityForStatus(nextStatus, nextPriority as never)
        if (err) { validationError = err; return }
        if (title !== undefined) ticket.title = title.trim()
        if (description !== undefined) ticket.description = description
        if (acceptanceCriteria !== undefined) {
          // Fold criteria into the description body under a `## Acceptance Criteria`
          // section, replacing any existing one. Use the just-set description if
          // present, otherwise the ticket's current description.
          ticket.description = formatDescriptionWithCriteria(ticket.description ?? '', acceptanceCriteria as string[])
        }
        if (status !== undefined) ticket.status = status
        if (priority !== undefined) ticket.priority = nextPriority as Ticket['priority']
        if (labels !== undefined && Array.isArray(labels)) ticket.labels = labels.filter((l: unknown) => typeof l === 'string')
        if (assignee !== undefined) ticket.assignee = typeof assignee === 'string' ? assignee : null
        if (prerequisites !== undefined && Array.isArray(prerequisites)) ticket.prerequisites = prerequisites.filter((p: unknown) => typeof p === 'number')
        if (metadata !== undefined && typeof metadata === 'object' && metadata !== null) {
          ticket.metadata = { ...ticket.metadata, ...metadata }
        }
        // Short summary: explicit non-empty overwrites; explicit null clears;
        // omitted leaves the existing value untouched (preserves prior summary
        // when AI Refine omits it for a partial edit).
        if (short_summary === null) {
          ticket.short_summary = null
        } else if (typeof short_summary === 'string') {
          ticket.short_summary = clampShortSummary(short_summary)
        }
        ticket.updated_at = new Date().toISOString()
        updated = ticket
      })
      if (validationError) {
        res.status(400).json({ error: validationError }); return
      }
      if (!updated) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      const { broadcast, ticketWatcher, jiraSyncManager } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)
      const msg: TicketUpdatedMessage = { type: 'ticket_updated', ticket: updated as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      // Write the edited fields back to Jira for Jira-backed specs (no-op
      // otherwise). Uses the FINAL stored values (e.g. acceptance-criteria
      // folding) for the fields that were actually changed. Never breaks the
      // local save — a Jira hiccup only fails the enqueue, which is caught.
      try {
        const u = updated as Ticket
        const changes: { title?: string; description?: string; priority?: string | null; labels?: string[] } = {}
        if (title !== undefined) changes.title = u.title
        if (description !== undefined || acceptanceCriteria !== undefined) changes.description = u.description
        if (priority !== undefined) changes.priority = u.priority ?? null
        if (labels !== undefined) changes.labels = u.labels
        if (Object.keys(changes).length > 0) jiraSyncManager?.onSpecEdited(Number(ticketId), changes)
      } catch (e) {
        console.error('[project-router] jira write-back enqueue failed:', e)
      }
      res.json({ ticket: updated, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket update error:', err)
      res.status(500).json({ error: 'Failed to update ticket' })
    }
  })

  // POST /:projectId/tickets/:id/ai-edit — AI-powered description editing
  const _aiEditProcesses = new Map<string, import('child_process').ChildProcess>()

  router.post('/:projectId/tickets/:id/ai-edit', async (req: Request, res: Response) => {
    const ticketId = req.params.id as string
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'Invalid ticket ID' }); return
    }
    const instructions = req.body?.instructions as string | undefined
    const currentDescription = req.body?.description as string | undefined
    const currentTitle = typeof req.body?.title === 'string' ? (req.body.title as string) : ''
    if (!instructions?.trim()) {
      res.status(400).json({ error: 'instructions is required' }); return
    }
    if (!currentDescription) {
      res.status(400).json({ error: 'description is required' }); return
    }
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? (req.body.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const priorInstructions = Array.isArray(req.body?.priorInstructions)
      ? (req.body.priorInstructions as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const priorProposalRaw = req.body?.priorProposal
    const priorProposal = typeof priorProposalRaw === 'string' && priorProposalRaw.length > 0 ? priorProposalRaw : null
    const isRefinement = priorProposal !== null

    const { project, broadcast } = ctx(req)
    const provider = project.provider ?? 'claude'
    const requestId = uuidv4()
    const projectId = project.id

    // Build the focused pre-prompt
    const baseRules =
      `- Output format MUST be exactly:\n` +
      `    TITLE: <one-line spec title>\n` +
      `    SHORT-SUMMARY: <one or two plain-language sentences, max 120 chars, summarising the spec for a dashboard postit. No markdown, no bullets.>\n` +
      `    \n` +
      `    <markdown description body>\n` +
      `  The first line MUST start with "TITLE: " followed by the refined title.\n` +
      `  The second line MUST start with "SHORT-SUMMARY: " followed by the summary.\n` +
      `  Then exactly one blank line. Then the markdown description.\n` +
      `- Keep the title concise (under 80 characters) and reflective of the latest description.\n` +
      `  If the user's refinement does not affect the title's intent, you may keep it unchanged — but always emit the TITLE line.\n` +
      `- The SHORT-SUMMARY line MUST always be present. If the user's refinement does not change what the spec is about, keep the previous summary verbatim. Never omit the line.\n` +
      `- After the SHORT-SUMMARY line and blank line, output ONLY the modified description in markdown. No preamble, no explanation, no wrapping.\n` +
      `- Preserve the existing markdown structure and section headings in the description.\n` +
      `- If the user asks to add technical details, briefly check CLAUDE.md and the project directory structure (ls, not deep reads) to ground your edits.\n` +
      `- Keep it concise and actionable.\n` +
      `- Do NOT create files, tickets, or issues. Only output text.`

    const refinementRule = isRefinement
      ? `\n- You are editing an in-progress draft, not the saved description. Apply the new refinement to the Latest Draft below.`
      : ''

    let systemPrompt =
      `You are a spec editor. You will receive a ticket title and description plus user instructions for how to modify them. ` +
      `Your job is to produce an improved version of BOTH the title and the description.\n\n` +
      `RULES:\n` +
      `${baseRules}${refinementRule}`

    let userPrompt = isRefinement
      ? `## Current Title (saved baseline)\n\n${currentTitle}\n\n` +
        `## Current Description (saved baseline — do not rewrite)\n\n${currentDescription}\n\n` +
        `## Prior Refinement Turns\n\n${priorInstructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
        `## Latest Draft (from previous turn — apply the new refinement to this; the draft already includes a TITLE: line)\n\n${priorProposal}\n\n` +
        `## New Refinement\n\n${instructions.trim()}\n\n` +
        `Output the updated TITLE line followed by the updated description now.`
      : `## Current Title\n\n${currentTitle}\n\n` +
        `## Current Description\n\n${currentDescription}\n\n` +
        `## User Instructions\n\n${instructions.trim()}\n\n` +
        `Output the modified TITLE line followed by the modified description now.`

    let imageFlags: string[] = []
    if (attachmentIds.length > 0) {
      try {
        const extracted = await attachmentManager.getClaudeArgs(project.slug, ticketId, attachmentIds)
        imageFlags = extracted.imageFlags
        if (extracted.textBlocks.length > 0) {
          systemPrompt = `${systemPrompt}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`
          userPrompt = `${userPrompt}\n\n## Attached Files\n\n${extracted.textBlocks.join('\n\n')}`
        }
      } catch (err) {
        console.error('[project-router] ai-edit attachment extraction error:', err)
      }
    }

    let binary: string
    let args: string[]

    if (provider === 'codex') {
      binary = 'codex'
      // Use gpt-5.5 (default for Codex per CODEX_MODELS/PRESET_DEFAULTS in ModelSelector); never hardcode o4-mini
      args = ['exec', `${systemPrompt}\n\n${userPrompt}`, '--model', 'gpt-5.5']
    } else if (provider === 'claude') {
      binary = 'claude'
      args = [
        '--dangerously-skip-permissions',
        '--tools', 'default',
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '4',
        ...imageFlags,
        '--system-prompt', systemPrompt,
        '-p', userPrompt,
      ]
    } else {
      // Adapter-driven path (gemini + any future provider): binary, argv, and
      // stream parsing all come from the registered adapter — no per-provider
      // hardcoding. The claude/codex shapes above are kept byte-identical.
      const adapter = getAdapter(provider)
      binary = adapter.binary
      args = adapter.buildArgs('agent-refine', {
        prompt: userPrompt,
        systemPrompt,
        model: adapter.defaultModel(),
      })
    }

    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    console.log(`[project-router] ai-edit spawn: ${binary} (cwd=${project.path}, requestId=${requestId})`)
    const child = spawnAiCli(binary, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: project.path,
    })

    _aiEditProcesses.set(requestId, child)

    // Pipe stderr to server log so failures surface for debugging.
    let aiEditStderrBuf = ''
    /* c8 ignore start -- diagnostic-only; fires only when claude writes stderr */
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      aiEditStderrBuf += s
      console.error(`[project-router] ai-edit stderr (${requestId}): ${s.trimEnd()}`)
    })
    /* c8 ignore stop */

    // Without this listener, ENOENT (binary missing on PATH) propagates as
    // an unhandled 'error' event and crashes the entire app process.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[project-router] ai-edit spawn failed (${binary}): ${err.message}`)
      _aiEditProcesses.delete(requestId)
      const errMsg: TicketAiEditErrorMessage = {
        type: 'ticket_ai_edit_error', projectId, ticketId: Number(ticketId),
        requestId, error: `Failed to launch ${binary}: ${err.message}`,
        timestamp: new Date().toISOString(),
      }
      broadcast(errMsg)
    })
    /* c8 ignore stop */

    res.status(202).json({ requestId })

    let buffer = ''
    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      if (provider === 'codex') {
        if (line) {
          buffer += line + '\n'
          const msg: TicketAiEditStreamMessage = {
            type: 'ticket_ai_edit_stream', projectId, ticketId: Number(ticketId),
            requestId, delta: line + '\n', timestamp: new Date().toISOString(),
          }
          broadcast(msg)
        }
      } else if (provider === 'claude') {
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(line) } catch { /* skip */ }
        if (!parsed) return

        if ((parsed.type as string) === 'assistant') {
          const msg = parsed.message as { content?: Array<{ type: string; text?: string }> } | undefined
          const texts = (msg?.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
          const newText = texts.join('')
          if (newText) {
            buffer += newText
            const wsMsg: TicketAiEditStreamMessage = {
              type: 'ticket_ai_edit_stream', projectId, ticketId: Number(ticketId),
              requestId, delta: newText, timestamp: new Date().toISOString(),
            }
            broadcast(wsMsg)
          }
        }
      } else {
        // Adapter-driven parse (gemini + future providers): uniform AdapterEvent
        // stream — accumulate assistant text deltas.
        const ev = getAdapter(provider).parseStreamLine(line)
        if (ev?.kind === 'text-delta' && ev.text) {
          buffer += ev.text
          const wsMsg: TicketAiEditStreamMessage = {
            type: 'ticket_ai_edit_stream', projectId, ticketId: Number(ticketId),
            requestId, delta: ev.text, timestamp: new Date().toISOString(),
          }
          broadcast(wsMsg)
        }
      }
    })

    child.on('close', (code) => {
      _aiEditProcesses.delete(requestId)
      if (code === 0 && buffer.trim()) {
        const msg: TicketAiEditDoneMessage = {
          type: 'ticket_ai_edit_done', projectId, ticketId: Number(ticketId),
          requestId, fullText: buffer.trim(), timestamp: new Date().toISOString(),
        }
        broadcast(msg)
      } else {
        const reason = code === 0 ? 'Empty response from AI' : `Process exited with code ${code}`
        console.error(
          `[project-router] ai-edit failed (${requestId}): ${reason}` +
            (aiEditStderrBuf.trim() ? `\n  stderr: ${aiEditStderrBuf.trim()}` : '') +
            (buffer.trim() ? `\n  stdout-buffer: ${buffer.trim().slice(0, 500)}` : ''),
        )
        const msg: TicketAiEditErrorMessage = {
          type: 'ticket_ai_edit_error', projectId, ticketId: Number(ticketId),
          requestId, error: reason,
          timestamp: new Date().toISOString(),
        }
        broadcast(msg)
      }
    })
  })

  router.delete('/:projectId/tickets/:id/ai-edit', (req: Request, res: Response) => {
    const requestId = req.query.requestId as string | undefined
    if (!requestId) { res.status(400).json({ error: 'requestId query param required' }); return }
    const child = _aiEditProcesses.get(requestId)
    if (!child?.pid) { res.status(404).json({ error: 'No active AI edit for this request' }); return }
    treeKill(child.pid, 'SIGTERM')
    _aiEditProcesses.delete(requestId)
    res.json({ ok: true })
  })

  // DELETE /:projectId/tickets/:id — Delete ticket
  router.delete('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = req.params.id as string
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'Invalid ticket ID' }); return
    }
    try {
      const filePath = ticketPath(req)
      let found = false
      let orphanedConversationId: string | null = null
      const orphanedChildren: Ticket[] = []
      const numericId = Number(ticketId)
      const store = mutateStore(filePath, (s) => {
        const t = s.tickets[ticketId]
        if (!t) return
        // If this is a draft and no other ticket references the same
        // origin_conversation_id, mark it for cascade delete.
        if (t.status === 'draft' && t.origin_conversation_id) {
          const otherRefs = Object.values(s.tickets).some(
            (other) => other.id !== t.id && other.origin_conversation_id === t.origin_conversation_id,
          )
          if (!otherRefs) orphanedConversationId = t.origin_conversation_id
        }
        // SMASH: when deleting an épica, orphan its children (set
        // parent_epic_id/execution_order to null) rather than cascade-delete.
        if (t.is_epic) {
          const now = new Date().toISOString()
          for (const childId of Object.keys(s.tickets)) {
            const child = s.tickets[childId]
            if (child.parent_epic_id === numericId) {
              child.parent_epic_id = null
              child.execution_order = null
              child.updated_at = now
              orphanedChildren.push(child)
            }
          }
        }
        delete s.tickets[ticketId]
        found = true
      })
      if (!found) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      const { broadcast, ticketWatcher, db, chatManager } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)
      // Cascade-delete attachments for this ticket
      attachmentManager.deleteAll(ctx(req).project.slug, ticketId).catch((e) => {
        console.error('[project-router] attachment cascade delete failed:', e)
      })
      // Cascade-delete the orphaned Explore conversation, if any.
      if (orphanedConversationId) {
        try {
          const conv = getConversation(db, orphanedConversationId)
          if (conv && (conv as { kind?: string }).kind === 'explore') {
            deleteConversation(db, orphanedConversationId)
            chatManager?.forgetSpecDraft(orphanedConversationId)
            chatManager?.forgetExploreLifecycle(orphanedConversationId)
          }
        } catch (err) {
          console.error('[project-router] orphan conversation cleanup failed:', err)
        }
      }
      // Broadcast ticket_updated for each orphaned child so observers see them
      // as regular tickets (no longer attached to the deleted épica).
      for (const child of orphanedChildren) {
        broadcast({
          type: 'ticket_updated',
          ticket: child,
          projectId: ctx(req).project.id,
          timestamp: new Date().toISOString(),
        } as unknown as TicketCreatedMessage)
      }
      const msg: TicketDeletedMessage = { type: 'ticket_deleted', ticketId: Number(ticketId), projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      res.json({ ok: true, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket delete error:', err)
      res.status(500).json({ error: 'Failed to delete ticket' })
    }
  })

  // ─── Ticket attachments ─────────────────────────────────────────────────────

  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
    fileFilter: (req, file, cb) => {
      if (isSupportedUploadedFile({ mimetype: file.mimetype, originalname: file.originalname })) {
        cb(null, true)
      } else {
        // Record what was rejected so the route can return a clear error instead
        // of the ambiguous "No file uploaded or file type unsupported".
        ;(req as unknown as { fileRejected?: string }).fileRejected = file.mimetype || file.originalname || 'unknown'
        cb(null, false)
      }
    },
  })

  /** A ticket key is either a numeric real id or a UUID (pendingSpecId). */
  function parseTicketKey(raw: string): { key: string; isPending: boolean } | null {
    if (/^\d+$/.test(raw)) return { key: raw, isPending: false }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return { key: raw, isPending: true }
    }
    return null
  }

  router.post(
    '/:projectId/tickets/:ticketId/attachments',
    attachmentUpload.single('file'),
    async (req: Request, res: Response) => {
      const parsed = parseTicketKey(req.params.ticketId as string)
      if (!parsed) {
        res.status(400).json({ error: 'Invalid ticketId (must be numeric id or UUID)' })
        return
      }
      const file = (req as unknown as { file?: Express.Multer.File }).file
      if (!file) {
        const rejected = (req as unknown as { fileRejected?: string }).fileRejected
        res.status(400).json({ error: rejected ? `Unsupported file type: ${rejected}` : 'No file uploaded' })
        return
      }
      if (!parsed.isPending) {
        const store = readStore(ticketPath(req))
        if (!store.tickets[parsed.key]) {
          res.status(404).json({ error: 'Ticket not found' })
          return
        }
      }
      try {
        const attachment = await attachmentManager.upload({
          slug: ctx(req).project.slug,
          ticketKey: parsed.key,
          ticketStorePath: parsed.isPending ? null : ticketPath(req),
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
        })
        res.status(201).json({ attachment })
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500
        const message = err instanceof Error ? err.message : 'Upload failed'
        console.error('[project-router] attachment upload error:', err)
        res.status(status).json({ error: message })
      }
    },
  )

  router.get('/:projectId/tickets/:ticketId/attachments', (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachments = attachmentManager.list(ctx(req).project.slug, parsed.key)
    res.json({ attachments })
  })

  router.get('/:projectId/tickets/:ticketId/attachments/:attachmentId', (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachmentId = req.params.attachmentId as string
    const slug = ctx(req).project.slug
    const meta = attachmentManager.getMeta(slug, parsed.key, attachmentId)
    const abs = meta ? attachmentManager.getFilePath(slug, parsed.key, attachmentId) : null
    if (!meta || !abs) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }
    res.setHeader('Content-Type', meta.mimeType)
    // Strip quotes AND CR/LF: a newline in the stored (raw) original filename
    // makes Node's setHeader throw ERR_INVALID_CHAR after Content-Type is
    // already set, 500-ing the download. Also emit an RFC 5987 filename* so
    // non-ASCII names survive.
    const asciiName = meta.filename.replace(/[\r\n"]/g, '_')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    )
    fs.createReadStream(abs).pipe(res)
  })

  router.delete('/:projectId/tickets/:ticketId/attachments/:attachmentId', async (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachmentId = req.params.attachmentId as string
    try {
      const ok = await attachmentManager.delete({
        slug: ctx(req).project.slug,
        ticketKey: parsed.key,
        attachmentId,
        ticketStorePath: parsed.isPending ? null : ticketPath(req),
      })
      if (!ok) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[project-router] attachment delete error:', err)
      res.status(500).json({ error: 'Delete failed' })
    }
  })

  router.delete('/:projectId/tickets/:ticketId/attachments', async (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    try {
      await attachmentManager.deleteAll(ctx(req).project.slug, parsed.key)
      res.status(204).end()
    } catch (err) {
      console.error('[project-router] attachment bulk delete error:', err)
      res.status(500).json({ error: 'Bulk delete failed' })
    }
  })

}
