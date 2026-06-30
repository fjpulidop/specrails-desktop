import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

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
        'A rail holds assigned ticket IDs plus a mode/profile/engine/name. ' +
        'Actions: list (rails + active jobs/loop runs), set_tickets (assign ticket IDs), set_profile (default agent profile, null=legacy), ' +
        'set_engine (provider override, null=primary), set_name (display label, null clears), ' +
        'launch (ai-spawn — spawns claude/codex/gemini CLI job(s) that WRITE CODE, RUN TESTS, COMMIT, and INCUR TOKEN COST; returns 202 with jobId/jobIds/loopRunIds), ' +
        'stop (destructive — kills all active jobs and loop runs for the rail).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'stop') return 'destructive'
        if (action === 'launch') return 'ai-spawn'
        if (action === 'set_tickets' || action === 'set_profile' || action === 'set_engine' || action === 'set_name') return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum(['list', 'set_tickets', 'set_profile', 'set_engine', 'set_name', 'launch', 'stop'])
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
          .describe('AI engine/provider override; null = project primary (set_engine; also optional override for launch). Must be an installed provider.'),
        // set_name
        name: z
          .string()
          .nullable()
          .optional()
          .describe('Rail display label (<=60 chars); null/empty clears to default (set_name)'),
        // launch
        mode: z
          .enum(['implement', 'batch-implement', 'ultracode', 'loop'])
          .optional()
          .describe('Launch mode (launch; default "implement"). ultracode is Claude-only and runs one job per ticket; loop runs an app-driven loop per ticket.'),
        model: z
          .enum(['haiku', 'sonnet', 'opus'])
          .optional()
          .describe('Ultracode Claude model (launch, ultracode mode only). For loop mode, a provider-valid model string.'),
        interactive: z
          .boolean()
          .optional()
          .describe('Interactive ultracode session (launch, ultracode + Claude only; requires the interactive-jobs feature)'),
        loopId: z
          .string()
          .optional()
          .describe('Loop id to run (launch). Factory ids (e.g. "factory:implement") map to a legacy mode; a custom published loop id keeps mode="loop".'),
        reasoning_effort: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe('Reasoning-effort tier for loop launches (launch, loop mode)'),
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
            const r = await apiCall(ctx, 'POST', `${base}/${railIndex}/launch`, body)
            return {
              ...(r as Record<string, unknown>),
              hint: 'Launch accepted (202). Use specrails_watch with the returned jobId/jobIds (or loopRunIds for loop mode) to await completion. Live output streams over the job WS.',
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
