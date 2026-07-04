import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * Per-project Jira integration facade. Maps each action to the corresponding
 * `/api/projects/:projectId/jira/*` route (server/jira-router.ts). Every op is
 * project-scoped and external-network-bound (live HTTPS to the customer's Jira
 * Cloud / Data Center instance with their stored or supplied credentials).
 *
 * SECURITY: the Jira API token / PAT is a high-value SECRET. It is passed as a
 * plaintext `token` field on test / discover_projects / discover_statuses /
 * connect; never log or echo it, and it is never returned on reads (GET
 * /connection redacts it to `hasToken`).
 *
 * ID SCOPING: spec_details / discard_spec take the LOCAL monotonic ticket id
 * (NOT a Jira `PROJ-123` key); retry_outbox takes the LOCAL outbox row id. Map
 * Jira keys → local ids via the `links` action first.
 */
export function jiraTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_jira',
      title: 'Jira integration',
      description:
        'Manage a project\'s Jira-backed specs (each project syncs with its own Jira board). Read connection/links/outbox, run the connect wizard, sync, and create/discard Jira-backed specs. ' +
        'Actions: connection (get current connection, token redacted), test (validate creds), discover_projects, discover_statuses (with throwaway creds), connect (persist connection — write), update_connection (enable/disable hot-swap + statusMap/discardStatus — write), disconnect (remove connection + restore local write access — destructive), statuses (connected project\'s real statuses), sync (full re-fetch of the board — write, long-running on big boards), resume (drain parked outbox after re-auth — write), outbox (list ops + counts), retry_outbox (re-queue a dead-lettered op — write), create_spec (create a real Jira issue — write), discard_spec (move linked issue to discard status — write), spec_details (read-only Jira fields + dev panel), links (spec↔issue link map). ' +
        'The `token` param is a SECRET (Jira API token / PAT) — only required for test/discover_projects/discover_statuses/connect; it is never returned on reads.',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'disconnect') return 'destructive'
        if (
          [
            'connect',
            'update_connection',
            'sync',
            'resume',
            'retry_outbox',
            'create_spec',
            'discard_spec',
          ].includes(action)
        ) {
          return 'write'
        }
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            'connection',
            'test',
            'discover_projects',
            'discover_statuses',
            'connect',
            'update_connection',
            'disconnect',
            'statuses',
            'sync',
            'resume',
            'outbox',
            'retry_outbox',
            'create_spec',
            'discard_spec',
            'spec_details',
            'links',
          ])
          .describe('Jira operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        // Credential / probe fields (test, discover_projects, discover_statuses, connect)
        baseUrl: z
          .string()
          .optional()
          .describe('Jira base URL, e.g. https://acme.atlassian.net (test / discover_* / connect)'),
        accountEmail: z
          .string()
          .optional()
          .describe('Jira account email — required for Cloud Basic auth (test / discover_* / connect)'),
        token: z
          .string()
          .optional()
          .describe('SECRET: Jira API token (Cloud) or PAT (Data Center). Required for test / discover_projects / discover_statuses / connect. Never returned on reads.'),
        query: z.string().optional().describe('Optional name filter for discover_projects'),
        projectKey: z
          .string()
          .optional()
          .describe('Jira project key to inspect statuses for (discover_statuses)'),
        jiraProjectKey: z
          .string()
          .optional()
          .describe('Jira project key to connect this project to (connect)'),
        statusMap: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional map of logical states (todo / in_progress / on_review / done / cancelled) → Jira status name (connect / update_connection). on_review = implemented, awaiting PR review.'),
        discardStatus: z
          .string()
          .optional()
          .describe('Jira status name the discard action moves an issue to; empty string clears it (connect / update_connection)'),
        // update_connection
        enabled: z
          .boolean()
          .optional()
          .describe('Hot-swap toggle: true re-arms Jira write-back (read-only local backlog), false restores local write access (update_connection)'),
        // create_spec
        title: z.string().optional().describe('Issue summary/title (create_spec)'),
        description: z.string().optional().describe('Issue description (create_spec)'),
        labels: z.array(z.string()).optional().describe('Issue labels (create_spec)'),
        priority: z.string().optional().describe('Jira priority name (create_spec)'),
        issueType: z.string().optional().describe('Jira issue type; defaults to Task (create_spec)'),
        // discard_spec / spec_details
        localId: z
          .number()
          .optional()
          .describe('LOCAL monotonic ticket id (discard_spec / spec_details) — NOT a Jira key; map via the links action'),
        comment: z.string().optional().describe('Optional reason comment posted on discard (discard_spec)'),
        // retry_outbox
        opId: z
          .number()
          .optional()
          .describe('LOCAL outbox row id of a dead-lettered op to re-queue (retry_outbox)'),
        // outbox
        state: z
          .enum(['pending', 'inflight', 'done', 'dead'])
          .optional()
          .describe('Filter outbox ops by state (outbox); omit for all'),
      },
      async handler(ctx, args) {
        const base = `${projectPath(ctx, args.projectId as string | undefined)}/jira`
        const action = args.action as string
        switch (action) {
          case 'connection':
            return apiCall(ctx, 'GET', `${base}/connection`)

          case 'test':
            return apiCall(ctx, 'POST', `${base}/test`, {
              baseUrl: args.baseUrl as string | undefined,
              accountEmail: args.accountEmail as string | undefined,
              token: args.token as string | undefined,
            })

          case 'discover_projects':
            return apiCall(ctx, 'POST', `${base}/discover-projects`, {
              baseUrl: args.baseUrl as string | undefined,
              accountEmail: args.accountEmail as string | undefined,
              token: args.token as string | undefined,
              query: args.query as string | undefined,
            })

          case 'discover_statuses':
            return apiCall(ctx, 'POST', `${base}/discover-statuses`, {
              baseUrl: args.baseUrl as string | undefined,
              accountEmail: args.accountEmail as string | undefined,
              token: args.token as string | undefined,
              projectKey: args.projectKey as string | undefined,
            })

          case 'connect':
            return apiCall(ctx, 'POST', `${base}/connect`, {
              baseUrl: args.baseUrl as string | undefined,
              accountEmail: args.accountEmail as string | undefined,
              token: args.token as string | undefined,
              jiraProjectKey: args.jiraProjectKey as string | undefined,
              statusMap: args.statusMap as Record<string, string> | undefined,
              discardStatus: args.discardStatus as string | undefined,
            })

          case 'update_connection':
            return apiCall(ctx, 'PATCH', `${base}/connection`, {
              enabled: args.enabled as boolean | undefined,
              discardStatus: args.discardStatus as string | undefined,
              statusMap: args.statusMap as Record<string, string> | undefined,
            })

          case 'disconnect':
            return apiCall(ctx, 'DELETE', `${base}/connection`)

          case 'statuses':
            return apiCall(ctx, 'GET', `${base}/statuses`)

          case 'sync':
            return apiCall(ctx, 'POST', `${base}/sync`)

          case 'resume':
            return apiCall(ctx, 'POST', `${base}/resume`)

          case 'outbox': {
            const state = args.state as string | undefined
            const qs = state ? `?state=${encodeURIComponent(state)}` : ''
            return apiCall(ctx, 'GET', `${base}/outbox${qs}`)
          }

          case 'retry_outbox': {
            const opId = args.opId as number | undefined
            if (opId === undefined) throw new Error('retry_outbox requires an "opId" (local outbox row id).')
            return apiCall(ctx, 'POST', `${base}/outbox/${opId}/retry`)
          }

          case 'create_spec':
            return apiCall(ctx, 'POST', `${base}/specs`, {
              title: args.title as string | undefined,
              description: args.description as string | undefined,
              labels: args.labels as string[] | undefined,
              priority: args.priority as string | undefined,
              issueType: args.issueType as string | undefined,
            })

          case 'discard_spec': {
            const localId = args.localId as number | undefined
            if (localId === undefined) throw new Error('discard_spec requires a "localId" (local ticket id).')
            const r = await apiCall(ctx, 'POST', `${base}/specs/${localId}/discard`, {
              comment: args.comment as string | undefined,
            })
            // 202 accepted: the transition + optional comment drain asynchronously.
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint: 'Discard enqueued (202). Use action "outbox" to watch the transition/comment ops drain, or "connection" for live outbox counts.',
            }
          }

          case 'spec_details': {
            const localId = args.localId as number | undefined
            if (localId === undefined) throw new Error('spec_details requires a "localId" (local ticket id).')
            return apiCall(ctx, 'GET', `${base}/specs/${localId}/details`)
          }

          case 'links':
            return apiCall(ctx, 'GET', `${base}/links`)

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
