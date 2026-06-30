import { z } from 'zod'
import type { WsMessage } from '../../types'
import type { McpToolSpec } from './types'

// Event `type` suffixes/strings that mean an async operation has settled.
const TERMINAL_PATTERNS = [
  'job.finalized',
  'rail.job_completed',
  'rail.job_stopped',
  'chat_done',
  'chat_error',
  'spec_gen_done',
  'spec_gen_error',
  'ticket_ai_edit_done',
  'ticket_ai_edit_error',
  'agent_refine_ready',
  'agent_refine_error',
  'smash.completed',
  'smash.failed',
  'loop.run_completed',
  'loop.run_stopped',
  'explore.contract_refine_failed',
  'file.summary_updated',
  'file.summary_failed',
]

function isTerminal(type: string): boolean {
  return TERMINAL_PATTERNS.some((p) => type === p || type.endsWith(p))
}

function mentionsRef(msg: WsMessage, ref: string): boolean {
  // Heuristic: the reference (jobId / requestId / loopRunId) appears somewhere
  // in the message payload. Cheap and robust across the heterogeneous WS union.
  try {
    return JSON.stringify(msg).includes(ref)
  } catch {
    return false
  }
}

export function watchTool(): McpToolSpec {
  return {
    name: 'specrails_watch',
    title: 'Watch async result',
    description:
      'Wait for an asynchronous operation (rail launch, spec generation, chat turn, agent refine, SMASH, loop run) to settle ' +
      'and return its events. Pass the projectId and the reference (jobId / requestId) returned by the action. ' +
      'Resolves when a terminal event for that reference is seen, or after untilMs.',
    tier: 'read',
    inputSchema: {
      projectId: z.string().describe('Project id the operation runs in'),
      ref: z.string().describe('jobId / requestId / loopRunId returned by the async action'),
      untilMs: z.number().int().min(1000).max(600000).default(120000).describe('Max time to wait (ms)'),
    },
    handler: (ctx, args) => {
      const projectId = args.projectId as string
      const ref = args.ref as string
      const untilMs = (args.untilMs as number | undefined) ?? 120000

      return new Promise<unknown>((resolve) => {
        const events: WsMessage[] = []
        let done = false

        const finish = (settled: boolean, reason: string) => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsub()
          resolve({
            settled,
            reason,
            ref,
            projectId,
            eventCount: events.length,
            terminalEvent: settled ? events[events.length - 1] : null,
            events: events.slice(-50),
          })
        }

        const unsub = ctx.eventBus.onMessage((msg: WsMessage) => {
          const msgProjectId = (msg as { projectId?: string }).projectId
          if (msgProjectId && msgProjectId !== projectId) return
          if (!mentionsRef(msg, ref)) return
          events.push(msg)
          const type = (msg as { type?: string }).type ?? ''
          if (isTerminal(type)) finish(true, `terminal:${type}`)
        })

        const timer = setTimeout(() => finish(false, 'timeout'), untilMs)
        // Do not keep the event loop alive solely for this watch.
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
  }
}
