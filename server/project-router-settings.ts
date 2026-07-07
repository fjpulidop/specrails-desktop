// Domain routes extracted from project-router.ts (settings).
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
  getProjectSettings, updateProjectSettings, normalizeWorktreeEnvPassthrough,
  getQuickContractRefineLast, setQuickContractRefineLast, hasQuickContractRefineLast,
  getTelemetryBlob, getTelemetrySummaries, getJobsWithTelemetry, hasJobTelemetry,
} from './db'
import { createDiagnosticZip } from './telemetry-export'
import { resolveIntegrationBranch, isValidBranchName } from './integration-branch'
import { defaultGitRunner } from './worktree-manager'
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
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
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
import { installConfigPath } from './install-config-path'

export function registerSettingsRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
  // ─── Project settings (pipeline telemetry) ───────────────────────────────────

  router.get('/:projectId/settings', (req: Request, res: Response) => {
    const settings = getProjectSettings(ctx(req).db)
    res.json(settings)
  })

  // ─── Per-project Quick mode Contract Refine last-used value ─────────────────

  router.get('/:projectId/add-spec-quick-contract-refine-last', (req: Request, res: Response) => {
    res.json({
      enabled: getQuickContractRefineLast(ctx(req).db),
      configured: hasQuickContractRefineLast(ctx(req).db),
    })
  })

  router.patch('/:projectId/add-spec-quick-contract-refine-last', (req: Request, res: Response) => {
    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' })
      return
    }
    setQuickContractRefineLast(ctx(req).db, enabled)
    res.json({ enabled: getQuickContractRefineLast(ctx(req).db) })
  })

  // ─── Add Spec context scope ────────────────────────────────────────────────

  router.get('/:projectId/context-budget', (req: Request, res: Response) => {
    const { project } = ctx(req)
    try {
      const budget = getContextBudget(project.id, project.path)
      res.json(budget)
    } catch (err) {
      console.error('[project-router] context-budget failed:', err)
      res.status(500).json({ error: 'failed to compute context budget' })
    }
  })

  router.get('/:projectId/context-scope-last', (req: Request, res: Response) => {
    const scope = getLastContextScope(ctx(req).db, 'explore')
    res.json({ scope })
  })

  router.patch('/:projectId/context-scope-last', (req: Request, res: Response) => {
    const body = req.body
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'body must be an object' })
      return
    }
    // Validate booleans-only for any provided key.
    for (const key of ['specrails', 'openspec', 'full', 'mcp', 'contractRefine', 'userMcp']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        res.status(400).json({ error: `${key} must be a boolean` })
        return
      }
    }
    const current = getLastContextScope(ctx(req).db, 'explore')
    const merged = normalizeContextScope({ ...current, ...body }, current)
    setLastContextScope(ctx(req).db, merged)
    res.json({ scope: merged })
  })

  router.patch('/:projectId/settings', (req: Request, res: Response) => {
    const { pipelineTelemetryEnabled, orchestratorModel, prePrompt, freestylePrePrompt, worktreeEnvPassthrough } = req.body ?? {}
    const patch: Parameters<typeof updateProjectSettings>[1] = {}
    if (pipelineTelemetryEnabled !== undefined) {
      patch.pipelineTelemetryEnabled = Boolean(pipelineTelemetryEnabled)
    }
    const VALID_MODELS = ['sonnet', 'opus', 'haiku']
    if (orchestratorModel !== undefined) {
      if (typeof orchestratorModel !== 'string' || !VALID_MODELS.includes(orchestratorModel)) {
        res.status(400).json({ error: `orchestratorModel must be one of: ${VALID_MODELS.join(', ')}` })
        return
      }
      patch.orchestratorModel = orchestratorModel
    }
    if (prePrompt !== undefined) {
      if (typeof prePrompt !== 'string') {
        res.status(400).json({ error: 'prePrompt must be a string' })
        return
      }
      patch.prePrompt = prePrompt
    }
    if (freestylePrePrompt !== undefined) {
      if (typeof freestylePrePrompt !== 'string') {
        res.status(400).json({ error: 'freestylePrePrompt must be a string' })
        return
      }
      patch.freestylePrePrompt = freestylePrePrompt
    }
    if (worktreeEnvPassthrough !== undefined) {
      try {
        patch.worktreeEnvPassthrough = normalizeWorktreeEnvPassthrough(worktreeEnvPassthrough)
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid worktreeEnvPassthrough' })
        return
      }
    }
    if (req.body?.integrationBranch !== undefined) {
      const ib = req.body.integrationBranch
      if (typeof ib !== 'string') {
        res.status(400).json({ error: 'integrationBranch must be a string' })
        return
      }
      // Empty = clear (auto-resolve). A non-empty value flows into `git worktree
      // add … <base>`, so it must be a safe branch name (no arg-injection).
      if (ib.trim() !== '' && !isValidBranchName(ib)) {
        res.status(400).json({ error: 'integrationBranch is not a valid branch name' })
        return
      }
      patch.integrationBranch = ib
    }
    try {
      updateProjectSettings(ctx(req).db, patch)
      res.json({ ok: true, settings: getProjectSettings(ctx(req).db) })
    } catch (err) {
      console.error('[project-router] settings patch error:', err)
      res.status(500).json({ error: 'Failed to update settings' })
    }
  })

  // Resolve the effective integration branch (configured value + what it resolves
  // to right now + provenance) so the client can show the base before launch.
  router.get('/:projectId/integration-branch', async (req: Request, res: Response) => {
    const { project, db } = ctx(req)
    const configured = getProjectSettings(db).integrationBranch
    try {
      const resolved = await resolveIntegrationBranch(defaultGitRunner, {
        repoDir: project.path,
        projectSetting: configured,
      })
      res.json({ configured, branch: resolved.branch, source: resolved.source })
    } catch (err) {
      console.error('[project-router] integration-branch resolve failed:', err)
      res.status(500).json({ error: 'failed to resolve integration branch' })
    }
  })

  // ─── Agent models ────────────────────────────────────────────────────────────

  router.get('/:projectId/agent-models', (req: Request, res: Response) => {
    const { project } = ctx(req)
    const agents = readAgentModels(project)
    res.json({ agents })
  })

  router.patch('/:projectId/agent-models', (req: Request, res: Response) => {
    const { project } = ctx(req)
    const { defaultModel, overrides } = req.body ?? {}

    // Validate defaultModel if provided
    if (defaultModel !== undefined) {
      if (typeof defaultModel !== 'string' || !(VALID_MODEL_ALIASES as readonly string[]).includes(defaultModel)) {
        res.status(400).json({ error: `Invalid model alias. Must be one of: ${VALID_MODEL_ALIASES.join(', ')}` }); return
      }
    }
    // Validate overrides map if provided
    if (overrides !== undefined) {
      if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) {
        res.status(400).json({ error: 'overrides must be an object' }); return
      }
      for (const [agentName, modelValue] of Object.entries(overrides)) {
        if (typeof modelValue !== 'string' || !(VALID_MODEL_ALIASES as readonly string[]).includes(modelValue)) {
          res.status(400).json({ error: `Invalid model alias for agent "${agentName}". Must be one of: ${VALID_MODEL_ALIASES.join(', ')}` }); return
        }
      }
    }

    // Relocate-artifacts: the install config lives in the per-project HOME dir,
    // NEVER `<project>/.specrails` (which would leak into the user's repo).
    const configPath = installConfigPath(project)

    // Read existing config or build default shape
    let existingConfig: Record<string, unknown> = {
      version: 1,
      provider: 'claude',
      tier: 'quick',
      agents: { selected: [], excluded: [] },
      models: { preset: 'balanced', defaults: { model: 'sonnet' }, overrides: {} },
      agent_teams: false,
    }

    if (fs.existsSync(configPath)) {
      try {
        const text = fs.readFileSync(configPath, 'utf-8')
        // Parse fields we care about from the existing config text
        const versionMatch = text.match(/^version:\s*(\d+)/m)
        const providerMatch = text.match(/^provider:\s*(\S+)/m)
        const tierMatch = text.match(/^tier:\s*(\S+)/m)
        const presetMatch = text.match(/preset:\s*(\S+)/)
        const agentTeamsMatch = text.match(/^agent_teams:\s*(\S+)/m)

        // Parse selected agents list
        const selectedMatch = text.match(/selected:\s*\[([^\]]*)\]/)
        const excludedMatch = text.match(/excluded:\s*\[([^\]]*)\]/)
        const parsedSelected = selectedMatch
          ? selectedMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          : []
        const parsedExcluded = excludedMatch
          ? excludedMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          : []

        // Parse existing overrides to merge
        const existingOverrides: Record<string, string> = {}
        const overridesBlockMatch = text.match(/overrides:([\s\S]*?)(?:\n\S|$)/)
        if (overridesBlockMatch) {
          const block = overridesBlockMatch[1]
          const overrideLines = block.match(/^ {2,}(\S+):\s*(\S+)/gm) ?? []
          for (const line of overrideLines) {
            const m = line.match(/^\s+(\S+):\s*(\S+)/)
            if (m) existingOverrides[m[1]] = m[2]
          }
        }

        existingConfig = {
          version: versionMatch ? parseInt(versionMatch[1], 10) : 1,
          provider: providerMatch ? providerMatch[1] : 'claude',
          tier: tierMatch ? tierMatch[1] : 'quick',
          agents: { selected: parsedSelected, excluded: parsedExcluded },
          models: {
            preset: presetMatch ? presetMatch[1] : 'balanced',
            defaults: { model: 'sonnet' },
            overrides: existingOverrides,
          },
          agent_teams: agentTeamsMatch ? agentTeamsMatch[1] === 'true' : false,
        }
      } catch {
        // use defaults
      }
    }

    // Merge new values into config
    const mergedModels = existingConfig.models as {
      preset: string
      defaults: { model: string }
      overrides: Record<string, string>
    }
    if (defaultModel !== undefined) {
      mergedModels.defaults = { model: defaultModel as ModelAlias }
    }
    if (overrides !== undefined) {
      mergedModels.overrides = overrides as Record<string, string>
    }
    existingConfig.models = mergedModels

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const yaml = serializeInstallConfigYaml(existingConfig)
      fs.writeFileSync(configPath, yaml, 'utf-8')
      applyModelConfig(project)
      const agents = readAgentModels(project)
      res.json({ agents })
    } catch (err) {
      console.error('[project-router] agent-models patch error:', err)
      res.status(500).json({ error: `Failed to apply model config: ${err}` })
    }
  })

  // ─── Diagnostic export ───────────────────────────────────────────────────────

  router.get('/:projectId/jobs/:jobId/diagnostic', async (req: Request, res: Response) => {
    const { db } = ctx(req)
    const jobId = req.params.jobId as string

    const blob = getTelemetryBlob(db, jobId)
    if (!blob) {
      res.status(404).json({ error: 'No telemetry data for this job' })
      return
    }
    if (blob.state === 'expired') {
      res.status(410).json({ error: 'Telemetry data has been expired and is no longer available' })
      return
    }

    const job = getJob(db, jobId)
    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    const summaries = getTelemetrySummaries(db, jobId)
    const events = getJobEvents(db, jobId)

    try {
      const dateStr = new Date().toISOString().slice(0, 10)
      const filename = `specrails-diagnostic-${jobId}-${dateStr}.zip`
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

      const profileRow = db
        .prepare(`SELECT profile_name, profile_json FROM job_profiles WHERE job_id = ?`)
        .get(jobId) as { profile_name: string; profile_json: string } | undefined

      const { homeJobSnapshotPath } = require('./plugins/paths') as typeof import('./plugins/paths')
      const pluginSnap = homeJobSnapshotPath(req.projectCtx!.project.slug, jobId)
      await createDiagnosticZip(res, {
        job,
        blob,
        summaries,
        events,
        profile: profileRow ? { name: profileRow.profile_name, json: profileRow.profile_json } : null,
        pluginSnapshotPath: pluginSnap,
      })
    } catch (err) {
      if (!res.headersSent) {
        console.error('[project-router] diagnostic export error:', err)
        res.status(500).json({ error: 'Failed to create diagnostic export' })
      }
    }
  })

  // ─── Terminal command marks ────────────────────────────────────────────────

  // GET /api/projects/:projectId/terminals/:id/marks?limit=&before=
  router.get('/:projectId/terminals/:id/marks', (req: Request, res: Response) => {
    const projectCtx = ctx(req)
    const sessionId = req.params.id as string
    const limit = parseInt((req.query.limit as string | undefined) ?? '100', 10)
    const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined
    const marks = listMarks(projectCtx.db, sessionId, {
      limit: Number.isFinite(limit) ? limit : 100,
      before: typeof before === 'number' && Number.isFinite(before) ? before : undefined,
    })
    res.json({ marks })
  })

  // ─── Terminal settings (per-project override layer) ────────────────────────

  // GET /api/projects/:projectId/terminal-settings — returns { resolved, override, desktopDefaults }
  router.get('/:projectId/terminal-settings', (req: Request, res: Response) => {
    const projectCtx = ctx(req)
    const desktopDefaults = getDesktopTerminalSettings(registry.desktopDb)
    const override = getProjectOverride(projectCtx.db)
    const resolved = resolveTerminalSettings(registry.desktopDb, projectCtx.db)
    res.json({ resolved, override, desktopDefaults })
  })

  // PATCH /api/projects/:projectId/terminal-settings — partial update of override
  // (null value for a field clears that override)
  router.patch('/:projectId/terminal-settings', (req: Request, res: Response) => {
    const projectCtx = ctx(req)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    try {
      patchProjectOverride(projectCtx.db, req.body as Record<string, unknown>)
      const desktopDefaults = getDesktopTerminalSettings(registry.desktopDb)
      const override = getProjectOverride(projectCtx.db)
      const resolved = resolveTerminalSettings(registry.desktopDb, projectCtx.db)
      res.json({ resolved, override, desktopDefaults })
    } catch (err) {
      if (err instanceof TerminalSettingsValidationError) {
        res.status(400).json({ error: 'validation_failed', field: err.field, message: err.message })
        return
      }
      throw err
    }
  })

}
