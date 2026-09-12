import type { ProjectRoutesDeps } from './project-router-helpers'
import { hasAgentRuntimeRequest } from './agent-runtime-paths'
import { AgentRuntimeControls, RuntimeControlError, validateRuntimeResumeInput } from './agent-runtime-controls'

const controllers = new WeakMap<object, AgentRuntimeControls>()
export function isRuntimeContinuationActive(context: object, runId: string): boolean { return controllers.get(context)?.isActive(runId) ?? false }
export function activeRuntimeContinuationIds(context: object): string[] { return controllers.get(context)?.activeRunIds() ?? [] }
export function cancelRuntimeContinuation(context: object, runId: string): boolean {
  const controller = controllers.get(context)
  if (!controller?.isActive(runId)) return false
  controller.cancel(runId)
  return true
}
export function shutdownAgentRuntimeControls(context: object): void { controllers.get(context)?.shutdown() }

export function registerAgentRuntimeControlRoutes({ router, ctx }: Pick<ProjectRoutesDeps, 'router' | 'ctx'>): void {
  function controls(request: Parameters<typeof ctx>[0]) {
    const context = ctx(request)
    let controller = controllers.get(context)
    if (!controller) { controller = new AgentRuntimeControls(context); controllers.set(context, controller) }
    return controller
  }
  router.get('/:projectId/agent-runtime/runs', async (req, res) => {
    try {
      if (req.query.railIndex !== undefined) {
        const railIndex = Number(req.query.railIndex)
        if (!Number.isSafeInteger(railIndex) || railIndex < 0) { res.status(400).json({ error: 'invalid_rail_index' }); return }
        const context = ctx(req)
        const latest = context.db.prepare('SELECT id FROM loop_runs WHERE rail_index = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(railIndex) as { id: string } | undefined
        res.json({ runs: latest && hasAgentRuntimeRequest(context.project, latest.id) ? [await controls(req).summary(latest.id)] : [] })
        return
      }
      res.json({ runs: await controls(req).list() })
    }
    catch { res.status(500).json({ error: 'runtime_status_failed', message: 'Could not read runtime executions' }) }
  })
  router.get('/:projectId/agent-runtime/runs/:runId', async (req, res) => {
    try {
      const context = ctx(req), runId = String(req.params.runId)
      res.json({ runs: hasAgentRuntimeRequest(context.project, runId) ? [await controls(req).summary(runId)] : [] })
    } catch { res.status(500).json({ error: 'runtime_status_failed' }) }
  })
  router.post('/:projectId/agent-runtime/runs/:runId/resume', async (req, res) => {
    try { await controls(req).resume(String(req.params.runId), validateRuntimeResumeInput(req.body)); res.status(202).json({ accepted: true }) }
    catch (error) { res.status(error instanceof RuntimeControlError ? error.statusCode : 500).json({ error: error instanceof RuntimeControlError ? error.code : 'runtime_resume_failed', message: error instanceof RuntimeControlError ? error.message : 'Could not resume runtime execution' }) }
  })
  router.post('/:projectId/agent-runtime/runs/:runId/settle', async (req, res) => {
    try { await controls(req).settle(String(req.params.runId)); res.json({ settled: true }) }
    catch (error) { res.status(error instanceof RuntimeControlError ? error.statusCode : 500).json({ message: error instanceof RuntimeControlError ? error.message : 'Could not prepare delivery' }) }
  })
  router.post('/:projectId/agent-runtime/runs/:runId/cancel', (req, res) => {
    try { controls(req).cancel(String(req.params.runId)); res.status(202).json({ accepted: true }) }
    catch (error) { res.status(error instanceof RuntimeControlError ? error.statusCode : 500).json({ error: error instanceof RuntimeControlError ? error.code : 'runtime_cancel_failed', message: error instanceof RuntimeControlError ? error.message : 'Could not cancel runtime execution' }) }
  })
}
