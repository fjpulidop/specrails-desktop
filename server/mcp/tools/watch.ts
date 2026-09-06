import { z } from 'zod'
import type { WsMessage } from '../../types'
import type { McpToolSpec } from './types'
import { apiCall, getActiveProject } from './types'

// Exact event types that mean an async operation has settled.
const TERMINAL_PATTERNS = new Set([
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
  'agent_refine_cancelled',
  'smash.completed',
  'smash.failed',
  'smash.undone',
  'loop.run_completed',
  'loop.run_stopped',
  'explore.contract_refine_failed',
  'file.summary_updated',
  'file.summary_failed',
  'file.summary_skipped',
  'setup_install_done',
  'setup_error',
  'plugin.installed',
  'plugin.degraded',
])

// Job statuses that mean a polled job has settled (see project-router-jobs.ts).
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled', 'skipped', 'zombie_terminated'])

// Jobs are identified by UUIDs (server/ids.ts newId → randomUUID). When the ref
// looks like one, the wait loop also polls the job read as a fallback for jobs
// that never emit a watch-terminal event (e.g. rail-bypass `spawn` jobs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const JOB_POLL_INTERVAL_MS = 5000

const TIMEOUT_SUGGESTION =
  'timeout ≠ failure — the operation may still be running. Re-watch with the same ref and kind, or poll specrails_jobs(get)/specrails_loops(run_get)/specrails_specs(get) for current state.'

function isTerminal(type: string): boolean {
  return TERMINAL_PATTERNS.has(type)
}

function mentionsRef(msg: WsMessage, ref: string): boolean {
  // Identity must match exactly: arbitrary log/output text can mention another
  // operation, and "job-1" must never settle when "job-10" finishes.
  const record = msg as unknown as Record<string, unknown>
  if (['jobId', 'processId', 'requestId', 'conversationId', 'loopRunId', 'refineId', 'runId', 'sessionId']
    .some((key) => record[key] === ref)) return true
  if (msg.type.startsWith('plugin.')) return record.name === ref
  if (msg.type.startsWith('file.')) return record.path === ref
  if (msg.type.startsWith('setup_')) return record.projectId === ref
  if (msg.type === 'smash.undone') return String(record.ticketId) === ref
  return false
}

const MAX_EVENT_BYTES = 16_000
const MAX_BUFFER_BYTES = 256_000

