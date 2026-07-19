import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * Build a `?a=b&c=d` query string from a flat record, skipping undefined/null/''
 * values. Arrays are joined with commas (the spending router parses CSV for
 * surface/model/modelProvider/provider). Used by the read actions below.
 */
function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    const value = Array.isArray(v) ? v.join(',') : String(v)
    if (value === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export function analyticsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_analytics',
      title: 'Analytics & Spending',
      description:
        'Per-project cost analytics over billable AI-CLI invocations (jobs, quick-spec, explore-spec, ai-edit, smash, file-summary, loop). ' +
        'All read-only except set_budget. Actions: ' +
        'spending (full dashboard: cost summary with prev-period delta, by-surface/model/mode/provider breakdowns, daily timeline, cost-vs-turns scatter, top tickets), ' +
        'invocations (paginated raw invocation table), ' +
        'ticket_summary (per-ticket cost aggregate across all surfaces), ' +
        'export (download summary/raw analytics as CSV or JSON — file download, returns a note + headers), ' +
        'budget_get (daily budget, per-job threshold, cost-today, utilization %), ' +
        'budget_set (write — set/clear daily budget cap + per-job cost threshold; a too-low budget pauses the job queue). ' +
        'Prefer spending over invocations/export-raw for token economy. ' +
        'Filters: period(7d|30d|90d|all|custom), from/to (ISO, required for custom), surface[], model[], modelProvider[] (index-aligned to model), provider[], status(success|failed|aborted), minCostUsd, ticketId, tzOffsetMinutes(±840 — pass the user local offset so "today" lines up), sortBy.',
      hintTier: 'read',
      tier: (a) => (a.action === 'budget_set' ? 'write' : 'read'),
      inputSchema: {
        action: z
          .enum(['spending', 'invocations', 'ticket_summary', 'export', 'budget_get', 'budget_set'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),

        // ─── Filters shared by spending / invocations / export ────────────────
        period: z
          .enum(['7d', '30d', '90d', 'all', 'custom'])
          .optional()
          .describe('Time window (default 30d). "custom" requires from + to.'),
        from: z.string().optional().describe('ISO start date (required when period=custom)'),
        to: z.string().optional().describe('ISO end date (required when period=custom)'),
        surface: z
          .array(z.enum(['job', 'quick-spec', 'explore-spec', 'ai-edit', 'smash', 'file-summary', 'loop']))
          .optional()
          .describe('Filter to these surfaces (CSV)'),
        model: z.array(z.string()).optional().describe('Filter to these model ids (CSV)'),
        modelProvider: z
          .array(z.string())
          .optional()
          .describe('Providers index-aligned to model[] (scopes each model id to its provider so native or estimated costs from claude/codex/gemini/kimi do not merge into another provider\'s bar)'),
        provider: z
          .array(z.string())
          .optional()
          .describe('Filter to these providers (e.g. claude, codex, gemini, kimi) (CSV)'),
        status: z.enum(['success', 'failed', 'aborted']).optional().describe('Filter by invocation status'),
        minCostUsd: z.number().optional().describe('Only invocations costing at least this many USD'),
        ticketId: z.number().int().optional().describe('Scope to a single ticket id'),
        tzOffsetMinutes: z
          .number()
          .int()
          .optional()
          .describe('Local UTC offset in minutes (±840) for daily-timeline calendar-day bucketing (default 0 = UTC)'),
        sortBy: z.enum(['recency', 'cost']).optional().describe('Sort order'),

        // ─── invocations pagination ───────────────────────────────────────────
        limit: z
          .number()
          .int()
          .optional()
          .describe('invocations: max rows (clamped server-side to [1, 10000])'),
        offset: z.number().int().optional().describe('invocations: row offset for pagination'),

        // ─── ticket_summary ───────────────────────────────────────────────────
        id: z.number().int().optional().describe('ticket_summary: the ticket id to aggregate'),

        // ─── export ───────────────────────────────────────────────────────────
        format: z.enum(['csv', 'json']).optional().describe('export: output format (default json)'),
        mode: z
          .enum(['summary', 'raw'])
          .optional()
          .describe('export: summary (aggregated dashboard) or raw (up to 10000 invocation rows). Default summary.'),

        // ─── budget_set ───────────────────────────────────────────────────────
        dailyBudgetUsd: z
          .number()
          .nullable()
          .optional()
          .describe('budget_set: daily budget cap USD (>0); null clears it. PER-PROJECT daily cap — pauses this project\'s queue when exceeded. For the app-wide budget across all projects use specrails_settings.'),
        jobCostThresholdUsd: z
          .number()
          .nullable()
          .optional()
          .describe('budget_set: per-job cost alert threshold USD (>0); null clears it'),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string

        const filters = {
          period: args.period as string | undefined,
          from: args.from as string | undefined,
          to: args.to as string | undefined,
          surface: args.surface as string[] | undefined,
          model: args.model as string[] | undefined,
          modelProvider: args.modelProvider as string[] | undefined,
          provider: args.provider as string[] | undefined,
          status: args.status as string | undefined,
          minCostUsd: args.minCostUsd as number | undefined,
          ticketId: args.ticketId as number | undefined,
          tzOffsetMinutes: args.tzOffsetMinutes as number | undefined,
          sortBy: args.sortBy as string | undefined,
        }

        switch (action) {
          case 'spending':
            return apiCall(ctx, 'GET', `${base}/spending${buildQuery(filters)}`)

          case 'invocations':
            return apiCall(
              ctx,
              'GET',
              `${base}/invocations${buildQuery({
                ...filters,
                limit: args.limit as number | undefined,
                offset: args.offset as number | undefined,
              })}`,
            )

          case 'ticket_summary': {
            const id = args.id as number | undefined
            if (id === undefined || id === null) {
              throw new Error('ticket_summary requires an "id" (ticket id).')
            }
            return apiCall(ctx, 'GET', `${base}/tickets/${id}/spending-summary`)
          }

          case 'export': {
            // GET /analytics/export streams a file download (Content-Disposition).
            // apiCall returns the body text/JSON; for CSV it is the raw CSV string,
            // for JSON the parsed dashboard/invocations object. We surface it
            // inline with a note since there is no file sink over MCP.
            const format = (args.format as string | undefined) ?? 'json'
            const mode = (args.mode as string | undefined) ?? 'summary'
            const data = await apiCall(
              ctx,
              'GET',
              `${base}/analytics/export${buildQuery({ ...filters, format, mode })}`,
            )
            return {
              note: `Analytics export (mode=${mode}, format=${format}). This endpoint is normally a file download; the content is returned inline below. Raw mode caps at 10000 rows. Prefer the "spending" action for already-aggregated, bounded data.`,
              format,
              mode,
              data,
            }
          }

          case 'budget_get':
            return apiCall(ctx, 'GET', `${base}/budget`)

          case 'budget_set': {
            const body: Record<string, unknown> = {}
            if ('dailyBudgetUsd' in args) body.dailyBudgetUsd = args.dailyBudgetUsd
            if ('jobCostThresholdUsd' in args) body.jobCostThresholdUsd = args.jobCostThresholdUsd
            if (Object.keys(body).length === 0) {
              throw new Error('budget_set requires dailyBudgetUsd and/or jobCostThresholdUsd (number>0 to set, null to clear).')
            }
            return apiCall(ctx, 'PATCH', `${base}/budget`, body)
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
