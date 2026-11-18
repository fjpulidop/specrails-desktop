/**
 * App-level settings routes: general settings, budgets and caps, terminal
 * defaults, UI theme and language, code-explorer summaries, Specrails Agents
 * defaults and the user's external MCP servers.
 *
 * Every value lives in `desktop_settings` (desktop.sqlite); changes that
 * running agent sessions depend on notify the registry.
 */
import type { Router } from 'express'
import { parseSubagentRuntimeSetting } from './modules/project-settings'
import type { ProjectRegistry } from './project-registry'
import { GLOBAL_ALLOW_SUBAGENTS_KEY, getDesktopSetting, getGlobalAllowSubagents, getGlobalSubagentRuntime, setGlobalSubagentRuntime, setDesktopSetting, getUpdateChannel, setUpdateChannel } from './desktop-db'
import { DESKTOP_CAP_KEYS, readDesktopCaps } from './modules/execution/adapters/budget-storage'
import { readSpendOverview } from './modules/execution/runtime/budget-overview'
import { isUpdateChannel } from './update-channel'
import { getDesktopTodayStats } from './modules/accounting/runtime/desktop-analytics'
import {
  AgentDefaultsValidationError,
  applyAgentDefaultsPatch,
  buildAgentDefaultsCatalog,
  readAgentDefaultsSettings,
} from './modules/agents/runtime/agent-defaults'
import {
  ExternalMcpValidationError,
  applyExternalMcpPatch,
  discoverExternalMcp,
  readExternalMcpSettings,
  resolveExternalEntries,
} from './external-mcp'
import { ConnectorSettingsValidationError } from './modules/missions/runtime/mission-connectors'
import type { MissionConnectors } from './modules/missions/runtime/mission-connectors-discovery'
import {
  getDesktopTerminalSettings,
  patchDesktopTerminalSettings,
  TerminalSettingsValidationError,
} from './modules/terminals/runtime/terminal-settings'
import { validateHttpUrl } from './desktop-router-url-validation'

// Theme allow-list. Mirror of THEME_IDS in `client/src/features/settings/lib/themes.ts` —
// kept duplicated to avoid pulling client code into the server bundle.
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'specrails', 'galaxy'])
const LEGACY_THEME_ID_MAP: Record<string, string> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}