function boundedEvent(msg: WsMessage): { event: WsMessage; bytes: number } {
  const json = JSON.stringify(msg)
  if (json.length <= MAX_EVENT_BYTES) return { event: msg, bytes: json.length }
  const record = msg as unknown as Record<string, unknown>
  const identity = Object.fromEntries(Object.entries(record).filter(([key, value]) =>
    ['type', 'projectId', 'jobId', 'processId', 'requestId', 'conversationId', 'loopRunId', 'refineId', 'runId', 'sessionId', 'status', 'name', 'path'].includes(key)
    && typeof value === 'string').map(([key, value]) => [key, (value as string).slice(0, 1024)]))
  const event = { ...identity, truncated: true, originalLength: json.length, preview: json.slice(0, 6000) } as unknown as WsMessage
  return { event, bytes: JSON.stringify(event).length }
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
      'Use kind:"job" or kind:"loop_run" for durable recovery: reads current state immediately, then every 5s, including operations that finished before this call. UUID refs auto-detect jobs/loop runs. ' +
      'Default untilMs 120000 is often shorter than a rail run (max 600000). ' +
      'settled means terminal, NOT necessarily successful; inspect terminalEvent.status/outcome. Events are bounded/truncated to protect context; other operation kinds only observe future events. ' +
      'settled:false with reason:"timeout" means TIMEOUT, not failure — re-watch or poll the domain read. Cancellation stops waiting without stopping the operation. ' +
      'A new message in the owning mission ends only this wait immediately with reason:"user_update" so the agent can incorporate it; the underlying job/rail keeps running.',
    tier: 'read',
    inputSchema: {
      projectId: z
        .string()
        .optional()
        .describe('Project id the operation runs in (defaults to the active project; omit for app-level operations)'),
      ref: z.string().min(1).describe('Exact jobId / requestId / conversationId / loopRunId returned by the async action'),
      untilMs: z.number().int().min(1000).max(600000).default(120000).describe('Max time to wait (ms)'),
      kind: z
        .enum(['job', 'loop_run'])
        .optional()
        .describe('Durable result type: job or loop_run. Reads immediately and every 5s, even for non-UUID ids. Omit to auto-detect UUID jobs/loops or listen for other event kinds.'),
    },
    handler: (ctx, args) => {
      // Optional + active-project resolution: an explicit projectId wins, else
      // the active project. App-level operations can have neither; exact
      // operation identity still filters their events.
      const projectId = (args.projectId as string | undefined) ?? getActiveProject(ctx) ?? undefined
      const ref = args.ref as string
      const untilMs = (args.untilMs as number | undefined) ?? 120000
      const kind = args.kind as 'job' | 'loop_run' | undefined
      if (kind && !projectId) throw new Error('Watching a job or loop_run requires projectId or an active project. Select the project or pass projectId.')
      const shouldPoll = kind !== undefined || UUID_RE.test(ref)

      return new Promise<unknown>((resolve) => {
        const readController = new AbortController()
        const readCtx = { ...ctx, signal: ctx.signal
          ? AbortSignal.any([ctx.signal, readController.signal])
          : readController.signal }
        const events: Array<{ event: WsMessage; bytes: number }> = []
        let eventCount = 0
        let bufferBytes = 0
        let done = false
        let poller: NodeJS.Timeout | undefined
        let timer: NodeJS.Timeout | undefined
        let unsub = () => {}
        let unsubMission = () => {}
        const addEvent = (msg: WsMessage) => {
          if (done) return
          const entry = boundedEvent(msg)
          events.push(entry)
          eventCount++
          bufferBytes += entry.bytes
          while (events.length > 50 || bufferBytes > MAX_BUFFER_BYTES) {
            bufferBytes -= events.shift()!.bytes
          }
        }
        const aborted = () => finish(false, 'canceled')

        const finish = (settled: boolean, reason: string) => {
          if (done) return
          done = true
          readController.abort()
          clearTimeout(timer)
          if (poller) clearInterval(poller)
          unsub()
          unsubMission()
          ctx.signal?.removeEventListener('abort', aborted)
          resolve({
            settled,
            reason,
            ref,
            projectId: projectId ?? null,
            eventCount,
            terminalEvent: settled ? events[events.length - 1]?.event ?? null : null,
            events: events.map((entry) => entry.event),
            ...(reason === 'user_update' ? { operationStopped: false } : {}),
            ...(settled ? {} : { suggestion: reason === 'user_update'
              ? 'Waiting ended because the user updated this mission; the operation was NOT stopped and may still be running. Incorporate the user instructions received through the active mission input channel, then decide the next action from current state.'
              : reason === 'canceled'
              ? 'Waiting was canceled; the operation was not stopped. Read its current state before deciding the next action.'
              : TIMEOUT_SUGGESTION }),
          })
        }

        if (ctx.signal?.aborted) { aborted(); return }
        ctx.signal?.addEventListener('abort', aborted, { once: true })
        unsub = ctx.eventBus.onMessage((msg: WsMessage) => {
          if (done) return
          const msgProjectId = (msg as { projectId?: string }).projectId
          if (projectId && msgProjectId && msgProjectId !== projectId) return
          if (!mentionsRef(msg, ref)) return
          addEvent(msg)
          const type = (msg as { type?: string }).type ?? ''
          // A loop's final job accounting may precede its durable loop outcome.
          // Explicit kinds must wait for their own lifecycle, even if ids match.
          if (kind === 'loop_run' && !type.startsWith('loop.run_')) return
          if (kind === 'job' && type !== 'job.finalized' && !type.startsWith('rail.job_')) return
          if (isTerminal(type)) finish(true, `terminal:${type}`)
        })
        if (ctx.onMissionInput) {
          unsubMission = ctx.onMissionInput(() => finish(false, 'user_update'))
          // Registration can synchronously report an already-pending input.
          // finish then ran before its disposer was assigned; release it now.
          if (done) { unsubMission(); return }
        }

        // Subscribe BEFORE reading durable state, closing the fast-completion
        // race. Never overlap reads or let a late response resurrect this wait.
        if (shouldPoll && projectId) {
          let polling = false
          const poll = async () => {
            if (done || polling) return
            polling = true
            try {
              const base = `/projects/${encodeURIComponent(projectId)}`
              if (kind !== 'loop_run') {
                const result = await apiCall(readCtx, 'GET', `${base}/jobs/${encodeURIComponent(ref)}`).catch(() => null)
                if (done) return
                const job = (result as { job?: { status?: string } } | null)?.job
                if (job) {
                  if (typeof job.status === 'string' && TERMINAL_JOB_STATUSES.has(job.status)) {
                    addEvent({ type: 'job.poll_settled', projectId, jobId: ref, status: job.status } as unknown as WsMessage)
                    finish(true, `poll:job:${job.status}`)
                  }
                  return
                }
              }
              if (kind === 'job') return
              const result = await apiCall(readCtx, 'GET', `${base}/loop-runs/${encodeURIComponent(ref)}`)
              if (done) return
              const run = (result as { loopRun?: { status?: string; final_outcome?: string | null } } | null)?.loopRun
              if (run?.status === 'completed') {
                addEvent({ type: 'loop.poll_settled', projectId, loopRunId: ref, status: run.status, outcome: run.final_outcome ?? null } as unknown as WsMessage)
                finish(true, `poll:loop_run:${run.final_outcome ?? run.status}`)
              }
            } catch {
              // Unknown ref / transient read failure: stay subscribed, retry.
            } finally { polling = false }
          }
          poller = setInterval(() => { void poll() }, JOB_POLL_INTERVAL_MS)
          if (typeof poller.unref === 'function') poller.unref()
          void poll()
        }

        timer = setTimeout(() => finish(false, 'timeout'), untilMs)
        // Do not keep the event loop alive solely for this watch.
        if (typeof timer.unref === 'function') timer.unref()
      })
    },
  }
}
