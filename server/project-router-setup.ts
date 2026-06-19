// Domain routes extracted from project-router.ts (setup).
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
import { resolveProjectExecution } from './workspace-resolution'

export function registerSetupRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
  // ─── Install-config route ─────────────────────────────────────────────────────

  router.post('/:projectId/setup/install-config', (req: Request, res: Response) => {
    const { project } = ctx(req)
    const config = req.body ?? {}
    if (typeof config !== 'object' || Array.isArray(config)) {
      res.status(400).json({ error: 'Request body must be a config object' }); return
    }
    // Relocate-artifacts: write to the per-project app-managed HOME dir, NEVER
    // `<project>/.specrails` — so a fresh setup creates ZERO `.specrails` in the
    // user's repo. See server/install-config-path.ts.
    const configPath = installConfigPath(project)
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const yaml = serializeInstallConfigYaml(config as Record<string, unknown>)
      fs.writeFileSync(configPath, yaml, 'utf-8')
      res.json({ ok: true, path: configPath })
    } catch (err) {
      res.status(500).json({ error: `Failed to write install-config.yaml: ${err}` })
    }
  })

  // ─── Enrich routes (v3) + Setup aliases (v1/v2 backward compat) ──────────────

  router.post('/:projectId/setup/install', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    if (setupManager.isInstalling(project.id)) {
      res.status(409).json({ error: 'Install already in progress' }); return
    }
    res.status(202).json({ ok: true })
    setupManager.startInstall(project.id, project.path, project.slug)
  })

  router.post('/:projectId/enrich/start', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    if (setupManager.isEnriching(project.id)) {
      res.status(409).json({ error: 'Enrich already in progress' }); return
    }
    res.status(202).json({ ok: true })
    setupManager.startEnrich(project.id, project.path, project.provider)
  })

  // Legacy alias: /setup/start → /enrich/start
  router.post('/:projectId/setup/start', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    if (setupManager.isEnriching(project.id)) {
      res.status(409).json({ error: 'Setup already in progress' }); return
    }
    res.status(202).json({ ok: true })
    setupManager.startEnrich(project.id, project.path, project.provider)
  })

  router.post('/:projectId/enrich/message', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    const { sessionId, message } = req.body ?? {}
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' }); return
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' }); return
    }
    if (setupManager.isEnriching(project.id)) {
      res.status(409).json({ error: 'Enrich already in progress' }); return
    }
    res.status(202).json({ ok: true })
    setupManager.resumeEnrich(project.id, project.path, sessionId, message.trim(), project.provider)
  })

  // Legacy alias: /setup/message → /enrich/message
  router.post('/:projectId/setup/message', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    const { sessionId, message } = req.body ?? {}
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' }); return
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' }); return
    }
    if (setupManager.isEnriching(project.id)) {
      res.status(409).json({ error: 'Setup already in progress' }); return
    }
    res.status(202).json({ ok: true })
    setupManager.resumeEnrich(project.id, project.path, sessionId, message.trim(), project.provider)
  })

  router.get('/:projectId/setup/checkpoints', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    const checkpoints = setupManager.getCheckpointStatus(project.id, project.path)
    const savedSessionId = getProjectSetupSession(registry.desktopDb, project.id)
    res.json({
      checkpoints,
      isInstalling: setupManager.isInstalling(project.id),
      isSettingUp: setupManager.isEnriching(project.id),
      isEnriching: setupManager.isEnriching(project.id),
      tier: setupManager.getInstallTier(project.id) ?? null,
      savedSessionId: savedSessionId ?? null,
      logLines: setupManager.getInstallLog(project.id),
      summary: setupManager.getSummary(project),
    })
  })

  router.post('/:projectId/setup/abort', (req: Request, res: Response) => {
    const { project, setupManager } = ctx(req)
    setupManager.abort(project.id)
    res.json({ ok: true })
  })

  // ─── Proposal routes ──────────────────────────────────────────────────────

  router.get('/:projectId/propose', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100)
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
    const result = listProposals(ctx(req).db, { limit, offset })
    res.json(result)
  })

  router.post('/:projectId/propose', async (req: Request, res: Response) => {
    const { idea } = req.body ?? {}
    if (!idea || typeof idea !== 'string' || !idea.trim()) {
      res.status(400).json({ error: 'idea is required' }); return
    }
    // Pre-check: does the propose-feature command exist in this project?
    const testCmd = `/specrails:propose-feature test`
    const resolved = resolveCommand(testCmd, ctx(req).project.path)
    if (resolved === testCmd) {
      res.status(400).json({ error: 'This project does not have the /specrails:propose-feature command installed. Run "npx specrails-core@latest" to update.' }); return
    }
    const id = uuidv4()
    createProposal(ctx(req).db, { id, idea: idea.trim() })
    res.status(202).json({ proposalId: id })
    ctx(req).proposalManager.startExploration(id, idea.trim()).catch((err) => {
      console.error('[project-router] proposal startExploration error:', err)
    })
  })

  router.get('/:projectId/propose/:id', (req: Request, res: Response) => {
    const proposal = getProposal(ctx(req).db, req.params.id as string)
    if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
    res.json({ proposal })
  })

  router.post('/:projectId/propose/:id/refine', async (req: Request, res: Response) => {
    const proposal = getProposal(ctx(req).db, req.params.id as string)
    if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
    const { feedback } = req.body ?? {}
    if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
      res.status(400).json({ error: 'feedback is required' }); return
    }
    if (ctx(req).proposalManager.isActive(req.params.id as string)) {
      res.status(409).json({ error: 'PROPOSAL_BUSY' }); return
    }
    if (proposal.status !== 'review') {
      res.status(409).json({ error: 'Proposal is not in review state' }); return
    }
    res.status(202).json({ ok: true })
    ctx(req).proposalManager.sendRefinement(req.params.id as string, feedback.trim()).catch((err) => {
      console.error('[project-router] proposal sendRefinement error:', err)
    })
  })

  router.post('/:projectId/propose/:id/create-issue', async (req: Request, res: Response) => {
    const proposal = getProposal(ctx(req).db, req.params.id as string)
    if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
    if (ctx(req).proposalManager.isActive(req.params.id as string)) {
      res.status(409).json({ error: 'PROPOSAL_BUSY' }); return
    }
    if (proposal.status !== 'review') {
      res.status(409).json({ error: 'Proposal is not in review state' }); return
    }
    res.status(202).json({ ok: true })
    ctx(req).proposalManager.createIssue(req.params.id as string).catch((err) => {
      console.error('[project-router] proposal createIssue error:', err)
    })
  })

  router.delete('/:projectId/propose/:id', (req: Request, res: Response) => {
    const proposal = getProposal(ctx(req).db, req.params.id as string)
    if (!proposal) { res.status(404).json({ error: 'Proposal not found' }); return }
    ctx(req).proposalManager.cancel(req.params.id as string)
    res.json({ ok: true })
  })

  // ─── Feature Funnel ─────────────────────────────────────────────────────────

  router.get('/:projectId/changes', (req: Request, res: Response) => {
    const { project, queueManager } = ctx(req)
    const activeCommands = queueManager.getJobs()
      .filter((j) => j.status === 'running' || j.status === 'queued')
      .map((j) => j.command)
    const changes = readChanges(project.path, activeCommands)
    res.json({ changes })
  })

  // ─── Change Artifact Browser ─────────────────────────────────────────────────

  const ALLOWED_ARTIFACTS = new Set(['proposal.md', 'design.md', 'tasks.md', 'delta-spec.md', 'context-bundle.md'])

  router.get('/:projectId/changes/:changeId/artifacts/:artifact', (req: Request, res: Response) => {
    const changeId = req.params.changeId as string
    const artifact = req.params.artifact as string
    if (!ALLOWED_ARTIFACTS.has(artifact)) {
      res.status(400).json({ error: 'Invalid artifact name' }); return
    }
    // Sanitize changeId to prevent path traversal
    if (!/^[\w-]+$/.test(changeId)) {
      res.status(400).json({ error: 'Invalid change ID' }); return
    }
    const { project } = ctx(req)
    const changesRoot = path.join(project.path, 'openspec', 'changes')
    // Check active dir first, then archive
    let filePath = path.join(changesRoot, changeId, artifact)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(changesRoot, 'archive', changeId, artifact)
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Artifact not found' }); return
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      res.json({ content, artifact, changeId })
    } catch {
      res.status(500).json({ error: 'Failed to read artifact' })
    }
  })

  // ─── Spec Launcher ───────────────────────────────────────────────────────────

  router.post('/:projectId/spec-launcher/start', (req: Request, res: Response) => {
    const { description } = req.body ?? {}
    if (!description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'description is required' }); return
    }
    const launchId = uuidv4()
    res.status(202).json({ launchId })
    ctx(req).specLauncherManager.launch(launchId, description.trim()).catch((err) => {
      console.error('[project-router] spec-launcher error:', err)
    })
  })

  router.delete('/:projectId/spec-launcher/:launchId', (req: Request, res: Response) => {
    const { specLauncherManager } = ctx(req)
    if (!specLauncherManager.isActive(req.params.launchId as string)) {
      res.status(404).json({ error: 'No active launch with that ID' }); return
    }
    specLauncherManager.cancel(req.params.launchId as string)
    res.json({ ok: true })
  })

  // ─── Job Templates ────────────────────────────────────────────────────────

  function templateToPublic(row: ReturnType<typeof getTemplate>): JobTemplate | null {
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      commands: JSON.parse(row.commands) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  router.get('/:projectId/templates', (req: Request, res: Response) => {
    const rows = listTemplates(ctx(req).db)
    const templates = rows.map((r) => templateToPublic(r)!)
    res.json({ templates })
  })

  router.post('/:projectId/templates', (req: Request, res: Response) => {
    const { name, description, commands } = req.body ?? {}
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' }); return
    }
    if (!Array.isArray(commands) || commands.length === 0) {
      res.status(400).json({ error: 'commands must be a non-empty array' }); return
    }
    if (commands.some((c: unknown) => typeof c !== 'string' || !String(c).trim())) {
      res.status(400).json({ error: 'each command must be a non-empty string' }); return
    }
    const id = uuidv4()
    try {
      createTemplate(ctx(req).db, {
        id,
        name: name.trim(),
        description: description && typeof description === 'string' ? description.trim() : undefined,
        commands: commands.map((c: string) => c.trim()),
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('UNIQUE constraint failed')) {
        res.status(409).json({ error: 'A template with that name already exists' }); return
      }
      console.error('[project-router] create template error:', err)
      res.status(500).json({ error: 'Internal server error' }); return
    }
    const created = templateToPublic(getTemplate(ctx(req).db, id))!
    res.status(201).json({ template: created })
  })

  router.get('/:projectId/templates/:templateId', (req: Request, res: Response) => {
    const row = getTemplate(ctx(req).db, req.params.templateId as string)
    if (!row) { res.status(404).json({ error: 'Template not found' }); return }
    res.json({ template: templateToPublic(row)! })
  })

  router.patch('/:projectId/templates/:templateId', (req: Request, res: Response) => {
    const { db } = ctx(req)
    const templateId = req.params.templateId as string
    const row = getTemplate(db, templateId)
    if (!row) { res.status(404).json({ error: 'Template not found' }); return }
    const { name, description, commands } = req.body ?? {}
    const patch: { name?: string; description?: string | null; commands?: string[] } = {}
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' }); return
      }
      patch.name = name.trim()
    }
    if (description !== undefined) {
      patch.description = description === null ? null : String(description).trim() || null
    }
    if (commands !== undefined) {
      if (!Array.isArray(commands) || commands.length === 0) {
        res.status(400).json({ error: 'commands must be a non-empty array' }); return
      }
      if (commands.some((c: unknown) => typeof c !== 'string' || !String(c).trim())) {
        res.status(400).json({ error: 'each command must be a non-empty string' }); return
      }
      patch.commands = commands.map((c: string) => c.trim())
    }
    try {
      updateTemplate(db, templateId, patch)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('UNIQUE constraint failed')) {
        res.status(409).json({ error: 'A template with that name already exists' }); return
      }
      console.error('[project-router] update template error:', err)
      res.status(500).json({ error: 'Internal server error' }); return
    }
    const updated = templateToPublic(getTemplate(db, templateId))!
    res.json({ ok: true, template: updated })
  })

  router.delete('/:projectId/templates/:templateId', (req: Request, res: Response) => {
    const { db } = ctx(req)
    const row = getTemplate(db, req.params.templateId as string)
    if (!row) { res.status(404).json({ error: 'Template not found' }); return }
    deleteTemplate(db, req.params.templateId as string)
    res.json({ ok: true })
  })

  router.post('/:projectId/templates/:templateId/run', (req: Request, res: Response) => {
    const { db, queueManager } = ctx(req)
    const row = getTemplate(db, req.params.templateId as string)
    if (!row) { res.status(404).json({ error: 'Template not found' }); return }
    const commands = JSON.parse(row.commands) as string[]
    const chain = req.body?.chain !== false // default: chain jobs as pipeline
    const jobIds: string[] = []
    try {
      const pipelineId = chain && commands.length > 1 ? uuidv4() : undefined
      let prevJobId: string | null = null
      for (const command of commands) {
        const job = queueManager.enqueue(command, 'normal', {
          dependsOnJobId: chain ? (prevJobId ?? undefined) : undefined,
          pipelineId,
        })
        jobIds.push(job.id)
        prevJobId = job.id
      }
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        res.status(400).json({ error: err.message }); return
      }
      console.error('[project-router] template run error:', err)
      res.status(500).json({ error: 'Internal server error' }); return
    }
    res.status(202).json({ ok: true, jobIds, templateId: row.id, templateName: row.name })
  })

  // ─── Integration contract ──────────────────────────────────────────────────

  const DEFAULT_TICKET_CAPABILITIES = ['crud', 'labels', 'status', 'priorities', 'dependencies']

  // GET /:projectId/integration-contract — Return the project's integration contract with ticketProvider
  router.get('/:projectId/integration-contract', (req: Request, res: Response) => {
    const project = ctx(req).project
    const projectPath = project.path
    // Relocate-artifacts: the integration-contract.json + tickets store live in
    // the workspace when relocated. Mirror the gated ticketPath() so this
    // informational endpoint reports the path the relocated CLI actually loads,
    // not a stale repo path. Legacy projects are byte-identical.
    const exec = resolveProjectExecution({ slug: project.slug, path: projectPath })
    const contractRoot = exec.relocated && exec.workspaceDir ? exec.workspaceDir : projectPath
    const contractFile = path.join(contractRoot, '.claude', 'integration-contract.json')
    let rawContract: Record<string, unknown> = {}
    let source: 'contract' | 'default' = 'default'

    if (fs.existsSync(contractFile)) {
      try {
        rawContract = JSON.parse(fs.readFileSync(contractFile, 'utf-8'))
        source = 'contract'
      } catch {
        // malformed contract — fall back to defaults
      }
    }

    const rawProvider = rawContract.ticketProvider as { type?: string; storagePath?: string; capabilities?: string[] } | undefined
    // When relocated, the tickets store is the registry entry's ticketsPath (an
    // absolute workspace path); a custom storagePath from the contract is still
    // resolved relative to the contract root. Legacy ⇒ ticketPath() (which
    // honours the contract's custom storagePath).
    const storagePath = rawProvider?.storagePath
    const resolvedStorage = storagePath
      ? path.resolve(contractRoot, storagePath)
      : ticketPath(req)
    const ticketProvider = {
      type: rawProvider?.type ?? 'local',
      storagePath: resolvedStorage,
      capabilities: rawProvider?.capabilities ?? DEFAULT_TICKET_CAPABILITIES,
    }

    res.json({ ticketProvider, source })
  })

}
