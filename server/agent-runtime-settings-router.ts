import type { ProjectRoutesDeps } from './project-router-helpers'
import { existsSync } from 'node:fs'
import { loadCoreAgentRuntime, findCoreAgentRuntimeEntry, validateRequestedRoleEfforts } from './agent-runtime-loader'
import { AgentRuntimeConfigError, agentRuntimeConfigPath, loadAgentRuntimeConfig, saveAgentRuntimeConfig, validateAgentRuntimeConfig, loadRuntimeProviders } from './agent-runtime-settings'
import { suggestVerificationCommands } from './agent-runtime-verification-suggestions'
import { getProjectRepositories } from './project-repositories'

export function registerAgentRuntimeSettingsRoutes({ router, ctx }: Pick<ProjectRoutesDeps, 'router' | 'ctx'>): void {
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
      const config = validateAgentRuntimeConfig({ ...req.body, providers: loadRuntimeProviders(), enabled: true })
      const runtime = await loadCoreAgentRuntime()
      if (!runtime.capabilities) throw new Error('Installed Core does not support capability introspection')
      res.json(await runtime.capabilities(config))
    } catch (error) {
      res.status(error instanceof AgentRuntimeConfigError ? 400 : 503).json({ error: 'runtime_capabilities_unavailable', message: error instanceof AgentRuntimeConfigError ? error.message : 'Update the paired Core runtime to inspect model capabilities' })
    }
  })
  router.put('/:projectId/agent-runtime/config' , async (req, res) => {
    try {
      validateAgentRuntimeConfig(req.body)
      const config = validateAgentRuntimeConfig({ ...req.body, enabled: true, providers: loadRuntimeProviders() })
      const runtimeAvailable = findCoreAgentRuntimeEntry() !== null
      if (config.enabled && !runtimeAvailable) {
        res.status(503).json({ error: 'runtime_unavailable', message: 'Update Core to an installation with the agent runtime before enabling it' })
        return
      }
      let efficiencyAvailable = false
      if (config.enabled && runtimeAvailable) {
        try { const runtime = await loadCoreAgentRuntime(); runtime.validateRuntimeConfig(config); validateRequestedRoleEfforts(runtime, config); efficiencyAvailable = runtime.api?.capabilities?.efficientRoleExecution === 1 }
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
