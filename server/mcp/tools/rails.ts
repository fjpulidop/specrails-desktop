import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, originConversationDefaults, McpApiError } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function prDeliveryContinuesTickets(raw: unknown, ticketIds: number[]): boolean {
  if (!isRecord(raw)) return false
  const decision = raw.decision
  if (decision !== 'pr_draft' && decision !== 'pr_ready') return false
  if (typeof raw.prUrl !== 'string' || !raw.prUrl) return false
  if (typeof raw.branch !== 'string' || !raw.branch) return false
  if (raw.prState !== 'pr-created') return false
  if (!Array.isArray(raw.ticketIds)) return false
  const covered = new Set(raw.ticketIds.filter((id): id is number => typeof id === 'number'))
  return ticketIds.length > 0 && ticketIds.every((id) => covered.has(id))
}

/**
 * Rails domain facade. A "rail" is a numbered launch slot per project: it holds
 * a set of assigned ticket IDs plus a mode/profile/engine/name, and launching it
 * spawns the selected installed provider's AI pipeline over those tickets.
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
        'Parallel launches normally run in isolated git worktrees; verify the returned isolated flag. Legacy or non-git runs may use shared project files and have no delivery card. ' +
        'Actions: list (rails + active jobs/loop runs), pr_candidates (read compatible open PR targets for railIndex), review_packet (read durable evidence, verification and acceptance capability by prDeliveryId), create_rail (add a new rail slot; returns its railIndex), set_tickets (assign ticket IDs), set_profile (default agent profile, null=legacy), ' +
        'set_engine (provider override, null=primary), set_name (display label, null clears), ' +
        'launch (ai-spawn — spawns the selected installed provider CLI job(s), including Kimi when installed, that WRITE CODE, RUN TESTS, COMMIT, and INCUR TOKEN COST; returns 202 with jobId/jobIds/loopRunIds), ' +
        'launch_all (ai-spawn — launches EVERY rail that has tickets and no active run/uncontinuable pending PR decision, in parallel, using each rail\'s stored mode/engine/profile; returns per-rail outcomes with skip reasons), ' +
        'stop (destructive — kills all active jobs and loop runs for the rail). ' +
        'For on_review tickets with an already-open GitHub PR (including a published pr_ready delivery), launch automatically tries to continue that PR head branch; Jira-linked in_progress tickets can do the same when the PR match is explicit; fresh tickets still start from the project integration branch. ' +
        'When launched from the in-app agent chat without an explicit aiEngine, the engine defaults to your conversation\'s provider. On that same provider, an omitted model inherits the conversation model; an explicit model wins (pass aiEngine to override; launch_all always uses each rail\'s stored engine). ' +
        'User-facing naming: call the free-form autonomous mode "Freestyle"; use "freestyle" as the canonical API enum value for that same capability. ' +
        'For small OpenSpec-governed work, recommend "SDD Quick (OpenSpec)" and launch with mode "loop" plus loopId "factory:sdd-quick-openspec"; keep Freestyle for ticket-local implementation-only work. ' +
        'NAMING: railIndex is the 0-BASED internal identity; the dashboard shows rails 1-based ("Rail N" = railIndex N-1). When talking to the user, ALWAYS say "Rail <railIndex + 1>" (or the rail\'s custom name) — results include railLabel with the correct user-facing label.',
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
          .enum(['list', 'pr_candidates', 'review_packet', 'create_rail', 'set_tickets', 'set_profile', 'set_engine', 'set_name', 'launch', 'launch_all', 'stop'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        railIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Rail slot index, 0-BASED (required except list, create_rail, launch_all and review_packet). The dashboard labels rails 1-based: UI "Rail N" = railIndex N-1.'),
        prDeliveryId: z.string().optional().describe('Delivery id returned by list/prDeliveries (required for review_packet)'),
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
          .enum(['implement', 'batch-implement', 'freestyle', 'loop'])
          .optional()
          .describe('Launch mode (launch; default "implement"). Use "freestyle" as the canonical API enum value for Freestyle. It invokes the selected provider\'s native free-form autonomous workflow (currently Claude and Kimi), one job per ticket. In prose, call it "Freestyle". Loop runs an app-driven loop per ticket.'),
        model: z
          .string()
          .optional()
          .describe('Model for launch. Defaults to the launching conversation model when the engine matches; an explicit model wins. For Freestyle or loop mode, pass a model string valid for the selected installed provider; Kimi preserves configured model aliases. Freestyle availability is capability-gated by provider.'),
        interactive: z
          .boolean()
          .optional()
          .describe('DEPRECATED — accepted and ignored: Freestyle jobs are interactive by default whenever the interactive-jobs feature is enabled'),
        loopId: z
          .string()
          .optional()
          .describe('Loop id to run (launch). Use "factory:sdd-quick-openspec" for SDD Quick (OpenSpec): small OpenSpec-governed work via mode="loop". Factory ids (e.g. "factory:implement") map to a legacy mode; a custom published loop id keeps mode="loop". Browse/author loops with specrails_loops; the loop must be Published.'),
        reasoning_effort: z
          .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
          .optional()
          .describe('Provider-supported reasoning-effort tier for loop launches. Kimi K3 supports low/high/max; the server validates against the selected provider.'),
        targetPrNumber: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Deliver INTO an existing open PR instead of creating a new one (launch). When the user names an existing PR ("extend PR #151"), pass its number here — the rail then works on that PR\'s head branch and settle pushes to it; NEVER launch without it in that case (a plain launch would create a duplicate PR). The PR must be open and same-repo (fork PRs are rejected with target_pr_fork).'),
        revisionOfDeliveryId: z
          .string()
          .optional()
          .describe('Revise a delivery that is ALREADY awaiting the user\'s decision (launch). This is the only way to launch against an undecided delivery: pass its prDeliveryId (from rails.prDeliveries) together with revisionNote. Use it whenever the user asks for a change to work you already delivered — never publish/discard/merge first. The rail must still carry exactly that delivery\'s specs.'),
        revisionNote: z
          .string()
          .optional()
          .describe('What to change, in the user\'s own words (required with revisionOfDeliveryId). It is injected into the revision run and shown on the updated review packet as "what you asked to change".'),
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

          case 'pr_candidates':
            return apiCall(ctx, 'GET', `${base}/${requireRailIndex()}/pr-candidates`)

          case 'review_packet': {
            if (typeof args.prDeliveryId !== 'string' || !args.prDeliveryId.trim()) {
              throw new Error('review_packet requires "prDeliveryId" from list/prDeliveries.')
            }
            return apiCall(ctx, 'GET', `${base}/pr-deliveries/${encodeURIComponent(args.prDeliveryId)}/packet`)
          }

          case 'create_rail': {
            const body: Record<string, unknown> = {}
            if (typeof args.name === 'string' && args.name.trim()) body.name = (args.name as string).trim()
            const r = await apiCall(ctx, 'POST', base, body)
            const created = (r as { rail?: { railIndex?: number } }).rail
            const label =
              typeof created?.railIndex === 'number' ? `Rail ${created.railIndex + 1}` : undefined
            return {
              ...(r as Record<string, unknown>),
              ...(label ? { railLabel: label } : {}),
              hint: `Rail created${label ? ` — the user sees it as "${label}" (railIndex is 0-based, UI labels are 1-based; refer to it as "${label}" when talking to the user)` : ''}. Assign tickets with set_tickets on the returned railIndex, then launch. Up to 12 rails per project.`,
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
            if (args.targetPrNumber !== undefined) body.targetPrNumber = args.targetPrNumber as number
            // Revision of a delivery already awaiting the user's decision: the
            // ONE launch allowed against an undecided delivery. The route
            // re-validates the exemption (must be the rail's active delivery and
            // cover its full spec set), so a wrong id fails closed there.
            if (args.revisionOfDeliveryId !== undefined) body.revisionOfDeliveryId = args.revisionOfDeliveryId as string
            if (args.revisionNote !== undefined) body.revisionNote = args.revisionNote as string
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
            // conversation's already-provider-validated reasoning effort rides
            // along only when this launch targets that same provider. Dashboard / external-client
            // calls (no origin conversation) are byte-identical to before.
            const defaults = originConversationDefaults(ctx)
            if (body.aiEngine === undefined && defaults.provider) {
              body.aiEngine = defaults.provider
            }
            if (body.model === undefined && defaults.model && body.aiEngine === defaults.provider) {
              body.model = defaults.model
            }
            if (
              body.reasoning_effort === undefined &&
              defaults.reasoningEffort &&
              defaults.provider &&
              body.aiEngine === defaults.provider &&
              // Effort is model-specific (Astra's ultra is not valid for
              // GPT-5.5). An explicit different model gets its own default.
              (!defaults.model || body.model === defaults.model)
            ) {
              body.reasoning_effort = defaults.reasoningEffort
            }
            const r = await apiCall(ctx, 'POST', `${base}/${railIndex}/launch`, body) as Record<string, unknown>
            const railLabel = `Rail ${railIndex + 1}`
            // Isolation status governs whether a PR-decision card EXISTS. When
            // the router reports `isolationUnavailable`, the run fell back to the
            // shared working tree: NO git worktree, NO PR delivery row, and so
            // NO implementation/PR card will EVER appear (not in this chat, not
            // in the rail header). The agent MUST NOT promise one — it must tell
            // the user the run writes changes DIRECTLY to their files and why.
            const isoReason = typeof r.isolationUnavailable === 'string' ? r.isolationUnavailable : null
            if (isoReason) {
              const why = isoReason === 'no-git'
                ? 'the project folder is NOT a git repository'
                : isoReason === 'no-commits'
                  ? 'the git repository has NO commits yet (an unborn HEAD cannot be branched)'
                  : `worktree isolation failed${typeof r.isolationUnavailableDetail === 'string' ? `: ${r.isolationUnavailableDetail}` : ''}`
              const fix = isoReason === 'error'
                ? 'This is unexpected — report the detail to the user.'
                : 'To get the PR flow, the user should `git init` the folder and make at least one commit (a GitHub remote is NOT required — the review flow then offers "Integrate locally" to accept without GitHub), then relaunch.'
              return {
                ...r,
                railLabel,
                hint: `Launch accepted (202) on ${railLabel}, but WORKTREE ISOLATION IS UNAVAILABLE because ${why}. The run proceeds on the SHARED working tree and writes changes DIRECTLY into the user's files — there is NO PR-decision/implementation card and NO branch. Do NOT tell the user to look for a PR card; tell them the run writes to their files in place, and explain why. ${fix} When it finishes, the spec parks at on_review — the user accepts it by moving it to Done on the board (the changes are already in their files) or reverts the spec's status (which does NOT undo the file changes).`,
              }
            }
            if (r.isolated !== true) {
              return {
                ...r,
                railLabel,
                hint: `Launch accepted (202) on ${railLabel}. The server did not report worktree isolation (the legacy/shared checkout path may be enabled); do not promise a separate branch or delivery card. Read the returned jobId/jobIds with specrails_jobs(get) or use specrails_watch(ref:jobId, kind:"job"); for loopRunIds use kind:"loop_run".`,
              }
            }
            return {
              ...r,
              railLabel,
              hint: `Launch accepted (202) on ${railLabel} (isolated worktree, PR flow active) — tell the user it runs on "${railLabel}" (UI labels are 1-based). If the assigned spec is on_review with a matching open PR, including an already-published pr_ready PR, or is Jira-linked in_progress with an explicit PR match, Specrails continues that PR branch automatically; otherwise it starts a fresh branch from the integration branch. The PR-decision card will appear here and on the rail header when it settles. Use specrails_watch(ref:loopRunId, kind:"loop_run") for each returned loopRunId to inspect completion. Rails run for minutes; pass untilMs up to 600000 and re-watch on timeout. Settled does not imply successful delivery: read rails(list) and review_packet for verification and blockers.`,
            }
          }

          case 'launch_all': {
            // Server-side fan-out: launch every eligible rail IN PARALLEL — safe
            // because each launch isolates its work in per-ticket git worktrees
            // (allocation is serialized per repo by the launch path itself).
            // Eligibility mirrors the dashboard's Launch-all control: the rail
            // must hold tickets, have no active job/loop run, and no uncontinuable
            // PR delivery. A draft/published PR covering the rail's tickets is
            // intentionally continuable. Each rail launches with its OWN stored config
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
              /** User-facing 1-based dashboard label ("Rail <railIndex+1>"). */
              railLabel?: string
              outcome: 'launched' | 'skipped' | 'failed'
              reason?: 'empty' | 'already-running' | 'pr-decision-pending' | 'tickets-in-flight'
              mode?: string
              ticketIds?: number[]
              jobId?: string
              jobIds?: string[]
              loopRunIds?: string[]
              prDeliveryId?: string
              isolationUnavailable?: string
              isolationUnavailableDetail?: string
              isolated?: boolean
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
              if (key in prDeliveries && !prDeliveryContinuesTickets(prDeliveries[key], ticketIds)) {
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
                      ...(typeof data.isolationUnavailable === 'string' ? { isolationUnavailable: data.isolationUnavailable } : {}),
                      ...(typeof data.isolationUnavailableDetail === 'string' ? { isolationUnavailableDetail: data.isolationUnavailableDetail } : {}),
                      ...(typeof data.prDeliveryId === 'string' ? { prDeliveryId: data.prDeliveryId } : {}),
                      ...(typeof data.isolated === 'boolean' ? { isolated: data.isolated } : {}),
                    })
                  })
                  .catch((err: unknown) => {
                    // Race-safe: a 409 raised between the snapshot and the launch
                    // maps back to its skip reason instead of a hard failure.
                    const message = err instanceof Error ? err.message : String(err)
                    if (err instanceof McpApiError && err.status === 409 && err.code === 'pr_decision_pending') {
                      results.push({ railIndex: idx, outcome: 'skipped', reason: 'pr-decision-pending', ticketIds })
                    } else if (err instanceof McpApiError && err.status === 409 && err.code === 'tickets_in_flight') {
                      results.push({ railIndex: idx, outcome: 'skipped', reason: 'tickets-in-flight', ticketIds })
                    } else {
                      results.push({ railIndex: idx, outcome: 'failed', ticketIds, error: message })
                    }
                  }),
              )
            }
            await Promise.allSettled(launches)
            results.sort((a, b) => a.railIndex - b.railIndex)
            for (const r of results) r.railLabel = `Rail ${r.railIndex + 1}`
            const launched = results.filter((r) => r.outcome === 'launched').length
            const skipped = results.filter((r) => r.outcome === 'skipped').length
            const failed = results.filter((r) => r.outcome === 'failed').length
            return {
              launched, skipped, failed, results,
              hint: launched > 0
                ? 'Launches accepted (202) and running in parallel. Check each result: isolationUnavailable means that rail writes directly into project files and has NO delivery card; explain that limitation. Report the per-rail ids verbatim; progress streams live. Use specrails_watch(kind:"loop_run", ref:loopRunId) or specrails_jobs(get) to inspect completion.'
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
