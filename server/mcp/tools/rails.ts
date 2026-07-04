import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, originConversationDefaults } from './types'

/** Launch-route contract (rails-router VALID_REASONING_EFFORTS): conversation
 *  efforts outside it (codex 'minimal', claude 'xhigh') are never defaulted —
 *  a default must not 400 a launch that would succeed without it. */
const RAIL_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

/**
 * Rails domain facade. A "rail" is a numbered launch slot per project: it holds
 * a set of assigned ticket IDs plus a mode/profile/engine/name, and launching it
 * spawns the AI pipeline (claude/codex/gemini) over those tickets.
 *
 * Every operation is per-project under /api/projects/:projectId/rails. The
 * launch action is the only cost-incurring / repo-mutating one (ai-spawn, 202);
 * stop is destructive (kills running child process trees + cancels queued jobs).
 */
export function railsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_rails',
      title: 'Rails',
      description:
        'List and configure a project\'s rail launch slots, then launch or stop the AI pipeline for a rail. ' +
        'A rail holds assigned ticket IDs plus a mode/profile/engine/name. Rails are DYNAMIC: create_rail adds a new slot (up to 12), so when every rail is busy or holds other work, create a fresh one and proceed — never wait for a slot. ' +
        'Launching several rails in parallel is safe and normal: each launch runs in its own isolated git worktree. ' +
        'Actions: list (rails + active jobs/loop runs), create_rail (add a new rail slot; returns its railIndex), set_tickets (assign ticket IDs), set_profile (default agent profile, null=legacy), ' +
        'set_engine (provider override, null=primary), set_name (display label, null clears), ' +
        'launch (ai-spawn — spawns claude/codex/gemini CLI job(s) that WRITE CODE, RUN TESTS, COMMIT, and INCUR TOKEN COST; returns 202 with jobId/jobIds/loopRunIds), ' +
        'launch_all (ai-spawn — launches EVERY rail that has tickets and no active run/pending PR decision, in parallel, using each rail\'s stored mode/engine/profile; returns per-rail outcomes with skip reasons), ' +
        'stop (destructive — kills all active jobs and loop runs for the rail). ' +
        'When launched from the in-app agent chat without an explicit aiEngine, the engine defaults to your conversation\'s provider (pass aiEngine to override; launch_all always uses each rail\'s stored engine).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'stop') return 'destructive'
        if (action === 'launch' || action === 'launch_all') return 'ai-spawn'
        if (action === 'set_tickets' || action === 'set_profile' || action === 'set_engine' || action === 'set_name' || action === 'create_rail') return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum(['list', 'create_rail', 'set_tickets', 'set_profile', 'set_engine', 'set_name', 'launch', 'launch_all', 'stop'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        railIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Rail slot index (required for every action except list)'),
        // set_tickets
        ticketIds: z
          .array(z.number().int())
          .optional()
          .describe('Ticket IDs to assign to the rail (set_tickets — replaces the existing set)'),
        // set_profile
        profileName: z
          .string()
          .nullable()
          .optional()
          .describe('Agent profile name; null forces legacy/no-profile mode (set_profile; also optional override for launch)'),
        // set_engine / launch
        aiEngine: z
          .string()
          .nullable()
          .optional()
          .describe('AI engine/provider override; null = project primary (set_engine; also optional override for launch). Must be an installed provider. For launch from the in-app agent chat, omitting it defaults to the launching conversation\'s provider (overriding any stored rail engine) — pass a string or null explicitly to control it.'),
        // set_name / create_rail
        name: z
          .string()
          .nullable()
          .optional()
          .describe('Rail display label (<=60 chars); null/empty clears to default (set_name). Also the optional initial name for create_rail.'),
        // launch
        mode: z
          .enum(['implement', 'batch-implement', 'ultracode', 'loop'])
          .optional()
          .describe('Launch mode (launch; default "implement"). "ultracode" is the wire value for Freestyle mode — hands the spec straight to the model, Claude-only, one job per ticket; loop runs an app-driven loop per ticket.'),
        model: z
          .string()
          .optional()
          .describe('Model for launch. Freestyle mode (wire value \'ultracode\') is Claude-only and takes a Claude alias (haiku | sonnet | opus | fable). For loop mode, any model string valid for the rail\'s provider (claude/codex/gemini).'),
        interactive: z
          .boolean()
          .optional()
          .describe('DEPRECATED — accepted and ignored: Freestyle jobs are interactive by default whenever the interactive-jobs feature is enabled'),
        loopId: z
          .string()
          .optional()
          .describe('Loop id to run (launch). Factory ids (e.g. "factory:implement") map to a legacy mode; a custom published loop id keeps mode="loop". Browse/author loops with specrails_loops; the loop must be Published.'),
        reasoning_effort: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe('Reasoning-effort tier for loop launches (launch, loop mode). From the in-app agent chat, omitting it defaults to the launching conversation\'s effort when that is low/medium/high.'),
      },
      async handler(ctx, args) {
        const base = `${projectPath(ctx, args.projectId as string | undefined)}/rails`
        const action = args.action as string

        const requireRailIndex = (): number => {
          const idx = args.railIndex as number | undefined
          if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
            throw new Error(`Action "${action}" requires a non-negative integer "railIndex".`)
          }
          return idx
        }

        switch (action) {
          case 'list':
            return apiCall(ctx, 'GET', base)

          case 'create_rail': {
            const body: Record<string, unknown> = {}
            if (typeof args.name === 'string' && args.name.trim()) body.name = (args.name as string).trim()
            const r = await apiCall(ctx, 'POST', base, body)
            return {
              ...(r as Record<string, unknown>),
              hint: 'Rail created. Assign tickets with set_tickets on the returned railIndex, then launch. Up to 12 rails per project.',
            }
          }

          case 'set_tickets': {
            const railIndex = requireRailIndex()
            const ticketIds = args.ticketIds as number[] | undefined
            if (!Array.isArray(ticketIds)) {
              throw new Error('set_tickets requires "ticketIds" (an array of numbers).')
            }
            const body: Record<string, unknown> = { ticketIds }
            if (args.mode !== undefined) body.mode = args.mode as string
            if ('profileName' in args && args.profileName !== undefined) body.profileName = args.profileName as string | null
            if ('aiEngine' in args && args.aiEngine !== undefined) body.aiEngine = args.aiEngine as string | null
            return apiCall(ctx, 'PUT', `${base}/${railIndex}/tickets`, body)
          }

          case 'set_profile': {
            const railIndex = requireRailIndex()
            if (!('profileName' in args)) {
              throw new Error('set_profile requires "profileName" (string or null).')
            }
            return apiCall(ctx, 'PUT', `${base}/${railIndex}/profile`, {
              profileName: (args.profileName ?? null) as string | null,
            })
          }

          case 'set_engine': {
            const railIndex = requireRailIndex()
            if (!('aiEngine' in args)) {
              throw new Error('set_engine requires "aiEngine" (string or null).')
            }
            return apiCall(ctx, 'PUT', `${base}/${railIndex}/engine`, {
              aiEngine: (args.aiEngine ?? null) as string | null,
            })
          }

          case 'set_name': {
            const railIndex = requireRailIndex()
            if (!('name' in args)) {
              throw new Error('set_name requires "name" (string or null).')
            }
            return apiCall(ctx, 'PUT', `${base}/${railIndex}/name`, {
              name: (args.name ?? null) as string | null,
            })
          }

          case 'launch': {
            const railIndex = requireRailIndex()
            const body: Record<string, unknown> = {}
            if (args.mode !== undefined) body.mode = args.mode as string
            if ('profileName' in args && args.profileName !== undefined) body.profileName = args.profileName as string | null
            if ('aiEngine' in args && args.aiEngine !== undefined) body.aiEngine = args.aiEngine as string | null
            if (args.model !== undefined) body.model = args.model as string
            if (args.interactive !== undefined) body.interactive = args.interactive as boolean
            if (args.loopId !== undefined) body.loopId = args.loopId as string
            if (args.reasoning_effort !== undefined) body.reasoning_effort = args.reasoning_effort as string
            // Origin link (safe-pr-review-flow): a launch driven by the in-app
            // agent carries its conversation id (from the loopback header, via
            // ctx) so the PR decision card is posted back into that conversation.
            // apiCall forwards no custom headers, so the id rides the JSON body.
            if (ctx.originConversationId) {
              body.originConversationId = ctx.originConversationId
              body.originSurface = 'agent-chat'
            }
            // Engine default (STRUCTURAL, never prompt-dependent): a launch
            // driven by the in-app agent without an explicit aiEngine runs on
            // the LAUNCHING CONVERSATION's provider — a codex conversation must
            // not silently launch claude via the router's rail/primary
            // fall-through. Explicit aiEngine (string OR null) always wins; the
            // router still validates installed-ness (clear 400 back). The
            // conversation's reasoning effort rides along only when it fits the
            // launch contract (low|medium|high). Dashboard / external-client
            // calls (no origin conversation) are byte-identical to before.
            const defaults = originConversationDefaults(ctx)
            if (body.aiEngine === undefined && defaults.provider) {
              body.aiEngine = defaults.provider
            }
            if (body.reasoning_effort === undefined && defaults.reasoningEffort && RAIL_REASONING_EFFORTS.has(defaults.reasoningEffort)) {
              body.reasoning_effort = defaults.reasoningEffort
            }
            const r = await apiCall(ctx, 'POST', `${base}/${railIndex}/launch`, body)
            return {
              ...(r as Record<string, unknown>),
              hint: 'Launch accepted (202). Use specrails_watch with the returned jobId/jobIds (or loopRunIds for loop mode) to await completion. Live output streams over the job WS. Rails run for minutes; pass untilMs up to 600000 and re-watch on timeout.',
            }
          }

          case 'launch_all': {
            // Server-side fan-out: launch every eligible rail IN PARALLEL — safe
            // because each launch isolates its work in per-ticket git worktrees
            // (allocation is serialized per repo by the launch path itself).
            // Eligibility mirrors the dashboard's Launch-all control: the rail
            // must hold tickets, have no active job/loop run, and no undecided
            // PR delivery. Each rail launches with its OWN stored config
            // (mode/engine/profile) — conversation-provider defaults do NOT
            // apply here (they would clobber per-rail engines).
            const snapshot = (await apiCall(ctx, 'GET', base)) as {
              rails?: { railIndex: number; ticketIds?: number[]; mode?: string }[]
              activeJobs?: Record<string, unknown>
              activeLoopRuns?: Record<string, unknown>
              prDeliveries?: Record<string, unknown>
            }
            const rails = snapshot.rails ?? []
            const activeJobs = snapshot.activeJobs ?? {}
            const activeLoopRuns = snapshot.activeLoopRuns ?? {}
            const prDeliveries = snapshot.prDeliveries ?? {}

            type LaunchAllOutcome = {
              railIndex: number
              outcome: 'launched' | 'skipped' | 'failed'
              reason?: 'empty' | 'already-running' | 'pr-decision-pending' | 'tickets-in-flight'
              mode?: string
              ticketIds?: number[]
              jobId?: string
              jobIds?: string[]
              loopRunIds?: string[]
              error?: string
            }
            const results: LaunchAllOutcome[] = []
            const launches: Promise<void>[] = []
            for (const rail of rails) {
              const idx = rail.railIndex
              const key = String(idx)
              const ticketIds = Array.isArray(rail.ticketIds) ? rail.ticketIds : []
              if (ticketIds.length === 0) {
                results.push({ railIndex: idx, outcome: 'skipped', reason: 'empty' })
                continue
              }
              if (key in activeJobs || key in activeLoopRuns) {
                results.push({ railIndex: idx, outcome: 'skipped', reason: 'already-running', ticketIds })
                continue
              }
              if (key in prDeliveries) {
                results.push({ railIndex: idx, outcome: 'skipped', reason: 'pr-decision-pending', ticketIds })
                continue
              }
              const body: Record<string, unknown> = {}
              if (rail.mode) body.mode = rail.mode
              if (ctx.originConversationId) {
                body.originConversationId = ctx.originConversationId
                body.originSurface = 'agent-chat'
              }
              launches.push(
                apiCall(ctx, 'POST', `${base}/${idx}/launch`, body)
                  .then((r) => {
                    const data = r as Record<string, unknown>
                    results.push({
                      railIndex: idx, outcome: 'launched', ticketIds,
                      mode: typeof data.mode === 'string' ? data.mode : rail.mode,
                      ...(typeof data.jobId === 'string' ? { jobId: data.jobId } : {}),
                      ...(Array.isArray(data.jobIds) ? { jobIds: data.jobIds as string[] } : {}),
                      ...(Array.isArray(data.loopRunIds) ? { loopRunIds: data.loopRunIds as string[] } : {}),
                    })
                  })
                  .catch((err: unknown) => {
                    // Race-safe: a 409 raised between the snapshot and the launch
                    // maps back to its skip reason instead of a hard failure.
                    const message = err instanceof Error ? err.message : String(err)
                    if (message.includes('pr_decision_pending')) {
                      results.push({ railIndex: idx, outcome: 'skipped', reason: 'pr-decision-pending', ticketIds })
                    } else if (message.includes('tickets_in_flight')) {
                      results.push({ railIndex: idx, outcome: 'skipped', reason: 'tickets-in-flight', ticketIds })
                    } else {
                      results.push({ railIndex: idx, outcome: 'failed', ticketIds, error: message })
                    }
                  }),
              )
            }
            await Promise.allSettled(launches)
            results.sort((a, b) => a.railIndex - b.railIndex)
            const launched = results.filter((r) => r.outcome === 'launched').length
            const skipped = results.filter((r) => r.outcome === 'skipped').length
            const failed = results.filter((r) => r.outcome === 'failed').length
            return {
              launched, skipped, failed, results,
              hint: launched > 0
                ? 'Launches accepted (202) and running IN PARALLEL in isolated worktrees. Report the per-rail ids verbatim and release the turn — progress streams live; re-check later with specrails_jobs(get) or specrails_watch on request.'
                : 'No rail was launched — see per-rail reasons. Assign tickets with set_tickets (create_rail if no free rail) and retry.',
            }
          }

          case 'stop': {
            const railIndex = requireRailIndex()
            return apiCall(ctx, 'POST', `${base}/${railIndex}/stop`)
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
