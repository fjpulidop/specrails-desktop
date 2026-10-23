import type { Request, Response, Router } from 'express'
import {
  FlowConflictError,
  FlowLaunchRejectedError,
  FlowNotFoundError,
  FlowTransitionError,
  FlowUnavailableError,
  FlowValidationError,
  type FlowLaunchOptions,
  type FlowService,
} from '..'

/**
 * Inbound adapter: thin, project-scoped Flow routes. Translates HTTP into use
 * cases and domain errors into status codes. Mounted under
 * `/api/projects/:projectId` by the project router.
 */

const ID_RE = /^[A-Za-z0-9-]{1,64}$/

function fail(res: Response, error: unknown): void {
  if (error instanceof FlowValidationError) { res.status(400).json({ error: error.code, detail: error.message }); return }
  if (error instanceof FlowNotFoundError) { res.status(404).json({ error: error.code, detail: error.message }); return }
  if (error instanceof FlowUnavailableError) { res.status(409).json({ error: error.code, detail: error.message, missing: error.missing }); return }
  if (error instanceof FlowConflictError) { res.status(409).json({ error: error.code, detail: error.message, ...(error.flowId ? { flowId: error.flowId } : {}) }); return }
  if (error instanceof FlowTransitionError) { res.status(409).json({ error: error.code, detail: error.message }); return }
  if (error instanceof FlowLaunchRejectedError) {
    res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({ error: error.code, detail: error.message }); return
  }
  console.error('[flow] request failed:', error)
  res.status(500).json({ error: 'flow_failed', detail: error instanceof Error ? error.message : String(error) })
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new FlowValidationError(`invalid_${field}`, `${field} must be a non-empty string`)
  return value.trim()
}

export function registerFlowHttp(router: Router, serviceForRequest: (request: Request) => FlowService | undefined): void {
  const withService = (handler: (service: FlowService, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response): Promise<void> => {
      const service = serviceForRequest(req)
      if (!service) { res.status(409).json({ error: 'feature_unavailable', detail: 'Flow is not available in this project' }); return }
      try {
        await handler(service, req, res)
      } catch (error) {
        fail(res, error)
      }
    }
  const flowId = (req: Request): string => {
    const id = String(req.params.flowId ?? '')
    if (!ID_RE.test(id)) throw new FlowValidationError('invalid_flow_id', 'Invalid flow id')
    return id
  }

  // Capability gate the client uses to offer Flow (flowSessions + deriveChange).
  router.get('/:projectId/flow/availability', withService(async (service, _req, res) => {
    res.json(await service.availability())
  }))

  router.post('/:projectId/flow', withService(async (service, req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const flow = await service.startFlow({
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : '',
      idea: typeof body.idea === 'string' ? body.idea : '',
      ...(body.title !== undefined ? { title: optionalString(body.title, 'title') ?? null } : {}),
      ...(body.flowId !== undefined ? { flowId: String(body.flowId) } : {}),
      // The repository the Flow runs in (workspace / multi-repository projects).
      ...(body.repositoryId !== undefined && body.repositoryId !== null ? { repositoryId: optionalString(body.repositoryId, 'repositoryId') ?? null } : {}),
    })
    res.status(201).json({ flow })
  }))

  // The project's conversations in Flow mode (the mission list marks them).
  router.get('/:projectId/flow/open', withService((service, _req, res) => {
    res.json({ flows: service.listOpen().map((flow) => ({ id: flow.id, conversationId: flow.conversationId, state: flow.state, branch: flow.branch })) })
  }))

  router.get('/:projectId/flow/by-conversation/:conversationId', withService((service, req, res) => {
    const conversationId = String(req.params.conversationId ?? '')
    if (!conversationId || conversationId.length > 200) throw new FlowValidationError('invalid_conversation_id', 'Invalid conversation id')
    res.json({ flow: service.getByConversation(conversationId) })
  }))

  const deliveryId = (req: Request): string => {
    const id = String(req.params.deliveryId ?? '')
    if (!ID_RE.test(id)) throw new FlowValidationError('invalid_delivery_id', 'Invalid delivery id')
    return id
  }

  // Back to Flow: a Flow -> Spec run stopped with requested changes; its
  // worktree returns to the Flow (same mount) and the agent session reopens.
  router.post('/:projectId/flow/by-delivery/:deliveryId/return', withService(async (service, req, res) => {
    res.json({ flow: await service.returnToFlow({ deliveryId: deliveryId(req) }) })
  }))

  // Relaunch Flow -> Spec on the SAME worktree (same rail and engine choices).
  router.post('/:projectId/flow/by-delivery/:deliveryId/relaunch', withService(async (service, req, res) => {
    res.status(202).json(await service.relaunchFlow({ deliveryId: deliveryId(req) }))
  }))

  router.get('/:projectId/flow/:flowId', withService((service, req, res) => {
    res.json({ flow: service.getFlow(flowId(req)) })
  }))

  router.post('/:projectId/flow/:flowId/pause', withService(async (service, req, res) => {
    res.json({ flow: await service.pauseFlow(flowId(req)) })
  }))

  router.post('/:projectId/flow/:flowId/resume', withService(async (service, req, res) => {
    res.json({ flow: await service.resumeFlow(flowId(req)) })
  }))

  router.post('/:projectId/flow/:flowId/discard', withService(async (service, req, res) => {
    res.json({ flow: await service.discardFlow(flowId(req)) })
  }))

  router.post('/:projectId/flow/:flowId/hand-off', withService(async (service, req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.railIndex !== 'number' || !Number.isSafeInteger(body.railIndex) || body.railIndex < 0) {
      throw new FlowValidationError('invalid_rail_index', 'railIndex must be a non-negative integer')
    }
    const options: FlowLaunchOptions = {
      loopId: optionalString(body.loopId, 'loopId'),
      aiEngine: optionalString(body.aiEngine, 'aiEngine'),
      model: optionalString(body.model, 'model'),
      reasoningEffort: optionalString(body.reasoning_effort ?? body.reasoningEffort, 'reasoning_effort'),
    }
    const result = await service.handOffFlow({ flowId: flowId(req), railIndex: body.railIndex, options })
    res.status(202).json(result)
  }))

  router.get('/:projectId/flow/:flowId/diff', withService(async (service, req, res) => {
    res.json(await service.diffSummary(flowId(req)))
  }))

  router.get('/:projectId/flow/:flowId/cost', withService((service, req, res) => {
    res.json(service.costSoFar(flowId(req)))
  }))
}
