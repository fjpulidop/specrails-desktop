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
 * read-only here. The app-level code-explorer settings (summary language +
 * monthly summary budget) are surfaced by specrails_settings
 * (summaryLanguage / summaryMonthlyBudgetUsd), not here.
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
        '(default scoped to AI-touched files, optional provenance rollup), locate a file by name / ' +
        'path suffix, read a bounded file range with a stable content hash, fetch a stored ' +
        'summary alone, regenerate a file\'s AI summary (cost-incurring, async), list "touched by ' +
        'AI" provenance rows, and fetch the stored unified-diff a job applied to a file. ' +
        'Actions: tree, find (name / path-suffix / fragment → ranked project-relative paths; use it ' +
        'when read_file 404s — a path copied from a stack trace or import is usually relative to a ' +
        'subdirectory), search (literal source content, scoped path and explicit scan budgets), ' +
        'read_file (bounded line/column pages with hash and continuation, default 200 lines), summary, regenerate_summary (ai-spawn — spawns an AI CLI, ' +
        'incurs cost, returns 202 then completes over WS), provenance, diff. ' +
        'Requires SPECRAILS_CODE_EXPLORER (default on); the /code prefix 404s when disabled.',
      hintTier: 'read',
      tier: (a) => (a.action === 'regenerate_summary' ? 'ai-spawn' : 'read'),
      inputSchema: {
        action: z
          .enum(['tree', 'find', 'search', 'read_file', 'summary', 'regenerate_summary', 'provenance', 'diff'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        path: z
          .string()
          .optional()
          .describe(
            'Project-relative file path. Required for read_file/summary/regenerate_summary/diff; ' +
              'optional directory/file prefix for search or narrowing filter for provenance.',
          ),
        file: z
          .string()
          .optional()
          .describe('Compatibility alias for path (accepted for read_file/summary/regenerate_summary/diff)'),
        query: z
          .string()
          .optional()
          .describe(
            'search: literal single-line source text (not regex). find: file name, path suffix (e.g. components/detail/LessonView.tsx) or fragment ' +
              'to locate, case-insensitive. Falls back to path/file when omitted.',
          ),
        filter: z
          .enum(['touched-by-ai', 'all'])
          .optional()
          .describe('tree only: scope to AI-touched files (default) or the whole repo'),
        caseSensitive: z.boolean().optional().describe('search only: match exact character case (default false)'),
        startLine: z.number().int().positive().optional().describe('read_file only: first line, 1-based (default 1)'),
        endLine: z.number().int().positive().optional().describe('read_file only: last line inclusive (default startLine + 199; at most 500 lines returned)'),
        startColumn: z.number().int().positive().optional().describe('read_file only: resume at nextColumn when a long line was split by the character budget (default 1)'),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe('read_file only: hash from the previous page/search; rejects changed files so pages cannot silently mix revisions'),
        withProvenance: z
          .boolean()
          .optional()
          .describe('tree only: include per-file/dir provenance rollup (created-by / modified-by chips)'),
        cursor: z
          .string()
          .optional()
          .describe('tree only: opaque pagination cursor from a prior response\'s nextCursor'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('tree: entries per page (default 200, maximum 500); find: matches (default 20, max 50); search: matching lines (default 30, max 100)'),
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
          const p = (args.path ?? args.file) as string | undefined
          if (!p || p.trim() === '') throw new Error(`Action "${action}" requires a "path".`)
          return p
        }

        // A bare `→ 404: {"error":"file not found"}` sent callers into a
        // ToolSearch/retry loop: the path they hold is usually right, just
        // relative to a subdirectory. Point them at `find` instead of leaving
        // them to page through `tree`.
        const withNotFoundHint = async (p: string, run: () => Promise<unknown>): Promise<unknown> => {
          try {
            return await run()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (!/→ 404: .*file not found/.test(msg)) throw err
            const base = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p
            throw new Error(
              `${msg}. Paths are relative to the project root and "${p}" may live under a subdirectory ` +
                '(a path copied from a stack trace or import usually does). Locate it with ' +
                `specrails_code(action: "find", query: ${JSON.stringify(base)}) and retry with the returned path.`,
            )
          }
        }

        switch (action) {
          case 'tree': {
            const qs = new URLSearchParams()
            if (args.filter) qs.set('filter', args.filter as string)
            if (args.withProvenance === true) qs.set('withProvenance', '1')
            if (args.cursor) qs.set('cursor', args.cursor as string)
            qs.set('limit', String(typeof args.limit === 'number' ? args.limit : 200))
            if (typeof args.ticketId === 'number') qs.set('ticketId', String(args.ticketId))
            if (args.jobId) qs.set('jobId', args.jobId as string)
            const suffix = qs.toString() ? `?${qs.toString()}` : ''
            const result = await apiCall(ctx, 'GET', `${base}/code/tree${suffix}`) as Record<string, unknown>
            if (args.withProvenance === true || !Array.isArray(result.entries)) return result
            return {
              ...result,
              entries: result.entries.map((entry) => {
                const item = entry as Record<string, unknown>
                return { path: item.path, kind: item.kind }
              }),
              hint: result.nextCursor
                ? 'More files are available. Call tree again with this nextCursor; prefer targeted read_file calls.'
                : 'Tree complete. Prefer targeted read_file calls.',
            }
          }

          case 'find': {
            const q = ((args.query ?? args.path ?? args.file) as string | undefined)?.trim()
            if (!q) throw new Error('Action "find" requires a "query" (file name, path suffix or fragment).')
            const qs = new URLSearchParams({ q })
            qs.set('limit', String(typeof args.limit === 'number' ? Math.min(args.limit, 50) : 20))
            const r = (await apiCall(ctx, 'GET', `${base}/code/find?${qs.toString()}`)) as Record<string, unknown>
            const matches = Array.isArray(r.matches) ? r.matches : []
            return {
              ...r,
              hint: matches.length
                ? 'Call read_file with one of these project-relative paths (best match first).'
                : r.truncated
                  ? 'Partial scan found no matches; this does not prove absence. Narrow the query and retry or inspect the project tree.'
                  : 'No file matches. The scan skips build/dependency trees, dot-directories and gitignored paths; ' +
                  'try a shorter fragment or the bare file name.',
            }
          }

          case 'search': {
            const query = args.query as string | undefined
            if (!query?.trim()) throw new Error('Action "search" requires a literal source-text "query".')
            if (typeof args.limit === 'number' && args.limit > 100) throw new Error('Action "search" limit must be at most 100.')
            const qs = new URLSearchParams({ q: query, limit: String(args.limit ?? 30), caseSensitive: String(args.caseSensitive === true) })
            if (args.path) qs.set('path', args.path as string)
            return apiCall(ctx, 'GET', `${base}/code/search?${qs.toString()}`)
          }

          case 'read_file': {
            const p = requirePath()
            const startLine = typeof args.startLine === 'number' ? args.startLine : 1
            const endLine = typeof args.endLine === 'number' ? args.endLine : startLine + 199
            if (endLine < startLine) throw new Error('endLine must be greater than or equal to startLine.')
            const qs = new URLSearchParams({ path: p, startLine: String(startLine), endLine: String(endLine) })
            if (args.startColumn !== undefined) qs.set('startColumn', String(args.startColumn))
            if (args.expectedHash) qs.set('expectedHash', args.expectedHash as string)
            return withNotFoundHint(p, () => apiCall(ctx, 'GET', `${base}/code/file?${qs.toString()}`))
          }

          case 'summary': {
            const p = requirePath()
            const qs = new URLSearchParams({ path: p })
            return withNotFoundHint(p, () => apiCall(ctx, 'GET', `${base}/code/summary?${qs.toString()}`))
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
