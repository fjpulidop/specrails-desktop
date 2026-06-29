// Domain routes extracted from project-router.ts (spending).
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
import { resolveProjectExecution } from './workspace-resolution'
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

export function registerSpendingRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps

  // Build a YAML-store-backed title resolver for getSpending's 4th arg
  // (BUG-ANALYTICS-18/36). Without it, topTickets keeps ticketTitle:null and the
  // client mislabels every live ticket "Deleted ticket #N". Returns undefined
  // when the store can't be read so the legacy null-title shape is preserved.
  function makeTitleResolver(req: Request): ((id: number) => { title: string | null; deleted: boolean }) | undefined {
    let store: { tickets: Record<string, { title?: string }> }
    try {
      store = readStore(ticketPath(req)) as unknown as { tickets: Record<string, { title?: string }> }
    } catch {
      return undefined // tickets store may not exist yet
    }
    return (id: number) => {
      const t = store.tickets[String(id)]
      return { title: t?.title ?? null, deleted: !t }
    }
  }

  // ─── Spending dashboard ──────────────────────────────────────────────────────
  router.get('/:projectId/spending', (req: Request, res: Response) => {
    const filters = parseSpendingFilters(req.query as Record<string, unknown>)
    if (filters.period === 'custom' && (!filters.from || !filters.to)) {
      res.status(400).json({ error: 'from and to are required for custom period' })
      return
    }
    try {
      res.json(getSpending(ctx(req).db, ctx(req).project.id, filters, makeTitleResolver(req)))
    } catch (err) {
      console.error('[project-router] spending error:', err)
      res.status(500).json({ error: 'Failed to compute spending' })
    }
  })

  // ─── Raw invocations table ───────────────────────────────────────────────────
  router.get('/:projectId/invocations', (req: Request, res: Response) => {
    const filters = parseSpendingFilters(req.query as Record<string, unknown>)
    // Clamp to [1, 10000] when provided (H-11): a negative/NaN limit becomes
    // SQLite LIMIT -1 (unlimited) and dumps the entire invocations table.
    const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 10_000))
      : undefined
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined
    try {
      const result = getInvocations(ctx(req).db, ctx(req).project.id, {
        ...filters,
        ...(limit ? { limit } : {}),
        ...(offset ? { offset } : {}),
      })
      // Enrich with ticket titles from YAML store.
      try {
        const store = readStore(ticketPath(req))
        for (const r of result.rows) {
          if (r.ticket_id != null) {
            const t = store.tickets[String(r.ticket_id)]
            r.ticket_title = t?.title ?? null
          }
        }
      } catch { /* tickets store may not exist yet */ }
      // BUG-ANALYTICS-19: getInvocations only sets `truncated` on the `cap` path,
      // so the `limit` path the client uses always reports truncated=false even
      // when rows were withheld. Recompute it from totalAvailable so the client
      // can render the "showing N of M" notice on the only path it uses.
      result.truncated = result.truncated || result.totalAvailable > result.rows.length
      res.json(result)
    } catch (err) {
      console.error('[project-router] invocations error:', err)
      res.status(500).json({ error: 'Failed to list invocations' })
    }
  })

  // ─── Per-ticket spending summary (used by TicketDetailModal) ─────────────────
  router.get('/:projectId/tickets/:id/spending-summary', (req: Request, res: Response) => {
    const ticketId = parseInt(req.params.id as string, 10)
    if (Number.isNaN(ticketId)) {
      res.status(400).json({ error: 'Invalid ticket id' }); return
    }
    try {
      const summary = getTicketSpendingSummary(ctx(req).db, ticketId)
      // BUG-ANALYTICS-36: resolve the ticket title from the YAML store so the
      // modal payload carries a human-readable name (getTicketSpendingSummary
      // takes only db+ticketId and can't read the store itself).
      let ticketTitle: string | null = null
      let isDeleted = false
      try {
        const store = readStore(ticketPath(req)) as unknown as { tickets: Record<string, { title?: string }> }
        const t = store.tickets[String(ticketId)]
        ticketTitle = t?.title ?? null
        isDeleted = !t
      } catch { /* tickets store may not exist yet */ }
      res.json({ ...summary, ticketTitle, isDeleted })
    } catch (err) {
      console.error('[project-router] ticket spending summary error:', err)
      res.status(500).json({ error: 'Failed to compute ticket spending' })
    }
  })

  // ─── Spending / analytics export (Summary + Raw, CSV or JSON) ────────────────
  router.get('/:projectId/analytics/export', async (req: Request, res: Response) => {
    const format = (req.query.format as string) || 'json'
    const mode = (req.query.mode as string) || 'summary'
    if (format !== 'json' && format !== 'csv') {
      res.status(400).json({ error: 'Invalid format. Must be json or csv' })
      return
    }
    if (mode !== 'summary' && mode !== 'raw') {
      res.status(400).json({ error: 'Invalid mode. Must be summary or raw' })
      return
    }
    const periodRaw = (req.query.period as string | undefined) ?? '30d'
    const validPeriods = ['7d', '30d', '90d', 'all', 'custom']
    if (!validPeriods.includes(periodRaw)) {
      res.status(400).json({ error: 'Invalid period. Must be one of: 7d, 30d, 90d, all, custom' })
      return
    }
    const filters = parseSpendingFilters(req.query as Record<string, unknown>)
    if (filters.period === 'custom' && (!filters.from || !filters.to)) {
      res.status(400).json({ error: 'from and to are required for custom period' })
      return
    }
    const { project } = ctx(req)
    const projectId = project.id
    const dateStamp = new Date().toISOString().slice(0, 10)
    const periodTag = filters.period ?? '30d'
    const surfaceTag = (filters.surface && filters.surface.length === 1)
      ? `-${filters.surface[0].replace('-spec', '').replace('-', '')}`
      : ''

    try {
      if (mode === 'summary') {
        // BUG-ANALYTICS-36: inject the YAML-store title resolver so the summary
        // CSV "Top tickets" section (and JSON export) carry human-readable names.
        const data = getSpending(ctx(req).db, projectId, filters, makeTitleResolver(req))
        if (format === 'json') {
          res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-analytics-${periodTag}-${dateStamp}.json"`)
          res.json(data)
          return
        }
        // CSV summary: multi-section composite
        const lines: string[] = []
        lines.push('# Totals')
        lines.push('totalCostUsd,totalRuns,prevTotalCostUsd,deltaPct,avgCostPerRun,failureRate')
        lines.push([
          data.summary.totalCostUsd,
          data.summary.totalRuns,
          data.summary.prevTotalCostUsd,
          data.summary.deltaPct ?? '',
          data.summary.avgCostPerRun ?? '',
          data.summary.failureRate,
        ].join(','))
        lines.push('')
        lines.push('# Daily timeline')
        lines.push('date,jobsCostUsd,quickCostUsd,exploreCostUsd,aiEditCostUsd,smashCostUsd,fileSummaryCostUsd,loopCostUsd,totalCostUsd')
        for (const d of data.dailyTimeline) {
          lines.push(`${d.date},${d.jobsCostUsd},${d.quickCostUsd},${d.exploreCostUsd},${d.aiEditCostUsd},${d.smashCostUsd},${d.fileSummaryCostUsd},${d.loopCostUsd},${d.totalCostUsd}`)
        }
        lines.push('')
        lines.push('# By surface')
        lines.push('surface,count,costUsd')
        for (const s of data.bySurface) lines.push(`${s.surface},${s.count},${s.costUsd}`)
        lines.push('')
        lines.push('# By model')
        lines.push('model,count,costUsd')
        for (const m of data.byModel) lines.push(`${csvEscape(m.model)},${m.count},${m.costUsd}`)
        lines.push('')
        lines.push('# Top tickets')
        // BUG-ANALYTICS-17: emit all 7 surface cost columns (was 4) so they sum to
        // totalCostUsd. BUG-ANALYTICS-36: add a ticketTitle column so the export is
        // reconcilable to a human-readable ticket (topTickets is enriched above).
        lines.push('ticketId,ticketTitle,totalCostUsd,totalRuns,jobCost,quickCost,exploreCost,aiEditCost,smashCost,fileSummaryCost,loopCost')
        for (const t of data.topTickets) {
          lines.push([
            t.ticketId ?? '(unattributed)',
            csvEscape(t.ticketTitle ?? ''),
            t.totalCostUsd,
            t.totalRuns,
            t.bySurface.job.costUsd,
            t.bySurface['quick-spec'].costUsd,
            t.bySurface['explore-spec'].costUsd,
            t.bySurface['ai-edit'].costUsd,
            t.bySurface.smash.costUsd,
            t.bySurface['file-summary'].costUsd,
            t.bySurface.loop.costUsd,
          ].join(','))
        }
        res.setHeader('Content-Type', 'text/csv')
        res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-analytics-${periodTag}-${dateStamp}.csv"`)
        res.send(lines.join('\n'))
      } else {
        // raw mode: capped invocations
        const result = getInvocations(ctx(req).db, projectId, { ...filters, cap: 10000 })
        // Enrich titles
        try {
          const store = readStore(ticketPath(req))
          for (const r of result.rows) {
            if (r.ticket_id != null) r.ticket_title = store.tickets[String(r.ticket_id)]?.title ?? null
          }
        } catch { /* no tickets yet */ }
        if (format === 'json') {
          res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-invocations-${periodTag}${surfaceTag}-${dateStamp}.json"`)
          res.json(result)
          return
        }
        // BUG-ANALYTICS-06: include `provider` and `total_cost_usd_estimated` so a
        // codex/gemini estimated row exports distinguishably from a claude
        // authoritative one (JSON export already carries both). The csvEscape map
        // loop below picks them up from the row object automatically.
        const headers = [
          'id','surface','surface_ref_id','ticket_id','ticket_title','conversation_id',
          'provider','model','status','started_at','finished_at','duration_ms','duration_api_ms',
          'tokens_in','tokens_out','tokens_cache_read','tokens_cache_create',
          'total_cost_usd','total_cost_usd_estimated','num_turns','session_id'
        ]
        const lines = [headers.join(',')]
        for (const r of result.rows) {
          lines.push(headers.map((h) => csvEscape((r as unknown as Record<string, unknown>)[h])).join(','))
        }
        if (result.truncated) {
          lines.push(`# truncated_at=${result.rows.length} of ${result.totalAvailable}`)
        }
        res.setHeader('Content-Type', 'text/csv')
        res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-invocations-${periodTag}${surfaceTag}-${dateStamp}.csv"`)
        res.send(lines.join('\n'))
      }
    } catch (err) {
      console.error('[project-router] export error:', err)
      res.status(500).json({ error: 'Failed to export' })
    }
  })

  function csvEscape(v: unknown): string {
    let s = v == null ? '' : String(v)
    // CSV formula injection: a value starting with = + - @ (or tab/CR) is run as
    // a formula by Excel/Sheets. Neutralize by prefixing a single quote.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  router.get('/:projectId/config', (req: Request, res: Response) => {
    const { project, db } = ctx(req)
    try {
      // Relocate-artifacts: commands are materialized into the workspace when
      // relocated; resolve the gate so the /config commands list is non-empty.
      const cfgExec = resolveProjectExecution({ slug: project.slug, path: project.path })
      const commandsRoot = cfgExec.relocated && cfgExec.workspaceDir ? cfgExec.workspaceDir : project.path
      const config = getConfig(project.path, db, project.name, commandsRoot)
      const dailyBudgetRaw = (db.prepare(`SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`).get() as { value: string } | undefined)?.value
      const dailyBudgetUsd = dailyBudgetRaw != null ? parseFloat(dailyBudgetRaw) : null
      const zombieTimeoutRaw = (db.prepare(`SELECT value FROM queue_state WHERE key = 'config.zombie_timeout_ms'`).get() as { value: string } | undefined)?.value
      const zombieTimeoutMs = zombieTimeoutRaw != null ? parseInt(zombieTimeoutRaw, 10) : null
      res.json({ ...config, dailyBudgetUsd, zombieTimeoutMs })
    } catch (err) {
      console.error('[project-router] config error:', err)
      res.status(500).json({ error: 'Failed to read config' })
    }
  })

  router.post('/:projectId/config', (req: Request, res: Response) => {
    const { active, labelFilter, dailyBudgetUsd, zombieTimeoutMs } = req.body ?? {}
    const { db, queueManager } = ctx(req)
    try {
      if (active !== undefined) {
        db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.active_tracker', ?)`).run(active ?? '')
      }
      if (labelFilter !== undefined) {
        db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.label_filter', ?)`).run(labelFilter ?? '')
      }
      if (dailyBudgetUsd !== undefined) {
        if (dailyBudgetUsd === null) {
          db.prepare(`DELETE FROM queue_state WHERE key = 'config.daily_budget_usd'`).run()
        } else if (typeof dailyBudgetUsd === 'number' && dailyBudgetUsd > 0) {
          db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', ?)`).run(String(dailyBudgetUsd))
        }
      }
      if (zombieTimeoutMs !== undefined) {
        if (zombieTimeoutMs === null) {
          db.prepare(`DELETE FROM queue_state WHERE key = 'config.zombie_timeout_ms'`).run()
        } else if (typeof zombieTimeoutMs === 'number' && zombieTimeoutMs > 0) {
          db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.zombie_timeout_ms', ?)`).run(String(zombieTimeoutMs))
        }
        queueManager.setZombieTimeout(typeof zombieTimeoutMs === 'number' && zombieTimeoutMs > 0 ? zombieTimeoutMs : DEFAULT_ZOMBIE_TIMEOUT_MS)
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[project-router] config persist error:', err)
      res.status(500).json({ error: 'Failed to persist config' })
    }
  })

  // ─── Budget routes ────────────────────────────────────────────────────────────

  router.get('/:projectId/budget', (req: Request, res: Response) => {
    const { db } = ctx(req)
    try {
      const dailyBudgetRaw = (db.prepare(`SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`).get() as { value: string } | undefined)?.value
      const dailyBudgetUsd = dailyBudgetRaw != null ? parseFloat(dailyBudgetRaw) : null
      const jobThresholdRaw = (db.prepare(`SELECT value FROM queue_state WHERE key = 'config.job_cost_threshold_usd'`).get() as { value: string } | undefined)?.value
      const jobCostThresholdUsd = jobThresholdRaw != null ? parseFloat(jobThresholdRaw) : null
      const costRow = db.prepare(
        `SELECT COALESCE(SUM(total_cost_usd), 0) as costToday FROM jobs WHERE started_at >= date('now')`
      ).get() as { costToday: number }
      const costToday = costRow.costToday
      const budgetUtilizationPct = dailyBudgetUsd != null && dailyBudgetUsd > 0
        ? (costToday / dailyBudgetUsd) * 100
        : null
      res.json({ dailyBudgetUsd, jobCostThresholdUsd, costToday, budgetUtilizationPct })
    } catch (err) {
      console.error('[project-router] budget get error:', err)
      res.status(500).json({ error: 'Failed to read budget' })
    }
  })

  router.patch('/:projectId/budget', (req: Request, res: Response) => {
    const { dailyBudgetUsd, jobCostThresholdUsd } = req.body ?? {}
    const { db } = ctx(req)
    try {
      if (dailyBudgetUsd !== undefined) {
        if (dailyBudgetUsd === null) {
          db.prepare(`DELETE FROM queue_state WHERE key = 'config.daily_budget_usd'`).run()
        } else if (typeof dailyBudgetUsd === 'number' && dailyBudgetUsd > 0) {
          db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', ?)`).run(String(dailyBudgetUsd))
        }
      }
      if (jobCostThresholdUsd !== undefined) {
        if (jobCostThresholdUsd === null) {
          db.prepare(`DELETE FROM queue_state WHERE key = 'config.job_cost_threshold_usd'`).run()
        } else if (typeof jobCostThresholdUsd === 'number' && jobCostThresholdUsd > 0) {
          db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.job_cost_threshold_usd', ?)`).run(String(jobCostThresholdUsd))
        }
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[project-router] budget patch error:', err)
      res.status(500).json({ error: 'Failed to update budget' })
    }
  })

  router.get('/:projectId/issues', (req: Request, res: Response) => {
    const { project, db } = ctx(req)
    try {
      const config = getConfig(project.path, db, project.name)
      const tracker = config.issueTracker.active
      if (!tracker) {
        res.status(503).json({ error: 'No issue tracker configured', trackers: config.issueTracker })
        return
      }
      const search = req.query.search as string | undefined
      const label = req.query.label as string | undefined
      const issues = fetchIssues(tracker, { search, label, repo: config.project.repo, cwd: project.path })
      res.json(issues)
    } catch (err) {
      console.error('[project-router] issues error:', err)
      res.status(500).json({ error: 'Failed to fetch issues' })
    }
  })

}
