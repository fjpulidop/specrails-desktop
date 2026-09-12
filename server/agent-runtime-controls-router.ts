import type { ProjectRoutesDeps } from './project-router-helpers'
import { AgentRuntimeControls, RuntimeControlError, validateRuntimeResumeInput } from './agent-runtime-controls'

const controllers = new WeakMap<object, AgentRuntimeControls>()
export function shutdownAgentRuntimeControls(context: object): void { controllers.get(context)?.shutdown() }

export function registerAgentRuntimeControlRoutes({ router, ctx }: Pick<ProjectRoutesDeps, 'router' | 'ctx'>): void {
  function controls(request: Parameters<typeof ctx>[0]) {
    const context = ctx(request)
    let controller = controllers.get(context)
    if (!controller) { controller = new AgentRuntimeControls(context); controllers.set(context, controller) }
    return controller
  }
  router.get('/:projectId/agent-runtime/runs', async (req, res) => {
    try { res.json({ runs: await controls(req).list() }) }
    catch { res.status(500).json({ error: 'runtime_status_failed', message: 'Could not read runtime executions' }) }
  })
  router.post('/:projectId/agent-runtime/runs/:runId/resume', async (req, res) => {
    try { await controls(req).resume(String(req.params.runId), validateRuntimeResumeInput(req.body)); res.status(202).json({ accepted: true }) }
    catch (error) { res.status(error instanceof RuntimeControlError ? error.statusCode : 500).json({ error: error instanceof RuntimeControlError ? error.code : 'runtime_resume_failed', message: error instanceof RuntimeControlError ? error.message : 'Could not resume runtime execution' }) }
  })
  router.post('/:projectId/agent-runtime/runs/:runId/cancel', (req, res) => {
    try { controls(req).cancel(String(req.params.runId)); res.status(202).json({ accepted: true }) }
    catch (error) { res.status(error instanceof RuntimeControlError ? error.statusCode : 500).json({ error: error instanceof RuntimeControlError ? error.code : 'runtime_cancel_failed', message: error instanceof RuntimeControlError ? error.message : 'Could not cancel runtime execution' }) }
  })
}
