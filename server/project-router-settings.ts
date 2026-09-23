// Composition for project settings and the remaining settings-related routes.
// The project-settings module owns its validation, use cases and HTTP adapter.
import { createProjectSettingsService } from './modules/project-settings'
import { createSqliteProjectSettingsRepository } from './modules/project-settings/adapters/sqlite'
import { registerProjectSettingsHttp } from './modules/project-settings/adapters/http'
import fs from 'fs'
import path from 'path'
import { Request, Response } from 'express'
import {
  getJob, getJobEvents, getProjectSettings,
  getQuickContractRefineLast, setQuickContractRefineLast, hasQuickContractRefineLast,
  getTelemetryBlob, getTelemetrySummaries
} from './db'
import { createDiagnosticZip } from './telemetry-export'
import { resolveIntegrationBranch } from './integration-branch'
import { defaultGitRunner } from './worktree-manager'
import { getContextBudget } from './context-budget'
import {
  getLastContextScope, setLastContextScope, normalizeContextScope
} from './context-scope'
import {
  getModelsForProvider,
  getProviderDefault,
  isValidModelForProvider,
  type SpecProvider,
} from './spec-models'
import {
  getDesktopTerminalSettings,
  getProjectOverride,
  patchProjectOverride,
  resolveTerminalSettings,
  TerminalSettingsValidationError,
} from './terminal-settings'
import { listMarks } from './terminal-marks-store'
import {
  type ProjectRoutesDeps,
  type ModelAlias, readAgentModels,
  applyModelConfig,
  serializeInstallConfigYaml
} from './project-router-helpers'
import { installConfigPath } from './install-config-path'
import { registerAgentRuntimeSettingsRoutes } from './agent-runtime-settings-router'
import { registerAgentRuntimeControlRoutes } from './agent-runtime-controls-router'

export function registerSettingsRoutes(deps: ProjectRoutesDeps): void {
  registerAgentRuntimeSettingsRoutes(deps)
  registerAgentRuntimeControlRoutes(deps)
  const { router, registry, ctx } = deps
  // ─── Project settings (pipeline telemetry) ───────────────────────────────────

  registerProjectSettingsHttp(router, req =>
    createProjectSettingsService(createSqliteProjectSettingsRepository(ctx(req).db)),
  )

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
    const provider = (project.provider ?? 'claude') as SpecProvider
    const allowedModels = getModelsForProvider(provider).map((model) => model.value)

    // Validate defaultModel if provided
    if (defaultModel !== undefined) {
      if (!isValidModelForProvider(defaultModel, provider)) {
        res.status(400).json({
          error: `Invalid model alias for provider "${provider}". Catalog: ${allowedModels.join(', ')}`,
        }); return
      }
    }
    // Validate overrides map if provided
    if (overrides !== undefined) {
      if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) {
        res.status(400).json({ error: 'overrides must be an object' }); return
      }
      for (const [agentName, modelValue] of Object.entries(overrides)) {
        if (!isValidModelForProvider(modelValue, provider)) {
          res.status(400).json({
            error:
              `Invalid model alias for agent "${agentName}" and provider "${provider}". ` +
              `Catalog: ${allowedModels.join(', ')}`,
          }); return
        }
      }
    }

    // Relocate-artifacts: the install config lives in the per-project HOME dir,
    // NEVER `<project>/.specrails` (which would leak into the user's repo).
    const configPath = installConfigPath(project)

    // Read existing config or build default shape
    const providerDefault = getProviderDefault(provider) || getProviderDefault('claude')
    let existingConfig: Record<string, unknown> = {
      version: 1,
      provider,
      tier: 'quick',
      agents: { selected: [], excluded: [] },
      models: {
        preset: 'balanced',
        defaults: { model: providerDefault },
        overrides: {},
      },
      agent_teams: false,
    }

    if (fs.existsSync(configPath)) {
      try {
        const text = fs.readFileSync(configPath, 'utf-8')
        // Parse fields we care about from the existing config text
        const versionMatch = text.match(/^version:\s*(\d+)/m)
        const tierMatch = text.match(/^tier:\s*(\S+)/m)
        const presetMatch = text.match(/preset:\s*(\S+)/)
        const defaultModelMatch = text.match(/defaults:\s*\{\s*model:\s*(\S+?)\s*\}/)
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
            if (m && isValidModelForProvider(m[2], provider)) {
              existingOverrides[m[1]] = m[2]
            }
          }
        }

        const parsedDefaultModel = defaultModelMatch?.[1]
        existingConfig = {
          version: versionMatch ? parseInt(versionMatch[1], 10) : 1,
          // The project provider is authoritative. A stale shared config can
          // belong to another provider after a multi-provider setup pass.
          provider,
          tier: tierMatch ? tierMatch[1] : 'quick',
          agents: { selected: parsedSelected, excluded: parsedExcluded },
          models: {
            preset: presetMatch ? presetMatch[1] : 'balanced',
            defaults: {
              model:
                parsedDefaultModel && isValidModelForProvider(parsedDefaultModel, provider)
                  ? parsedDefaultModel
                  : providerDefault,
            },
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
