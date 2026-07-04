// Domain routes extracted from project-router.ts (terminals).
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

export function registerTerminalsRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
  // ─── Terminals ───────────────────────────────────────────────────────────────

  function requireTerminalsEnabled(_req: Request, res: Response, next: NextFunction): void {
    if (!TERMINAL_PANEL_ENABLED) {
      res.status(404).json({ error: 'Terminal panel disabled' })
      return
    }
    next()
  }

  router.get('/:projectId/terminals', requireTerminalsEnabled, (req: Request, res: Response) => {
    const projectId = ctx(req).project.id
    const sessions = getTerminalManager().listForProject(projectId)
    res.json({ sessions, limit: TERMINAL_MAX_PER_PROJECT })
  })

  router.post('/:projectId/terminals', requireTerminalsEnabled, (req: Request, res: Response) => {
    const { cols, rows, name } = req.body ?? {}
    const projectCtx = ctx(req)
    const project = projectCtx.project
    const settings = resolveTerminalSettings(registry.desktopDb, projectCtx.db)
    try {
      const meta = getTerminalManager().create(project.id, {
        cwd: project.path,
        cols: typeof cols === 'number' ? cols : undefined,
        rows: typeof rows === 'number' ? rows : undefined,
        name: typeof name === 'string' ? name : undefined,
        projectSlug: project.slug,
        projectDb: projectCtx.db,
        settings,
      })
      res.status(201).json({ session: meta })
    } catch (err) {
      if (err instanceof TerminalLimitExceededError) {
        res.status(409).json({ error: 'terminal_limit_exceeded', limit: TERMINAL_MAX_PER_PROJECT })
        return
      }
      if (err instanceof TerminalNameInvalidError) {
        res.status(400).json({ error: 'terminal_name_invalid' })
        return
      }
      if (err instanceof TerminalSpawnError) {
        // The shell failed to spawn (commonly the host running out of file
        // descriptors). Surface a concrete, actionable reason — a bare 500 hid
        // this and made the "+" button look like it did nothing.
        console.error('[project-router] terminal spawn failed:', err.reason, err.message)
        res.status(502).json({ error: 'terminal_spawn_failed', reason: err.reason })
        return
      }
      console.error('[project-router] terminal create error:', err)
      res.status(500).json({ error: 'Failed to create terminal' })
    }
  })

  router.patch('/:projectId/terminals/:id', requireTerminalsEnabled, (req: Request, res: Response) => {
    const { name } = req.body ?? {}
    if (typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const projectId = ctx(req).project.id
    try {
      const meta = getTerminalManager().rename(projectId, req.params.id as string, name)
      res.json({ session: meta })
    } catch (err) {
      if (err instanceof TerminalNotFoundError) {
        res.status(404).json({ error: 'terminal_not_found' })
        return
      }
      if (err instanceof TerminalNameInvalidError) {
        res.status(400).json({ error: 'terminal_name_invalid' })
        return
      }
      console.error('[project-router] terminal rename error:', err)
      res.status(500).json({ error: 'Failed to rename terminal' })
    }
  })

  router.delete('/:projectId/terminals/:id', requireTerminalsEnabled, (req: Request, res: Response) => {
    const projectId = ctx(req).project.id
    const ok = getTerminalManager().kill(projectId, req.params.id as string)
    if (!ok) {
      res.status(404).json({ error: 'terminal_not_found' })
      return
    }
    res.json({ ok: true })
  })

  // ─── Embedded browser ("Add Spec from browser") ──────────────────────────────

  function requireBrowserCaptureEnabled(_req: Request, res: Response, next: NextFunction): void {
    if (!isBrowserCaptureEnabled()) {
      res.status(404).json({ error: 'browser_capture_disabled' })
      return
    }
    next()
  }

  function parseRect(raw: unknown): CaptureRect | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const nums = [r.x, r.y, r.width, r.height]
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    const x = r.x as number, y = r.y as number, width = r.width as number, height = r.height as number
    if (width <= 0 || height <= 0) return null
    if (x < 0 || y < 0) return null
    // Upper bound guards against an over-read request far past any real viewport.
    if (x + width > 20000 || y + height > 20000) return null
    return { x, y, width, height }
  }

  // pendingSpecId becomes a filesystem path segment inside attachmentManager
  // (~/.specrails/projects/<slug>/attachments/<pendingSpecId>/). Reject anything
  // that isn't a safe opaque token so a crafted value can't traverse the tree.
  const SAFE_PENDING_ID = /^[A-Za-z0-9_-]{1,128}$/

  router.get('/:projectId/browser/sessions', requireBrowserCaptureEnabled, (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    res.json({ sessions: mgr.listSessions(), lastUrl: mgr.getLastUrl() })
  })

  router.post('/:projectId/browser/sessions', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const initialUrl = typeof req.body?.initialUrl === 'string' ? req.body.initialUrl : undefined
    try {
      const session = await mgr.create({ initialUrl })
      res.status(201).json({ session })
    } catch (err) {
      if (err instanceof BrowserLimitExceededError) {
        res.status(409).json({ error: 'browser_session_limit_exceeded', limit: err.limit })
        return
      }
      if (err instanceof BrowserLaunchError) {
        console.error('[project-router] browser launch failed:', (err.cause as Error)?.message ?? err.message)
        res.status(502).json({ error: 'browser_launch_failed' })
        return
      }
      console.error('[project-router] browser session create error:', err)
      res.status(500).json({ error: 'Failed to create browser session' })
    }
  })

  router.post('/:projectId/browser/sessions/:id/navigate', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const action = req.body?.action ?? 'goto'
    const validActions = new Set(['goto', 'back', 'forward', 'reload'])
    if (!validActions.has(action)) {
      res.status(400).json({ error: 'action must be one of: goto, back, forward, reload' })
      return
    }
    let url: string | undefined
    if (action === 'goto') {
      url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
      if (!url) {
        res.status(400).json({ error: 'url is required for goto' })
        return
      }
      // Only allow web schemes (or bare hosts the manager will https-prefix).
      // Blocks file://, data:, javascript: etc. from reaching the embedded browser.
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: 'only http(s) URLs are allowed' })
        return
      }
    }
    try {
      const result = await mgr.navigate(req.params.id as string, action, url)
      if (!result) {
        res.status(404).json({ error: 'browser_session_not_found' })
        return
      }
      res.json(result)
    } catch (err) {
      console.error('[project-router] browser navigate error:', err)
      res.status(500).json({ error: 'Failed to navigate' })
    }
  })

  router.post('/:projectId/browser/sessions/:id/capture', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const rect = parseRect(req.body?.rect)
    if (!rect) {
      res.status(400).json({ error: 'rect {x,y,width,height} with positive size is required' })
      return
    }
    const pendingSpecId = typeof req.body?.pendingSpecId === 'string' ? req.body.pendingSpecId.trim() : ''
    if (!pendingSpecId) {
      res.status(400).json({ error: 'pendingSpecId is required' })
      return
    }
    if (!SAFE_PENDING_ID.test(pendingSpecId)) {
      res.status(400).json({ error: 'pendingSpecId has an invalid format' })
      return
    }
    const captureNetwork = req.body?.captureNetwork !== false
    try {
      const result = await mgr.capture(req.params.id as string, rect, pendingSpecId, { captureNetwork })
      if (!result) {
        res.status(404).json({ error: 'browser_session_not_found' })
        return
      }
      res.json(result)
    } catch (err) {
      console.error('[project-router] browser capture error:', err)
      res.status(500).json({ error: 'Failed to capture' })
    }
  })

  router.post('/:projectId/browser/sessions/:id/capture-breakpoints', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const rect = parseRect(req.body?.rect)
    if (!rect) {
      res.status(400).json({ error: 'rect {x,y,width,height} with positive size is required' })
      return
    }
    const pendingSpecId = typeof req.body?.pendingSpecId === 'string' ? req.body.pendingSpecId.trim() : ''
    if (!pendingSpecId || !SAFE_PENDING_ID.test(pendingSpecId)) {
      res.status(400).json({ error: 'pendingSpecId is required and must be well-formed' })
      return
    }
    // Validate the per-breakpoint viewport dims (client-supplied; single source).
    const rawDims = req.body?.breakpoints
    const dims: Record<string, { width: number; height: number }> = {}
    if (rawDims && typeof rawDims === 'object') {
      for (const [k, v] of Object.entries(rawDims as Record<string, unknown>)) {
        if (Object.keys(dims).length >= 4) break
        if (!/^[a-z0-9_-]{1,20}$/i.test(k)) continue
        const d = v as { width?: unknown; height?: unknown }
        const w = Math.round(Number(d?.width))
        const h = Math.round(Number(d?.height))
        if (Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1 && w <= 4000 && h <= 4000) {
          dims[k] = { width: w, height: h }
        }
      }
    }
    if (Object.keys(dims).length === 0) {
      res.status(400).json({ error: 'breakpoints {name:{width,height}} is required' })
      return
    }
    const a = req.body?.anchorPoint
    const anchorPoint = a && typeof a.x === 'number' && typeof a.y === 'number'
      ? { x: a.x, y: a.y }
      : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    try {
      const result = await mgr.captureBreakpoints(req.params.id as string, rect, anchorPoint, pendingSpecId, dims)
      if (!result) {
        res.status(404).json({ error: 'browser_session_not_found' })
        return
      }
      res.json(result)
    } catch (err) {
      console.error('[project-router] browser capture-breakpoints error:', err)
      res.status(500).json({ error: 'Failed to capture' })
    }
  })

  router.post('/:projectId/browser/sessions/:id/element', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const selector = typeof req.body?.selector === 'string' ? req.body.selector : ''
    const direction = req.body?.direction
    if (!selector || (direction !== 'parent' && direction !== 'child' && direction !== 'self')) {
      res.status(400).json({ error: 'selector and direction (parent|child|self) are required' })
      return
    }
    try {
      // probe may be null (can't step further / element gone) — still 200.
      const probe = await mgr.navigateElement(req.params.id as string, selector.slice(0, 4000), direction)
      res.json({ probe })
    } catch (err) {
      console.error('[project-router] browser element navigate error:', err)
      res.status(500).json({ error: 'Failed to resolve element' })
    }
  })

  router.post('/:projectId/browser/sessions/:id/clipboard', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const action = req.body?.action
    if (action !== 'copy' && action !== 'paste' && action !== 'cut') {
      res.status(400).json({ error: 'action must be copy | paste | cut' })
      return
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 100_000) : undefined
    try {
      const out = await mgr.clipboard(req.params.id as string, action, text)
      if (!out) {
        res.status(404).json({ error: 'browser_session_not_found' })
        return
      }
      res.json(out)
    } catch (err) {
      console.error('[project-router] browser clipboard error:', err)
      res.status(500).json({ error: 'Failed clipboard op' })
    }
  })

  // Switch the viewed page between the root page and the top popup (OAuth login
  // window). Low-rate UI action → REST, not the WS control channel.
  router.post('/:projectId/browser/sessions/:id/popup-view', requireBrowserCaptureEnabled, (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const target = req.body?.target
    if (target !== 'root' && target !== 'popup') {
      res.status(400).json({ error: 'target must be root | popup' })
      return
    }
    const ok = mgr.setPopupView(req.params.id as string, target)
    if (!ok) {
      res.status(404).json({ error: 'browser_session_not_found' })
      return
    }
    res.json({ ok: true })
  })

  router.delete('/:projectId/browser/sessions/:id', requireBrowserCaptureEnabled, async (req: Request, res: Response) => {
    const mgr = ctx(req).browserCaptureManager
    const ok = await mgr.kill(req.params.id as string)
    if (!ok) {
      res.status(404).json({ error: 'browser_session_not_found' })
      return
    }
    res.json({ ok: true })
  })

}
