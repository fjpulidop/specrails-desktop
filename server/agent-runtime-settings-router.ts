import type { ProjectRoutesDeps } from './project-router-helpers'
import { existsSync } from 'node:fs'
import { loadCoreAgentRuntime, findCoreAgentRuntimeEntry, validateRequestedRoleEfforts } from './agent-runtime-loader'
import { AgentRuntimeConfigError, agentRuntimeConfigPath, loadAgentRuntimeConfig, saveAgentRuntimeConfig, validateAgentRuntimeConfig, loadRuntimeProviders, coreConnectionFieldGates } from './agent-runtime-settings'
import { stripDesktopConnectionFields, forCoreRuntime } from './agent-runtime-settings'
import { suggestVerificationCommands } from './agent-runtime-verification-suggestions'
import { getProjectRepositories } from './project-repositories'
import { fillDefaultRoleModels } from './agent-runtime-effective-config'

/** Raw request body → same body with every local role's missing model filled (validation then passes). */
function withDefaultRoleModels(body: Record<string, unknown>): Record<string, unknown> {
  const agents = body.agents
  const providers = body.providers
  if (!agents || typeof agents !== 'object' || !Array.isArray(providers)) return body
  // Only LOCAL roles: a CLI role saved without a model keeps meaning "provider default" (never frozen into the file).
  const fixer = body.fixer && typeof body.fixer === 'object' ? structuredClone(body.fixer) : undefined
  const filled = fillDefaultRoleModels({ agents: structuredClone(agents) as never, providers: providers as never, ...(fixer ? { fixer: fixer as never } : {}) }, { localOnly: true })
  return { ...body, agents: filled.agents, ...(filled.fixer ? { fixer: filled.fixer } : {}) }
}
import { LoopRoleEnginesError, loadLoopRoleEngines, saveLoopRoleEngines, validateLoopRoleEngines } from './loop-role-engines'

