import type { ProjectRoutesDeps } from './project-router-helpers'
import { loadCoreAgentRuntime, findCoreAgentRuntimeEntry } from './agent-runtime-loader'
import { AgentRuntimeConfigError, defaultAgentRuntimeConfig, loadAgentRuntimeConfig, saveAgentRuntimeConfig, validateAgentRuntimeConfig } from './agent-runtime-settings'
import { suggestVerificationCommands } from './agent-runtime-verification-suggestions'
import { getProjectRepositories } from './project-repositories'

export function registerAgentRuntimeSettingsRoutes({ router, ctx }: Pick<ProjectRoutesDeps, 'router' | 'ctx'>): void {
  router.get('/:projectId/agent-runtime/config', (_req, res) => {
    try {
      const project = ctx(_req).project
      const config = loadAgentRuntimeConfig(project)
      res.json({ configured: config !== null, config: config ?? defaultAgentRuntimeConfig(project), runtimeAvailable: findCoreAgentRuntimeEntry() !== null })
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
  router.put('/:projectId/agent-runtime/config', async (req, res) => {
    try {
      const config = validateAgentRuntimeConfig(req.body)
      const runtimeAvailable = findCoreAgentRuntimeEntry() !== null
      if (config.enabled && !runtimeAvailable) {
        res.status(503).json({ error: 'runtime_unavailable', message: 'Update Core to an installation with the agent runtime before enabling it' })
        return
      }
      // Disabling must remain possible even when an installed runtime is broken.
      if (config.enabled && runtimeAvailable) {
        try { (await loadCoreAgentRuntime()).validateRuntimeConfig(config) }
        catch {
          res.status(503).json({ error: 'runtime_incompatible', message: 'The installed Core runtime could not validate this configuration; update Core and retry' })
          return
        }
      }
      const saved = saveAgentRuntimeConfig(ctx(req).project, config)
      res.json({ configured: true, config: saved, runtimeAvailable })
    } catch (err) {
      const validation = err instanceof AgentRuntimeConfigError
      res.status(validation ? 400 : 500).json({ error: validation ? 'invalid_runtime_config' : 'runtime_config_write_failed', message: validation ? err.message : 'Could not save runtime configuration' })
    }
  })
}