// Language allow-list. Mirror of LANGUAGE_IDS in `client/src/lib/i18n.ts` —
// kept duplicated to avoid pulling client code into the server bundle.
const LANGUAGE_ID_ALLOWLIST = new Set<string>(['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])

export function registerAppSettingsRoutes(router: Router, deps: { registry: ProjectRegistry; missionConnectors?: MissionConnectors }): void {
  registerGeneralSettingsRoutes(router, deps.registry)
  registerBudgetRoutes(router, deps.registry)
  registerUiPreferenceRoutes(router, deps.registry)
  registerAgentDefaultsRoutes(router, deps.registry)
  if (deps.missionConnectors) registerMissionConnectorRoutes(router, deps.registry, deps.missionConnectors)
}

/**
 * `/mission-connectors`: each provider's own connectors with a toggle each
 * (app-wide deny-list; new connectors start enabled). GET reads the cached
 * discovery (`?refresh=1` re-detects); POST `/measure` sizes the tool
 * definitions of stdio servers; PATCH flips one toggle. A change applies on
 * the next mission turn.
 */
function registerMissionConnectorRoutes(router: Router, registry: ProjectRegistry, connectors: MissionConnectors): void {
  const injected = (provider: string): string[] => resolveExternalEntries(provider, registry.desktopDb).map((server) => server.name)
  const view = (refresh: boolean) => connectors.view({ refresh, injected })

  router.get('/mission-connectors', async (req, res) => {
    try {
      res.json(await view(req.query.refresh === '1' || req.query.refresh === 'true'))
    } catch (err) {
      res.status(500).json({ error: 'mission_connectors_failed', message: (err as Error).message })
    }
  })

  router.post('/mission-connectors/measure', async (_req, res) => {
    try {
      await connectors.measure()
      res.json(await view(false))
    } catch (err) {
      res.status(500).json({ error: 'mission_connectors_failed', message: (err as Error).message })
    }
  })

  router.patch('/mission-connectors', async (req, res) => {
    try {
      connectors.toggle(req.body)
      res.json(await view(false))
    } catch (err) {
      if (err instanceof ConnectorSettingsValidationError) {
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      res.status(500).json({ error: 'mission_connectors_failed', message: (err as Error).message })
    }
  })
}

/** `/settings`: port, specrails-tech URL, cost alert, sub-agent policy, update channel. */
function registerGeneralSettingsRoutes(router: Router, registry: ProjectRegistry): void {
  // GET /api/settings — get app-level settings
  router.get('/settings', (_req, res) => {
    const port = getDesktopSetting(registry.desktopDb, 'port') ?? '4200'
    const specrailsTechUrl =
      getDesktopSetting(registry.desktopDb, 'specrails_tech_url') ??
      process.env.SPECRAILS_TECH_URL ??
      'http://localhost:3000'
    const costAlertThresholdRaw = getDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd')
    const costAlertThresholdUsd = costAlertThresholdRaw != null ? parseFloat(costAlertThresholdRaw) : null
    const allowSubagents = getGlobalAllowSubagents(registry.desktopDb)
    res.json({ port: parseInt(port, 10), specrailsTechUrl, costAlertThresholdUsd, allowSubagents, subagentRuntime: getGlobalSubagentRuntime(registry.desktopDb), updateChannel: getUpdateChannel(registry.desktopDb) })
  })

  // PUT /api/settings — update app-level settings
  router.put('/settings', (req, res) => {
    const { port, specrailsTechUrl, costAlertThresholdUsd, allowSubagents, updateChannel } = req.body ?? {}
    if (allowSubagents !== undefined && typeof allowSubagents !== 'boolean') {
      res.status(400).json({ error: 'allowSubagents must be a boolean' })
      return
    }
    if (updateChannel !== undefined && !isUpdateChannel(updateChannel)) {
      res.status(400).json({ error: 'updateChannel must be "latest" or "stable"' })
      return
    }
    let subagentRuntime: ReturnType<typeof parseSubagentRuntimeSetting> | undefined
    if (req.body?.subagentRuntime !== undefined) {
      try { subagentRuntime = parseSubagentRuntimeSetting(req.body.subagentRuntime) } catch (error) {
        res.status(400).json({ error: (error as Error).message })
        return
      }
    }
    if (port !== undefined) {
      const n = Number(port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        res.status(400).json({ error: 'port must be an integer between 1 and 65535' })
        return
      }
      setDesktopSetting(registry.desktopDb, 'port', String(n))
    }
    if (specrailsTechUrl !== undefined && typeof specrailsTechUrl === 'string') {
      const normalized = validateHttpUrl(specrailsTechUrl.trim(), {
        allowLoopback: true,
        requireHttps: false,
      })
      if (!normalized) {
        res.status(400).json({ error: 'specrailsTechUrl must be a valid http(s) URL' })
        return
      }
      setDesktopSetting(registry.desktopDb, 'specrails_tech_url', normalized)
    }
    if (costAlertThresholdUsd !== undefined) {
      if (costAlertThresholdUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('cost_alert_threshold_usd')
      } else if (typeof costAlertThresholdUsd === 'number' && costAlertThresholdUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd', String(costAlertThresholdUsd))
      }
    }
    if (allowSubagents !== undefined) {
      const previous = getGlobalAllowSubagents(registry.desktopDb)
      setDesktopSetting(registry.desktopDb, GLOBAL_ALLOW_SUBAGENTS_KEY, allowSubagents ? 'true' : 'false')
      // Project-less missions re-read their sub-agent policy.
      if (previous !== allowSubagents) registry.notifySettingsChanged({ projectId: null })
    }
    if (subagentRuntime !== undefined) {
      const previous = JSON.stringify(getGlobalSubagentRuntime(registry.desktopDb))
      setGlobalSubagentRuntime(registry.desktopDb, subagentRuntime)
      if (previous !== JSON.stringify(subagentRuntime)) registry.notifySettingsChanged({ projectId: null })
    }
    if (updateChannel !== undefined) setUpdateChannel(registry.desktopDb, updateChannel)
    res.json({ ok: true })
  })
}

/** `/budget` and `/budget/caps`: app-wide daily/weekly/monthly/run caps. */
function registerBudgetRoutes(router: Router, registry: ProjectRegistry): void {
  // ─── Budget routes ────────────────────────────────────────────────────────────

  // GET /api/budget — get app-level budget status
  router.get('/budget', (_req, res) => {
    const desktopDailyBudgetRaw = getDesktopSetting(registry.desktopDb, 'desktop_daily_budget_usd')
    const desktopDailyBudgetUsd = desktopDailyBudgetRaw != null ? parseFloat(desktopDailyBudgetRaw) : null
    const costAlertRaw = getDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd')
    const costAlertThresholdUsd = costAlertRaw != null ? parseFloat(costAlertRaw) : null
    const { costToday, pricedRuns, unpricedRuns } = getDesktopTodayStats(registry)
    const budgetUtilizationPct =
      desktopDailyBudgetUsd != null && desktopDailyBudgetUsd > 0 && unpricedRuns === 0
      ? (costToday / desktopDailyBudgetUsd) * 100
      : null
    const caps = readDesktopCaps((key) => getDesktopSetting(registry.desktopDb, key))
    res.json({
      desktopDailyBudgetUsd,
      desktopWeeklyBudgetUsd: caps.week,
      desktopMonthlyBudgetUsd: caps.month,
      runCapUsd: caps.run,
      costAlertThresholdUsd,
      costToday,
      pricedRuns,
      unpricedRuns,
      budgetUtilizationPct,
    })
  })

  // PATCH /api/budget — update app-level budget settings
  router.patch('/budget', (req, res) => {
    const { desktopDailyBudgetUsd, costAlertThresholdUsd } = req.body ?? {}
    // Caps beyond the daily budget (CD5): null clears, a number > 0 sets, anything else is a 400.
    const capFields: Array<[string, string]> = [['desktopWeeklyBudgetUsd', DESKTOP_CAP_KEYS.week], ['desktopMonthlyBudgetUsd', DESKTOP_CAP_KEYS.month], ['runCapUsd', DESKTOP_CAP_KEYS.run]]
    for (const [field] of capFields) {
      const value = (req.body ?? {})[field]
      if (value !== undefined && value !== null && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
        res.status(400).json({ error: 'invalid_cap', field }); return
      }
    }
    for (const [field, key] of capFields) {
      const value = (req.body ?? {})[field]
      if (value === null) registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run(key)
      else if (typeof value === 'number') setDesktopSetting(registry.desktopDb, key, String(value))
    }
    if (desktopDailyBudgetUsd !== undefined) {
      if (desktopDailyBudgetUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('desktop_daily_budget_usd')
      } else if (typeof desktopDailyBudgetUsd === 'number' && desktopDailyBudgetUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'desktop_daily_budget_usd', String(desktopDailyBudgetUsd))
      }
    }
    if (costAlertThresholdUsd !== undefined) {
      if (costAlertThresholdUsd === null) {
        registry.desktopDb.prepare('DELETE FROM desktop_settings WHERE key = ?').run('cost_alert_threshold_usd')
      } else if (typeof costAlertThresholdUsd === 'number' && costAlertThresholdUsd > 0) {
        setDesktopSetting(registry.desktopDb, 'cost_alert_threshold_usd', String(costAlertThresholdUsd))
      }
    }
    res.json({ ok: true })
  })

  // GET /api/budget/caps — app-wide Budget panel read model: the app-wide caps
  // with their spend (all projects combined), spend per period split by
  // provider and the month-end projection (an estimate).
  router.get('/budget/caps', (_req, res) => {
    try {
      const at = new Date()
      res.json({
        // App-wide scope: every project plus every agent turn (missions, Intent, Home and Blueprint chats).
        ...readSpendOverview(registry.listContexts().map((c) => ({ db: c.db, projectId: c.project.id })), at, { db: registry.desktopDb }),
        config: readDesktopCaps((key) => getDesktopSetting(registry.desktopDb, key)),
        caps: registry.desktopCapStatuses(at),
      })
    } catch (err) {
      console.error('[desktop-router] budget caps error:', err)
      res.status(500).json({ error: 'budget_caps_unavailable' })
    }
  })
}

/** Terminal defaults, UI theme and language, code-explorer summary settings. */
function registerUiPreferenceRoutes(router: Router, registry: ProjectRegistry): void {
  // GET /api/terminal-settings — Desktop-wide terminal defaults
  router.get('/terminal-settings', (_req, res) => {
    res.json(getDesktopTerminalSettings(registry.desktopDb))
  })

  // PATCH /api/terminal-settings — partial update of Desktop-wide defaults
  router.patch('/terminal-settings', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    try {
      const updated = patchDesktopTerminalSettings(registry.desktopDb, req.body as Record<string, unknown>)
      res.json(updated)
    } catch (err) {
      if (err instanceof TerminalSettingsValidationError) {
        res.status(400).json({ error: 'validation_failed', field: err.field, message: err.message })
        return
      }
      throw err
    }
  })

  // ─── Theme (app-wide UI theme) ────────────────────────────────────────────
  // Allow-list synchronized with `client/src/features/settings/lib/themes.ts THEME_IDS`.
  // Persisted under desktop_settings key `ui_theme`. Default seeded by migration 8.
  router.get('/theme', (_req, res) => {
    const stored = getDesktopSetting(registry.desktopDb, 'ui_theme')
    const migrated = stored ? LEGACY_THEME_ID_MAP[stored] : undefined
    const theme = migrated ?? (stored && THEME_ID_ALLOWLIST.has(stored) ? stored : 'specrails')
    if (migrated) setDesktopSetting(registry.desktopDb, 'ui_theme', migrated)
    res.json({ theme })
  })

  router.patch('/theme', (req, res) => {
    const next = (req.body as { theme?: unknown } | undefined)?.theme
    if (typeof next !== 'string' || !THEME_ID_ALLOWLIST.has(next)) {
      res.status(400).json({
        error: 'invalid_theme',
        message: `theme must be one of: ${[...THEME_ID_ALLOWLIST].join(', ')}`,
      })
      return
    }
    setDesktopSetting(registry.desktopDb, 'ui_theme', next)
    res.json({ theme: next })
  })

  // ─── Language (app-wide UI language) ──────────────────────────────────────
  // Allow-list synchronized with `client/src/lib/i18n.ts LANGUAGE_IDS`.
  // Persisted under desktop_settings key `ui_language`. No default is seeded:
  // `language: null` means "user never chose" and the client keeps following
  // the OS/browser language until an explicit choice is PATCHed.
  router.get('/language', (_req, res) => {
    const stored = getDesktopSetting(registry.desktopDb, 'ui_language')
    const language = stored && LANGUAGE_ID_ALLOWLIST.has(stored) ? stored : null
    res.json({ language })
  })

  router.patch('/language', (req, res) => {
    const next = (req.body as { language?: unknown } | undefined)?.language
    if (typeof next !== 'string' || !LANGUAGE_ID_ALLOWLIST.has(next)) {
      res.status(400).json({
        error: 'invalid_language',
        message: `language must be one of: ${[...LANGUAGE_ID_ALLOWLIST].join(', ')}`,
      })
      return
    }
    setDesktopSetting(registry.desktopDb, 'ui_language', next)
    res.json({ language: next })
  })

  // ─── Code Explorer settings (summary language + monthly budget) ───────────
  router.get('/code-explorer-settings', (_req, res) => {
    const langRaw = getDesktopSetting(registry.desktopDb, 'summary_language')
    const language = langRaw === 'es' ? 'es' : 'en'
    const budgetRaw = getDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd')
    const parsed = budgetRaw !== undefined ? Number(budgetRaw) : NaN
    const monthlyBudgetUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5.0
    res.json({ language, monthlyBudgetUsd })
  })

  router.patch('/code-explorer-settings', (req, res) => {
    const body = (req.body ?? {}) as { language?: unknown; monthlyBudgetUsd?: unknown }
    if (body.language !== undefined) {
      if (body.language !== 'en' && body.language !== 'es') {
        res.status(400).json({
          error: 'invalid_language',
          message: "language must be one of: 'en', 'es'",
        })
        return
      }
    }
    if (body.monthlyBudgetUsd !== undefined) {
      if (typeof body.monthlyBudgetUsd !== 'number' || !Number.isFinite(body.monthlyBudgetUsd) || body.monthlyBudgetUsd < 0) {
        res.status(400).json({
          error: 'invalid_monthly_budget_usd',
          message: 'monthlyBudgetUsd must be a non-negative number',
        })
        return
      }
    }
    if (body.language !== undefined) {
      setDesktopSetting(registry.desktopDb, 'summary_language', body.language as string)
    }
    if (body.monthlyBudgetUsd !== undefined) {
      setDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd', String(body.monthlyBudgetUsd))
    }
    const langRaw = getDesktopSetting(registry.desktopDb, 'summary_language')
    const language = langRaw === 'es' ? 'es' : 'en'
    const budgetRaw = getDesktopSetting(registry.desktopDb, 'summary_monthly_budget_usd')
    const parsed = budgetRaw !== undefined ? Number(budgetRaw) : NaN
    const monthlyBudgetUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5.0
    res.json({ language, monthlyBudgetUsd })
  })
}

/** Specrails Agents defaults and external MCP servers (both read at spawn time). */
function registerAgentDefaultsRoutes(router: Router, registry: ProjectRegistry): void {
  // ─── Specrails Agents defaults (global per-provider agent model/effort) ───
  // App-level layer read AT SPAWN TIME by QueueManager / rails-router / loop
  // executors — a change applies to the next run with zero restart.
  router.get('/agent-defaults', (_req, res) => {
    res.json({
      settings: readAgentDefaultsSettings(registry.desktopDb),
      catalog: buildAgentDefaultsCatalog(),
    })
  })

  router.patch('/agent-defaults', (req, res) => {
    try {
      const settings = applyAgentDefaultsPatch(registry.desktopDb, req.body)
      res.json({ settings, catalog: buildAgentDefaultsCatalog() })
    } catch (err) {
      if (err instanceof AgentDefaultsValidationError) {
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      res.status(500).json({ error: 'agent_defaults_failed', message: (err as Error).message })
    }
  })

  // ─── External MCP servers (mission agent, app-global) ─────────────────────
  // Registry of the user's OWN MCP servers for mission spawns. Discovery reads
  // provider native configs per request (cheap file reads, read-only); entries
  // resolve at spawn time, so a PATCH applies to the next turn with no restart.
  router.get('/external-mcp', (_req, res) => {
    const settings = readExternalMcpSettings(registry.desktopDb)
    res.json({ discovered: discoverExternalMcp(settings), settings })
  })

  router.patch('/external-mcp', (req, res) => {
    try {
      const settings = applyExternalMcpPatch(registry.desktopDb, req.body)
      res.json({ discovered: discoverExternalMcp(settings), settings })
    } catch (err) {
      if (err instanceof ExternalMcpValidationError) {
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      res.status(500).json({ error: 'external_mcp_failed', message: (err as Error).message })
    }
  })
}

