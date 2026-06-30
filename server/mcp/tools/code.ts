import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * Read-only Code Explorer surface for a project: the AI-touched file tree,
 * file contents + plain-language AI summaries, "touched by AI" provenance, and
 * stored per-file diffs — plus the one cost-incurring action, regenerating a
 * file's AI summary (async, fire-and-forget over WS).
 *
 * Every op is per-project under `/api/projects/:projectId/code/*`. The v1 edit
 * path (PUT /code/file) is intentionally NOT exposed — Code Explorer is
 * read-only here. The app-level GET/PATCH /api/code-explorer-settings ops are
 * app-scoped settings, surfaced by the settings domain, not here.
 *
 * Encode query strings explicitly so file paths with spaces/`#`/`?` survive.
 */
export function codeTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_code',
      title: 'Code Explorer',
      description:
        'Read-only browse a project\'s source through the Code Explorer: list the file tree ' +
        '(default scoped to AI-touched files, optional provenance rollup), read a file with its ' +
        'AI summary + staleness + provenance, fetch a stored summary alone, regenerate a file\'s ' +
        'AI summary (cost-incurring, async), list "touched by AI" provenance rows, and fetch the ' +
        'stored unified-diff a job applied to a file. ' +
        'Actions: tree, read_file, summary, regenerate_summary (ai-spawn — spawns an AI CLI, ' +
        'incurs cost, returns 202 then completes over WS), provenance, diff. ' +
        'Requires SPECRAILS_CODE_EXPLORER (default on); the /code prefix 404s when disabled.',
      hintTier: 'read',
      tier: (a) => (a.action === 'regenerate_summary' ? 'ai-spawn' : 'read'),
      inputSchema: {
        action: z
          .enum(['tree', 'read_file', 'summary', 'regenerate_summary', 'provenance', 'diff'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        path: z
          .string()
          .optional()
          .describe(
            'Project-relative file path. Required for read_file/summary/regenerate_summary/diff; ' +
              'optional narrowing filter for provenance.',
          ),
        filter: z
          .enum(['touched-by-ai', 'all'])
          .optional()
          .describe('tree only: scope to AI-touched files (default) or the whole repo'),
        withProvenance: z
          .boolean()
          .optional()
          .describe('tree only: include per-file/dir provenance rollup (created-by / modified-by chips)'),
        cursor: z
          .string()
          .optional()
          .describe('tree only: opaque pagination cursor from a prior response\'s nextCursor'),
        ticketId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('tree/provenance: narrow to files touched by this ticket'),
        jobId: z
          .string()
          .optional()
          .describe('tree/provenance/diff: narrow to a job; required for diff'),
        overrideBudget: z
          .boolean()
          .optional()
          .describe(
            'regenerate_summary only: bypass the monthly summary budget cap. Privileged — ' +
              'incurs cost beyond the configured limit.',
          ),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string

        const requirePath = (): string => {
          const p = args.path as string | undefined
          if (!p || p.trim() === '') throw new Error(`Action "${action}" requires a "path".`)
          return p
        }

        switch (action) {
          case 'tree': {
            const qs = new URLSearchParams()
            if (args.filter) qs.set('filter', args.filter as string)
            if (args.withProvenance === true) qs.set('withProvenance', '1')
            if (args.cursor) qs.set('cursor', args.cursor as string)
            if (typeof args.ticketId === 'number') qs.set('ticketId', String(args.ticketId))
            if (args.jobId) qs.set('jobId', args.jobId as string)
            const suffix = qs.toString() ? `?${qs.toString()}` : ''
            return apiCall(ctx, 'GET', `${base}/code/tree${suffix}`)
          }

          case 'read_file': {
            const qs = new URLSearchParams({ path: requirePath() })
            return apiCall(ctx, 'GET', `${base}/code/file?${qs.toString()}`)
          }

          case 'summary': {
            const qs = new URLSearchParams({ path: requirePath() })
            return apiCall(ctx, 'GET', `${base}/code/summary?${qs.toString()}`)
          }

          case 'regenerate_summary': {
            const qs = new URLSearchParams({ path: requirePath() })
            const r = (await apiCall(
              ctx,
              'POST',
              `${base}/code/file/regenerate-summary?${qs.toString()}`,
              { overrideBudget: args.overrideBudget === true },
            )) as Record<string, unknown>
            // 202 → enqueued; 200 → { skipped: '...' }. Either way the real
            // outcome (summary ready / failed / skipped) arrives over WS, not in
            // this response, so always point the caller at the live channel.
            return {
              ...r,
              hint:
                'Summary generation is async and cost-incurring. The outcome arrives over the ' +
                'WS channel as file.summary_updated / file.summary_failed / file.summary_skipped ' +
                "(reason: 'budget'|'per-job-cap'|'ttl'|'not-found'), NOT in this response. A 202 " +
                '{ enqueued: true } only means it was queued; a 200 { skipped } means it never ran.',
            }
          }

          case 'provenance': {
            const qs = new URLSearchParams()
            if (typeof args.ticketId === 'number') qs.set('ticketId', String(args.ticketId))
            if (args.jobId) qs.set('jobId', args.jobId as string)
            if (args.path) qs.set('path', args.path as string)
            if (![...qs.keys()].length) {
              throw new Error('Action "provenance" requires at least one of: ticketId, jobId, path.')
            }
            return apiCall(ctx, 'GET', `${base}/code/provenance?${qs.toString()}`)
          }

          case 'diff': {
            const jobId = args.jobId as string | undefined
            if (!jobId) throw new Error('Action "diff" requires a "jobId".')
            const qs = new URLSearchParams({ jobId, path: requirePath() })
            return apiCall(ctx, 'GET', `${base}/code/diff?${qs.toString()}`)
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
