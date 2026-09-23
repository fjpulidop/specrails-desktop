import type { Router } from 'express'
import { AgentRuntimeConfigError, loadRuntimeRolePrompts, saveRuntimeRolePrompts } from './modules/agent-runtime/runtime/agent-runtime-settings'
import { loadCoreAgentRuntime as loadPromptRuntime } from './modules/agent-runtime/runtime/agent-runtime-loader'

export function registerRuntimeRolePromptRoutes(router: Router): void {
  router.get('/runtime-role-prompts', async (_req, res) => {
    try {
      const defaults = (await loadPromptRuntime()).rolePromptDefaults()
      res.json({ defaults, overrides: loadRuntimeRolePrompts() })
    } catch (error) { res.status(422).json({ message: (error as Error).message }) }
  })
  router.put('/runtime-role-prompts', async (req, res) => {
    try {
      const defaults = (await loadPromptRuntime()).rolePromptDefaults()
      res.json({ defaults, overrides: saveRuntimeRolePrompts(req.body.overrides) })
    } catch (error) { res.status(error instanceof AgentRuntimeConfigError ? 400 : 500).json({ message: (error as Error).message }) }
  })

}
