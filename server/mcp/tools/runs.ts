import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'
import { actionEnum, type ActionFields } from './actions'

/**
 * `specrails_runs`: the Core programmatic-runtime state of a job or rail
 * continuation (`/agent-runtime/runs`, server/modules/agent-runtime). Moved
 * out of `specrails_jobs`; the old `specrails_jobs(runtime_*)` actions are
 * hidden aliases of these (see jobs.ts).
 *
 * Fork is not offered: the runtime has no fork route.
 */

export const RUN_ACTIONS = ['state', 'diagnose', 'evidence', 'steer', 'resume', 'settle', 'dismiss', 'cancel'] as const
export const RESUME_MODES = ['resume', 'recover', 'approve'] as const

const STEER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const RUN_ACTION_FIELDS: Record<string, ActionFields> = {
  state: { optional: ['jobId', 'railIndex'] },
  diagnose: { required: ['jobId'] },
  evidence: { required: ['jobId'], optional: ['evidenceId', 'section', 'sourceId', 'cursor', 'limit'] },
  steer: { required: ['jobId', 'steeringText', 'requestId'] },
  resume: { required: ['jobId'], optional: ['mode', 'approve', 'recover', 'invalidate', 'answer', 'stepId'] },
  settle: { required: ['jobId'] },
  dismiss: { required: ['jobId'] },
  cancel: { required: ['jobId'] },
}

