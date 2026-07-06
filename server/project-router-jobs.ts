// Domain routes extracted from project-router.ts (jobs).
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
import { isInteractiveJobsEnabled } from './feature-flags'
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
import { getLoopRun } from './loop-runs-store'
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

export function registerJobsRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
  // ─── Queue / Spawn routes ────────────────────────────────────────────────────

  router.post('/:projectId/spawn', (req: Request, res: Response) => {
    const { command, priority, dependsOnJobId, pipelineId, profileName, aiEngine } = req.body ?? {}
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command is required' })
      return
    }
    if (priority !== undefined && !VALID_PRIORITIES.has(priority)) {
      res.status(400).json({ error: 'priority must be one of: low, normal, high, critical' })
      return
    }
    // profileName accepts: undefined (default resolution), null (force legacy), string (explicit)
    const normalizedProfileName: string | null | undefined =
      profileName === null ? null
        : typeof profileName === 'string' && profileName.trim() ? profileName.trim()
          : undefined
    // aiEngine: optional per-job provider override; must be installed on the
    // project. Omitting it runs on the project's primary provider.
    const engineCheck = validateRequestedProvider(ctx(req).project, aiEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error })
      return
    }
    try {
      const job = ctx(req).queueManager.enqueue(command, (priority as JobPriority) ?? 'normal', {
        dependsOnJobId: dependsOnJobId || undefined,
        pipelineId: pipelineId || undefined,
        profileName: normalizedProfileName,
        provider: aiEngine ? engineCheck.provider : undefined,
      })
      const position = job.queuePosition ?? 0
      res.status(202).json({ jobId: job.id, position })
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        res.status(400).json({ error: err.message })
      } else {
        console.error('[project-router] spawn error:', err)
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  // ─── Pipeline routes ──────────────────────────────────────────────────────────
  // NOTE: Ad-hoc pipeline creation removed — use rails (templates) instead.
  // The GET route remains for viewing existing pipeline status.

  router.get('/:projectId/pipelines/:pipelineId', (req: Request, res: Response) => {
    const { db } = ctx(req)
    const pipelineId = req.params.pipelineId as string
    const jobs = getPipelineJobs(db, pipelineId)
    if (jobs.length === 0) {
      res.status(404).json({ error: 'Pipeline not found' })
      return
    }
    const allCompleted = jobs.every(j => j.status === 'completed')
    const anyFailed = jobs.some(j => ['failed', 'skipped', 'canceled', 'zombie_terminated'].includes(j.status))
    const status = allCompleted ? 'completed' : anyFailed ? 'failed' : 'running'
    res.json({ pipelineId, status, jobs })
  })

  router.get('/:projectId/state', (req: Request, res: Response) => {
    const { queueManager, project } = ctx(req)
    res.json({
      projectName: project.name,
      projectId: project.id,
      phases: getPhaseStates(project.id),
      busy: queueManager.getActiveJobId() !== null,
      currentJobId: queueManager.getActiveJobId(),
      featureFlags: {
        smash: !isSpecsSmashKillSwitchActive(),
      },
    })
  })

  // Returns the resolved default model for Add Spec + the full provider
  // allow-list so the modal can render its picker without maintaining its
  // own copy of the model lists. Source of truth is `server/spec-models.ts`.
  router.get('/:projectId/default-spec-model', (req: Request, res: Response) => {
    const { project } = ctx(req)
    // Multi-provider: an optional ?provider= query selects which engine's models
    // to return. It must be one the project actually has installed; an invalid
    // or omitted value falls back to the project's primary provider. The
    // response also lists every installed provider so the Add Spec modal can
    // render its AI Engine selector without a second round-trip.
    const provider = resolveProvider(project, typeof req.query.provider === 'string' ? req.query.provider : undefined) as SpecProvider
    const model = resolveDefaultSpecModel({ projectPath: project.path, slug: project.slug, provider })
    const allowed = getModelsForProvider(provider)
    res.json({ model, provider, allowed, providers: project.providers })
  })

  router.delete('/:projectId/jobs/:id', (req: Request, res: Response) => {
    const id = req.params.id as string
    const c = ctx(req)
    // A loop run is backed by a job row but is NOT a QueueManager job — it is
    // driven by the LoopRunManager. Cancel it through the engine (which settles
    // it 'stopped' → finishJob('canceled') + releases the rail's tickets).
    if (c.railLoopRuns?.has(id)) {
      c.loopRunManager?.cancel(id)
      res.json({ ok: true, status: 'canceling' })
      return
    }
    try {
      const result = c.queueManager.cancel(id)
      res.json({ ok: true, status: result })
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        // STANDALONE loop runs (railIndex=null, POST /loop-runs) never enter
        // railLoopRuns, so they fall through to the queue and land here while
        // the loop is still executing — cancel through the engine instead of
        // 404ing with a live child (the mission-modal "cancel did nothing" bug).
        const loopRun = getLoopRun(c.db, id)
        if (loopRun && loopRun.status === 'running' && c.loopRunManager) {
          c.loopRunManager.cancel(id)
          res.json({ ok: true, status: 'canceling' })
          return
        }
        res.status(404).json({ error: 'Job not found' })
      } else if (err instanceof JobAlreadyTerminalError) {
        // Job already finished — delete it from the DB
        deleteJob(ctx(req).db, req.params.id as string)
        res.json({ ok: true, status: 'deleted' })
      } else {
        // Surface the real error (name/message/stack) so an unexpected cancel
        // failure — e.g. a Windows kill throw — is identifiable instead of being
        // masked as a bare "Internal server error".
        const e = err as Error
        console.error(`[jobs] cancel ${req.params.id} failed: ${e?.name}: ${e?.message}\n${e?.stack ?? ''}`)
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })

  // ─── Interactive jobs (manager-agnostic) ───────────────────────────────────
  // Send one more user prompt to a running interactive job (queued behind the
  // active turn — see InteractiveJobSession). The job row may be owned by
  // EITHER manager: QueueManager (rail/freestyle/spawned jobs) or
  // LoopRunManager (a loop run's job row, addressed by its ACTIVE step
  // session). Try the queue first, then the loop engine. 202 = accepted;
  // 409 = neither manager has an active interactive session for the id
  // (unknown / non-interactive / finalized / between loop steps).
  router.post('/:projectId/jobs/:id/messages', (req: Request, res: Response) => {
    if (!isInteractiveJobsEnabled()) {
      res.status(403).json({ error: 'Interactive jobs are disabled on this server' })
      return
    }
    const { text } = req.body ?? {}
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    const c = ctx(req)
    const jobId = req.params.id as string
    const accepted = c.queueManager.sendInteractiveTurn(jobId, text)
      || (c.loopRunManager?.sendInteractiveTurn(jobId, text) ?? false)
    if (!accepted) {
      res.status(409).json({ error: 'Job is not an active interactive session' })
      return
    }
    res.status(202).json({ ok: true })
  })

  // Finalize a running interactive job: SIGTERM the resident child; the summed
  // token/cost totals + terminal status are stamped asynchronously when the
  // child closes (the client also learns the final state via the job.finalized
  // WS broadcast). On a QueueManager job this completes the JOB; on a loop
  // run's job it settles the ACTIVE STEP now — the loop advances with what the
  // step produced. 202 = finalize scheduled; 409 = not an active interactive job.
  router.post('/:projectId/jobs/:id/finalize', (req: Request, res: Response) => {
    if (!isInteractiveJobsEnabled()) {
      res.status(403).json({ error: 'Interactive jobs are disabled on this server' })
      return
    }
    const c = ctx(req)
    const jobId = req.params.id as string
    const scheduled = c.queueManager.finalizeInteractive(jobId)
      || (c.loopRunManager?.finalizeInteractive(jobId) ?? false)
    if (!scheduled) {
      res.status(409).json({ error: 'Job is not an active interactive session' })
      return
    }
    res.status(202).json({ ok: true, job: getJob(c.db, jobId) ?? null })
  })

  router.patch('/:projectId/jobs/:id/priority', (req: Request, res: Response) => {
    const { priority } = req.body ?? {}
    if (!priority || !VALID_PRIORITIES.has(priority)) {
      res.status(400).json({ error: 'priority must be one of: low, normal, high, critical' })
      return
    }
    try {
      ctx(req).queueManager.updatePriority(req.params.id as string, priority as JobPriority)
      res.json({ ok: true })
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        res.status(404).json({ error: 'Job not found' })
      } else {
        res.status(400).json({ error: (err as Error).message })
      }
    }
  })

  router.post('/:projectId/queue/pause', (req: Request, res: Response) => {
    ctx(req).queueManager.pause()
    res.json({ ok: true, paused: true })
  })

  router.post('/:projectId/queue/resume', (req: Request, res: Response) => {
    ctx(req).queueManager.resume()
    res.json({ ok: true, paused: false })
  })

  router.put('/:projectId/queue/reorder', (req: Request, res: Response) => {
    const { jobIds } = req.body ?? {}
    if (!Array.isArray(jobIds)) {
      res.status(400).json({ error: 'jobIds must be an array' })
      return
    }
    try {
      ctx(req).queueManager.reorder(jobIds)
      res.json({ ok: true, queue: jobIds })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  router.get('/:projectId/queue', (req: Request, res: Response) => {
    const { queueManager } = ctx(req)
    res.json({
      jobs: queueManager.getJobs(),
      paused: queueManager.isPaused(),
      activeJobId: queueManager.getActiveJobId(),
    })
  })

  router.get('/:projectId/jobs', (req: Request, res: Response) => {
    // Clamp to [1, 200] (H-11): a negative limit is LIMIT -1 in SQLite, which
    // means UNLIMITED — without the lower bound `?limit=-1` dumps the whole table.
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200))
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0
    const status = req.query.status as string | undefined
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const { db } = ctx(req)
    const result = listJobs(db, { limit, offset, status, from, to })

    // Merge in-memory queued jobs that haven't been persisted to DB yet
    const { queueManager } = ctx(req)
    const dbIds = new Set(result.jobs.map((j) => j.id))
    const queuedRows = queueManager
      .getJobs()
      .filter((j) => j.status === 'queued' && !dbIds.has(j.id))
      .filter((j) => !status || j.status === status)
      .map((j) => ({
        id: j.id,
        command: j.command,
        started_at: j.startedAt ?? new Date().toISOString(),
        finished_at: j.finishedAt,
        status: j.status,
        exit_code: j.exitCode,
        queue_position: j.queuePosition,
        priority: j.priority,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        total_cost_usd: null,
        num_turns: null,
        model: null,
        duration_ms: null,
        duration_api_ms: null,
        session_id: null,
        depends_on_job_id: j.dependsOnJobId,
        pipeline_id: j.pipelineId,
        skip_reason: j.skipReason,
      } as import('./types').JobRow))

    if (queuedRows.length > 0) {
      result.jobs = [...queuedRows, ...result.jobs]
      result.total += queuedRows.length
    }

    // Annotate each job with hasTelemetry so the client can show the
    // Export diagnostic button without an extra round trip.
    const jobsWithTelemetry = getJobsWithTelemetry(db)
    const annotatedJobs = result.jobs.map((j) => ({
      ...j,
      hasTelemetry: jobsWithTelemetry.has(j.id),
    }))

    res.json({ jobs: annotatedJobs, total: result.total })
  })

  // ─── CSV helper ──────────────────────────────────────────────────────────────
  const toCsv = (headers: string[], rows: Record<string, unknown>[]): string => {
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers.join(',')]
    for (const row of rows) {
      lines.push(headers.map(h => escape(row[h])).join(','))
    }
    return lines.join('\n')
  }

  // ─── Jobs export (must be before /:projectId/jobs/:id) ─────────────────────
  router.get('/:projectId/jobs/export', (req: Request, res: Response) => {
    const format = (req.query.format as string) || 'json'
    if (format !== 'json' && format !== 'csv') {
      res.status(400).json({ error: 'Invalid format. Must be json or csv' })
      return
    }
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const { db } = ctx(req)
    const conditions: string[] = []
    const params: unknown[] = []
    if (from) { conditions.push('started_at >= ?'); params.push(from) }
    if (to) { conditions.push('started_at <= ?'); params.push(to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const jobs = db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY started_at DESC LIMIT 10000`)
      .all(...params) as JobRow[]
    if (format === 'csv') {
      const headers = ['id', 'command', 'status', 'started_at', 'finished_at', 'duration_ms', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'total_cost_usd', 'model']
      const csv = toCsv(headers, jobs as unknown as Record<string, unknown>[])
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="jobs-export.csv"')
      res.send(csv)
    } else {
      res.json({ jobs })
    }
  })

  // Must be registered BEFORE /:projectId/jobs/:id, otherwise Express matches
  // the parameterized route first with id='compare' and this never runs (the
  // Job Comparison feature would always 404).
  router.get('/:projectId/jobs/compare', (req: Request, res: Response) => {
    const raw = req.query.jobIds as string | undefined
    if (!raw) {
      res.status(400).json({ error: 'jobIds query param required (comma-separated, exactly 2)' })
      return
    }
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length !== 2) {
      res.status(400).json({ error: 'Exactly 2 jobIds are required' })
      return
    }
    const { db } = ctx(req)
    const rows = ids.map((id) => {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as {
        id: string; command: string; status: string; started_at: string; finished_at: string | null
        duration_ms: number | null; tokens_in: number | null; tokens_out: number | null
        tokens_cache_read: number | null; total_cost_usd: number | null; model: string | null
      } | undefined
      if (!job) return null
      const phases = db.prepare(
        "SELECT phase FROM job_phases WHERE job_id = ? AND state = 'done' ORDER BY updated_at ASC"
      ).all(id) as Array<{ phase: string }>
      return {
        id: job.id,
        command: job.command,
        status: job.status,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        durationMs: job.duration_ms,
        tokensIn: job.tokens_in,
        tokensOut: job.tokens_out,
        tokensCacheRead: job.tokens_cache_read,
        totalCostUsd: job.total_cost_usd,
        model: job.model,
        phasesCompleted: phases.map((p) => p.phase),
      }
    })
    const missing = ids.filter((_, i) => rows[i] === null)
    if (missing.length > 0) {
      res.status(404).json({ error: `Jobs not found: ${missing.join(', ')}` })
      return
    }
    res.json({ jobs: rows })
  })

  router.get('/:projectId/jobs/:id', (req: Request, res: Response) => {
    const c = ctx(req)
    const { db, queueManager, project } = c
    const jobId = req.params.id as string
    const job = getJob(db, jobId)
    if (!job) {
      // Queued jobs live only in memory until spawn time (createJob runs on spawn,
      // not enqueue). Fall back to the in-memory queue so /jobs/:id returns a
      // usable payload instead of 404 — the detail page then renders a "queued"
      // state and flips to live logs via WS once the job starts.
      const inMemory = queueManager.getJobs().find((j) => j.id === jobId)
      if (!inMemory) { res.status(404).json({ error: 'Job not found' }); return }
      const synthetic: JobRow = {
        id: inMemory.id,
        command: inMemory.command,
        started_at: inMemory.startedAt ?? '',
        finished_at: inMemory.finishedAt,
        status: inMemory.status,
        exit_code: inMemory.exitCode,
        queue_position: inMemory.queuePosition,
        priority: inMemory.priority,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        total_cost_usd: null,
        num_turns: null,
        model: null,
        duration_ms: null,
        duration_api_ms: null,
        session_id: null,
        depends_on_job_id: inMemory.dependsOnJobId,
        pipeline_id: inMemory.pipelineId,
        skip_reason: inMemory.skipReason,
      }
      const phaseDefinitions = queueManager.phasesForCommand(synthetic.command)
      const tickets = resolveTicketsFromCommand(project.path, synthetic.command, ticketPath(req))
      // Queued ⇒ no resident session yet; the client refetches on the
      // queued→running flip to learn the real interactive surface state.
      res.json({
        job: { ...synthetic, hasTelemetry: false, tickets, interactiveSettleMode: null, interactiveAcceptingTurns: false },
        events: [],
        phaseDefinitions,
      })
      return
    }
    const events = getJobEvents(db, jobId)
    const phaseDefinitions = queueManager.phasesForCommand(job.command)
    const tickets = resolveTicketsFromCommand(project.path, job.command, ticketPath(req))
    // Interactive surface state (S3): the settle mode of the resident session
    // plus whether it is accepting turns RIGHT NOW. A QueueManager job's session
    // lives for the whole run; a loop run's ACTIVE ai-step owns it (absent
    // between steps / decider / shell nodes — POST /messages would 409 there).
    // A between-steps loop GET still reports 'auto' via its loop_runs row so the
    // composer can phrase the waiting state truthfully instead of guessing.
    let interactiveSettleMode: 'finalize' | 'auto' | null = null
    let interactiveAcceptingTurns = false
    if (isInteractiveJobsEnabled() && job.interactive && job.status === 'running') {
      const qmMode = queueManager.getInteractiveSettleMode?.(jobId) ?? null
      const loopStepActive = c.loopRunManager?.isInteractiveJob?.(jobId) ?? false
      interactiveAcceptingTurns = qmMode !== null || loopStepActive
      interactiveSettleMode = qmMode ?? ((loopStepActive || getLoopRun(db, jobId)) ? 'auto' : null)
    }
    const annotated = { ...job, hasTelemetry: hasJobTelemetry(db, jobId), tickets, interactiveSettleMode, interactiveAcceptingTurns }
    res.json({ job: annotated, events, phaseDefinitions })
  })

  router.delete('/:projectId/jobs', (req: Request, res: Response) => {
    try {
      const { from, to } = req.body ?? {}
      const deleted = purgeJobs(ctx(req).db, { from, to })
      res.json({ ok: true, deleted })
    } catch (err) {
      console.error('[project-router] purge error:', err)
      res.status(500).json({ error: 'Failed to purge jobs' })
    }
  })

  router.get('/:projectId/activity', (req: Request, res: Response) => {
    const limit = Math.min(
      Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50),
      100
    )
    const before = req.query.before as string | undefined
    res.json(getProjectActivity(ctx(req).db, { limit, before }))
  })

  router.get('/:projectId/stats', (req: Request, res: Response) => {
    res.json(getStats(ctx(req).db))
  })

  router.get('/:projectId/metrics', (req: Request, res: Response) => {
    const { project, db } = ctx(req)
    try {
      res.json(getProjectMetrics(project.path, db))
    } catch (err) {
      console.error('[project-router] metrics error:', err)
      res.status(500).json({ error: 'Failed to compute metrics' })
    }
  })

}