export function registerAgentRuntimeSettingsRoutes({ router, ctx }: Pick<ProjectRoutesDeps, 'router' | 'ctx'>): void {
  /** Guardrail catalog of the loaded Core (configurable-guardrails): ids + phase; the UI owns labels. `supported:false` on older cores. */
  router.get('/:projectId/agent-runtime/guardrails', async (_req, res) => {
    try {
      const runtime = await loadCoreAgentRuntime()
      const supported = runtime.api?.capabilities?.configurableGuardrails === 1
      const catalog = supported && Array.isArray(runtime.api?.guardrails) ? runtime.api!.guardrails!.filter((item) => item && typeof item.id === 'string' && typeof item.phase === 'string') : []
      res.json({ supported, catalog })
    } catch { res.json({ supported: false, catalog: [] }) }
  })
  /** Loop-side role engines (verifier / decider) for `roles` rail launches — hybrid-role-engines. */
  router.get('/:projectId/agent-runtime/loop-roles', (req, res) => {
    try { res.json({ roles: loadLoopRoleEngines(ctx(req).project) }) }
    catch { res.status(500).json({ error: 'loop_roles_read_failed' }) }
  })
  router.put('/:projectId/agent-runtime/loop-roles', (req, res) => {
    try {
      const project = ctx(req).project
      const roles = validateLoopRoleEngines(req.body?.roles ?? req.body ?? {}, project)
      saveLoopRoleEngines(project, roles)
      res.json({ roles })
    } catch (error) {
      if (error instanceof LoopRoleEnginesError) { res.status(400).json({ error: 'invalid_loop_roles', message: error.message }); return }
      res.status(500).json({ error: 'loop_roles_write_failed' })
    }
  })
  router.get('/:projectId/agent-runtime/config', async (_req, res) => {
    try {
      const project = ctx(_req).project
      const configured = existsSync(agentRuntimeConfigPath(project))
      const config = loadAgentRuntimeConfig(project)
      let efficiencyAvailable = false
      try { efficiencyAvailable = (await loadCoreAgentRuntime()).api?.capabilities?.efficientRoleExecution === 1 } catch { /* Ordinary settings remain readable without capability support. */ }
      res.json({ configured, config, runtimeAvailable: findCoreAgentRuntimeEntry() !== null, efficiencyAvailable })
    } catch (err) {
      const validation = err instanceof AgentRuntimeConfigError
      res.status(validation ? 422 : 500).json({ error: validation ? 'invalid_runtime_config' : 'runtime_config_read_failed', message: validation ? err.message : 'Could not read runtime configuration' })
    }
  })
  /** Offline detection of each repository's own checks; never invokes a model.
   *  Verification stays optional: the architect proposes commands for uncovered
   *  repositories at run time, and Core admits repositories without any check. */
  router.get('/:projectId/agent-runtime/verification-suggestions', (req, res) => {
    try {
      const project = ctx(req).project
      const repositories = getProjectRepositories(project).map((repository) => ({ id: repository.id, name: repository.name, path: repository.path }))
      res.json({ repositories: repositories.map(({ id, name }) => ({ id, name })), suggestions: suggestVerificationCommands(repositories) })
    } catch {
      res.status(500).json({ error: 'verification_suggestions_failed', message: 'Could not inspect the project repositories' })
    }
  })
  router.post('/:projectId/agent-runtime/capabilities', async (req, res) => {
    try {
      const config = validateAgentRuntimeConfig(withDefaultRoleModels({ ...req.body, providers: loadRuntimeProviders(), enabled: true }))
      const runtime = await loadCoreAgentRuntime()
      if (!runtime.capabilities) throw new Error('Installed Core does not support capability introspection')
      // Core's schema is additionalProperties:false — strip the desktop-only
      // connection fields (label/defaultModel/rates/supportsReasoningEffort) first.
      res.json(await runtime.capabilities({ ...forCoreRuntime(config, runtime.api?.capabilities), providers: stripDesktopConnectionFields(config.providers, coreConnectionFieldGates(runtime.api?.capabilities)) }))
    } catch (error) {
      // Core prints its verdict (`{"type":"runtime-result","status":"failed","error":…}`) before exiting non-zero: show that, not the generic "update Core" line.
      const coreMessage = (() => { const out = (error as { stdout?: unknown }).stdout; if (typeof out !== 'string') return undefined; try { const parsed = JSON.parse(out.trim().split('\n').pop() ?? '') as { error?: unknown }; return typeof parsed.error === 'string' ? parsed.error : undefined } catch { return undefined } })()
      res.status(error instanceof AgentRuntimeConfigError || coreMessage ? 400 : 503).json({ error: 'runtime_capabilities_unavailable', message: error instanceof AgentRuntimeConfigError ? error.message : coreMessage ?? 'Update the paired Core runtime to inspect model capabilities' })
    }
  })
  router.put('/:projectId/agent-runtime/config' , async (req, res) => {
    try {
      // A local role saved as "provider default" carries no model; fill the
      // connection default (the launch rule) before the model-required check.
      // The raw body is validated first (its own providers included — a
      // credential in a submitted URL must be refused), then the stored
      // connections replace them and the missing local-role models are filled
      // from each connection's default before the model-required check.
      // Saved WITHOUT filling local-role models: "provider default" stays a
      // live reference to the connection's default (resolved at launch).
      validateAgentRuntimeConfig({ ...req.body, providers: Array.isArray(req.body?.providers) ? req.body.providers : loadRuntimeProviders() })
      const config = validateAgentRuntimeConfig({ ...req.body, enabled: true, providers: loadRuntimeProviders() })
      const runtimeAvailable = findCoreAgentRuntimeEntry() !== null
      if (config.enabled && !runtimeAvailable) {
        res.status(503).json({ error: 'runtime_unavailable', message: 'Update Core to an installation with the agent runtime before enabling it' })
        return
      }
      let efficiencyAvailable = false
      if (config.enabled && runtimeAvailable) {
        try { const runtime = await loadCoreAgentRuntime(); const coreConfig = { ...forCoreRuntime(fillDefaultRoleModels(structuredClone(config), { localOnly: true }), runtime.api?.capabilities), providers: stripDesktopConnectionFields(config.providers, coreConnectionFieldGates(runtime.api?.capabilities)) }; runtime.validateRuntimeConfig(coreConfig); validateRequestedRoleEfforts(runtime, coreConfig); efficiencyAvailable = runtime.api?.capabilities?.efficientRoleExecution === 1 }
        catch {
          res.status(503).json({ error: 'runtime_incompatible', message: 'The installed Core runtime could not validate this configuration; update Core and retry' })
          return
        }
      }
      const saved = saveAgentRuntimeConfig(ctx(req).project, config)
      res.json({ configured: true, config: saved, runtimeAvailable, efficiencyAvailable })
    } catch (err) {
      const validation = err instanceof AgentRuntimeConfigError
      res.status(validation ? 400 : 500).json({ error: validation ? 'invalid_runtime_config' : 'runtime_config_write_failed', message: validation ? err.message : 'Could not save runtime configuration' })
    }
  })
}