export function runsTool(): McpToolSpec {
  return {
    name: 'specrails_runs',
    title: 'Runtime runs',
    description:
      'Core runtime state of a job or rail continuation and its recovery. ' +
      'Actions: state (status, nextStep, canResume, recoverableSteps, pending approval/question; all runs when jobId is omitted), ' +
      'diagnose (read-only recovery assessment incl. the reviewer verdict; read before recommending a retry), ' +
      'evidence (durable verification evidence, paged), ' +
      'steer (write — queue steeringText with a stable requestId; acceptance is not consumption), ' +
      'resume (ai-spawn — continue a resumable run; mode recover replays the recoverable steps, mode approve (write) approves a pending step; act only after the person confirmed), ' +
      'settle (write — prepare delivery for a succeeded-but-unsettled run), dismiss (write — clear a settled continuation from the rail card), ' +
      'cancel (destructive — cancel an active continuation). jobId is the run id. Arguments per action: specrails_describe.',
    hintTier: 'read',
    tier: (a) => {
      switch (a.action) {
        case 'cancel': return 'destructive'
        case 'resume': return a.mode === 'approve' ? 'write' : 'ai-spawn'
        case 'steer': case 'settle': case 'dismiss': return 'write'
        default: return 'read'
      }
    },
    actionFields: RUN_ACTION_FIELDS,
    inputSchema: {
      action: actionEnum(RUN_ACTIONS),
      projectId: z.string().optional().describe('Project id (defaults to the active project)'),
      jobId: z.string().optional().describe('Run (job) id; optional only for state'),
      railIndex: z.number().int().nonnegative().optional().describe('state: only the latest continuation of this rail (0-based)'),
      steeringText: z.string().min(1).max(20_000).optional().describe('steer: instruction consumed at the next eligible AI attempt'),
      requestId: z.string().regex(STEER_REQUEST_ID).optional().describe('steer: stable idempotency key; reuse only with identical text'),
      mode: z.enum(RESUME_MODES).optional().describe('resume: resume (default; uses approve/recover/invalidate/answer as given), recover (default: every recoverable step), approve (write tier; needs stepId or approve)'),
      approve: z.array(z.string()).optional().describe('resume: step ids to approve'),
      recover: z.array(z.string()).optional().describe('resume: step ids to recover'),
      invalidate: z.array(z.string()).optional().describe('resume: step ids whose results are discarded before continuing'),
      answer: z.string().optional().describe('resume: answer to the pending question'),
      stepId: z.string().optional().describe('resume (mode recover/approve): one step id, instead of the arrays'),
      evidenceId: z.string().max(1024).optional().describe('evidence: evidence id from the index'),
      section: z.enum(['summary', 'stdout', 'stderr', 'source']).optional().describe('evidence: summary index, command output or recorded source'),
      sourceId: z.string().max(1024).optional().describe('evidence: source id from the index'),
      cursor: z.string().max(1024).optional().describe('evidence: continuation cursor from the previous page'),
      limit: z.number().int().positive().max(100).optional().describe('evidence: page size (default 25)'),
    },
    async handler(ctx, args) {
      const base = projectPath(ctx, args.projectId as string | undefined)
      const action = args.action as string
      const id = args.jobId as string | undefined
      const runPath = () => {
        if (!id) throw new Error(`${action} requires a "jobId".`)
        return `${base}/agent-runtime/runs/${encodeURIComponent(id)}`
      }
      switch (action) {
        case 'state': {
          if (id) return apiCall(ctx, 'GET', runPath())
          const railIndex = args.railIndex as number | undefined
          return apiCall(ctx, 'GET', `${base}/agent-runtime/runs${typeof railIndex === 'number' ? `?railIndex=${railIndex}` : ''}`)
        }
        case 'diagnose':
          return apiCall(ctx, 'GET', `${runPath()}/diagnosis`)
        case 'evidence': {
          const path = runPath()
          const query = new URLSearchParams()
          if (typeof args.evidenceId === 'string') query.set('id', args.evidenceId)
          for (const key of ['section', 'sourceId', 'cursor', 'limit']) if (args[key] !== undefined) query.set(key, String(args[key]))
          return apiCall(ctx, 'GET', `${path}/evidence${query.size ? '?' + query.toString() : ''}`)
        }
        case 'steer': {
          const path = runPath()
          if (typeof args.steeringText !== 'string' || !args.steeringText.trim() || args.steeringText.length > 20_000 || typeof args.requestId !== 'string' || !STEER_REQUEST_ID.test(args.requestId)) {
            throw new Error('steer requires steeringText and a stable requestId.')
          }
          const result = await apiCall(ctx, 'POST', `${path}/steer`, { text: args.steeringText, requestId: args.requestId })
          return { ...(result as Record<string, unknown>), hint: 'Accepted into the durable inbox; consumption happens at the next eligible AI attempt. Inspect specrails_runs(state) steering receipts.' }
        }
        case 'resume': {
          const path = runPath()
          const mode = (args.mode as string | undefined) ?? 'resume'
          const single = typeof args.stepId === 'string' && args.stepId.trim() ? [args.stepId.trim()] : undefined
          const body: Record<string, unknown> = {}
          if (mode === 'recover') {
            let recover = (args.recover as string[] | undefined) ?? single
            if (!recover?.length) {
              const state = await apiCall(ctx, 'GET', path) as { runs?: Array<{ recoverableSteps?: string[] }> }
              recover = state.runs?.[0]?.recoverableSteps ?? []
            }
            if (!recover.length) throw new Error('resume (mode recover): the run has no interrupted steps to recover — read specrails_runs(diagnose) before deciding whether a repair or resume is appropriate.')
            body.recover = recover
          } else if (mode === 'approve') {
            const approve = (args.approve as string[] | undefined) ?? single
            if (!approve?.length) throw new Error('resume (mode approve) requires "stepId" or "approve".')
            body.approve = approve
          } else {
            for (const key of ['approve', 'recover', 'invalidate'] as const) if (Array.isArray(args[key])) body[key] = args[key]
            if (typeof args.answer === 'string') body.answer = args.answer
          }
          const result = await apiCall(ctx, 'POST', `${path}/resume`, body)
          return { ...(result as Record<string, unknown>), hint: 'Resume accepted (202) — it is not completion. Progress streams into the mission run card; verify with specrails_runs(state) or specrails_watch.' }
        }
        case 'settle':
        case 'dismiss':
        case 'cancel':
          return apiCall(ctx, 'POST', `${runPath()}/${action}`)
        default:
          throw new Error(`Unknown action "${action}".`)
      }
    },
  }
}
