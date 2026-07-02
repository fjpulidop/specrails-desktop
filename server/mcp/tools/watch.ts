import { z } from 'zod'
import type { WsMessage } from '../../types'
import type { McpToolSpec } from './types'
import { apiCall, getActiveProject } from './types'

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
  'smash.undone',
  'loop.run_completed',
  'loop.run_stopped',
  'explore.contract_refine_failed',
  'file.summary_updated',
  'file.summary_failed',
  'setup_install_done',
  'setup_error',
  'plugin.installed',
  'plugin.degraded',
]

// Job statuses that mean a polled job has settled (see project-router-jobs.ts).
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled'])

// Jobs are identified by UUIDs (server/ids.ts newId → randomUUID). When the ref
// looks like one, the wait loop also polls the job read as a fallback for jobs
// that never emit a watch-terminal event (e.g. rail-bypass `spawn` jobs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const JOB_POLL_INTERVAL_MS = 5000

const TIMEOUT_SUGGESTION =
  'timeout ≠ failure — the operation may still be running. Re-watch with the same ref, or poll specrails_jobs(get)/specrails_specs(get) for current state.'

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
      'Wait for an asynchronous operation (rail launch, spec generation, chat turn, agent refine, SMASH, loop run, plugin install, setup install) to settle ' +
      'and return its events. Pass the reference (jobId / requestId / conversationId / loopRunId) returned by the action; projectId is optional ' +
      '(defaults to the active project; app-level operations need none). ' +
      'Resolves when a terminal event for that reference is seen, or after untilMs. ' +
      'When the ref is a jobId (or kind:"job" is passed), the job status is also polled every 5s so jobs settle even without a watch-terminal event. ' +
      'Default untilMs 120000 is often shorter than a rail run (max 600000). ' +
      'settled:false means TIMEOUT, not failure — re-watch or poll the domain read (specrails_jobs(get) / specrails_specs(get) / specrails_plugins(health)).',
    tier: 'read',
    inputSchema: {
      projectId: z
        .string()
        .optional()
        .describe('Project id the operation runs in (defaults to the active project; omit for app-level operations)'),
      ref: z.string().describe('jobId / requestId / conversationId / loopRunId returned by the async action'),
      untilMs: z.number().int().min(1000).max(600000).default(120000).describe('Max time to wait (ms)'),
      kind: z
        .enum(['job'])
        .optional()
        .describe('Force the ref to be treated as a jobId (enables the 5s job-status poll fallback even for non-UUID ids)'),
    },
    handler: (ctx, args) => {
      // Optional + active-project resolution: an explicit projectId wins, else
      // the active project. When neither exists, project filtering is skipped —
      // the ref-substring match is discriminating enough, and app-level agent
      // operations carry no projectId at all.
      const projectId = (args.projectId as string | undefined) ?? getActiveProject(ctx) ?? undefined
      const ref = args.ref as string
      const untilMs = (args.untilMs as number | undefined) ?? 120000
      const pollAsJob = args.kind === 'job' || UUID_RE.test(ref)

      return new Promise<unknown>((resolve) => {
        const events: WsMessage[] = []
        let done = false

        const finish = (settled: boolean, reason: string) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (poller) clearInterval(poller)
          unsub()
          resolve({
            settled,
            reason,
            ref,
            projectId: projectId ?? null,
            eventCount: events.length,
            terminalEvent: settled ? events[events.length - 1] : null,
            events: events.slice(-50),
            ...(settled ? {} : { suggestion: TIMEOUT_SUGGESTION }),
          })
        }

        const unsub = ctx.eventBus.onMessage((msg: WsMessage) => {
          const msgProjectId = (msg as { projectId?: string }).projectId
          if (projectId && msgProjectId && msgProjectId !== projectId) return
          if (!mentionsRef(msg, ref)) return
          events.push(msg)
          const type = (msg as { type?: string }).type ?? ''
          if (isTerminal(type)) finish(true, `terminal:${type}`)
        })

        // Job-status poll fallback: some jobs (rail-bypass spawn) never emit a
        // watch-terminal event; poll the job read every 5s and settle when its
        // status is terminal. Polling needs a resolvable project; errors (e.g.
        // the ref is not a job in this project) are ignored and the wait
        // continues on the event path.
        let poller: NodeJS.Timeout | undefined
        if (pollAsJob && projectId) {
          let polling = false
          poller = setInterval(() => {
            if (done || polling) return
            polling = true
            apiCall(ctx, 'GET', `/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(ref)}`)
              .then((r) => {
                const status = (r as { job?: { status?: string } } | null)?.job?.status
                if (typeof status === 'string' && TERMINAL_JOB_STATUSES.has(status)) {
                  events.push({ type: 'job.poll_settled', projectId, jobId: ref, status } as unknown as WsMessage)
                  finish(true, `poll:job:${status}`)
                }
              })
              .catch(() => {
                /* not a job / transient error — keep waiting on events */
              })
              .finally(() => {
                polling = false
              })
          }, JOB_POLL_INTERVAL_MS)
          if (typeof poller.unref === 'function') poller.unref()
        }

        const timer = setTimeout(() => finish(false, 'timeout'), untilMs)
        // Do not keep the event loop alive solely for this watch.
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
  }
}
