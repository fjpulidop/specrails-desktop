import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * The setup-wizard domain facade. Mixes APP-LEVEL operations (prerequisites,
 * available_providers, add_project — mounted at `/api` with NO `:projectId`)
 * with PER-PROJECT operations (install-config, install, checkpoints, abort,
 * integration-contract, enrich — under `/api/projects/:projectId/*`).
 *
 * LIFECYCLE the caller must respect:
 *   1. prerequisites → must be ok before adding a project
 *   2. add_project   → creates the ProjectContext + slug + registry mirror + workspace
 *   3. install_config (one POST per provider for multi-provider projects)
 *   4. install        → 202 async; the real result arrives only via WS / checkpoints
 *   5. poll checkpoints (or stream WS) until isInstalling === false
 *   6. optional enrich / enrich_message for the legacy full AI flow
 *
 * The async actions (install, enrich, enrich_message) return immediately (HTTP
 * 202) and do the real, long-running work in a detached child whose only output
 * channel is WebSocket — so they return a hint to poll `checkpoints` (which also
 * exposes isInstalling/isEnriching/logLines/summary) for true completion.
 */
export function setupTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_setup',
      title: 'Setup & Project Provisioning',
      description:
        'Add and provision Specrails projects via the setup wizard, and inspect setup prerequisites/providers. ' +
        'App-level actions ignore projectId: prerequisites (probe node/npm/npx/git + provider CLIs), ' +
        'available_providers (which AI CLIs are detected + install tiers), add_project (register a repo path). ' +
        'Per-project actions: install_config (persist install-config.yaml), install (spawn offline framework scaffold — async/202), ' +
        'checkpoints (poll live setup/install/enrich state — the canonical completion signal when not streaming WS), ' +
        'abort (SIGTERM/SIGKILL the in-progress install+enrich child), integration_contract (read the ticket-provider contract), ' +
        'enrich (spawn the legacy full AI flow — async/202, COST-INCURRING), enrich_message (resume an enrich session with a reply — async, COST-INCURRING).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'abort') return 'destructive'
        if (action === 'install' || action === 'enrich' || action === 'enrich_message') return 'ai-spawn'
        if (action === 'add_project' || action === 'install_config') return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            'prerequisites',
            'available_providers',
            'add_project',
            'install_config',
            'install',
            'checkpoints',
            'abort',
            'integration_contract',
            'enrich',
            'enrich_message',
          ])
          .describe('Setup operation to perform'),
        projectId: z
          .string()
          .optional()
          .describe('Project id for per-project actions (install_config/install/checkpoints/abort/integration_contract/enrich/enrich_message). Ignored by app-level actions.'),
        // prerequisites
        diagnostic: z
          .boolean()
          .optional()
          .describe('prerequisites: when true, include the resolved PATH segments/sources + per-tool which results'),
        // add_project
        path: z
          .string()
          .optional()
          .describe('add_project: filesystem path of the repo to register (required for add_project)'),
        name: z
          .string()
          .optional()
          .describe('add_project: display name (defaults to the directory basename)'),
        provider: z
          .string()
          .optional()
          .describe('add_project: legacy single primary provider; install/enrich: which per-provider install-config to read'),
        providers: z
          .array(z.string())
          .optional()
          .describe('add_project: providers to install (first = primary/default); de-duped server-side'),
        // install_config
        config: z
          .record(z.unknown())
          .optional()
          .describe('install_config: the install-config object to serialize (e.g. { tier:"quick", provider, agents }); required for install_config'),
        // enrich_message
        sessionId: z
          .string()
          .optional()
          .describe('enrich_message: the enrich session id to resume (required for enrich_message)'),
        message: z
          .string()
          .optional()
          .describe('enrich_message: the user reply to send into the enrich session (required for enrich_message)'),
      },
      async handler(ctx, args) {
        const action = args.action as string
        switch (action) {
          // ─── App-level (no projectId) ───────────────────────────────────────
          case 'prerequisites': {
            const qs = args.diagnostic === true ? '?diagnostic=1' : ''
            return apiCall(ctx, 'GET', `/setup-prerequisites${qs}`)
          }
          case 'available_providers':
            return apiCall(ctx, 'GET', '/available-providers')
          case 'add_project': {
            const path = args.path as string | undefined
            if (!path) throw new Error('add_project requires a "path".')
            const body: Record<string, unknown> = { path }
            if (typeof args.name === 'string') body.name = args.name
            if (typeof args.provider === 'string') body.provider = args.provider
            if (Array.isArray(args.providers)) body.providers = args.providers
            return apiCall(ctx, 'POST', '/projects', body)
          }

          // ─── Per-project ────────────────────────────────────────────────────
          case 'install_config': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            const config = args.config
            if (config === undefined || typeof config !== 'object' || Array.isArray(config)) {
              throw new Error('install_config requires a "config" object.')
            }
            return apiCall(ctx, 'POST', `${base}/setup/install-config`, config)
          }
          case 'install': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            const body: Record<string, unknown> = {}
            if (typeof args.provider === 'string') body.provider = args.provider
            const r = await apiCall(ctx, 'POST', `${base}/setup/install`, body)
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint: 'Install is async (HTTP 202). Poll specrails_setup(checkpoints) until isInstalling === false (and watch summary for the result), or stream the setup_install_done / setup_error WS events.',
            }
          }
          case 'checkpoints': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            return apiCall(ctx, 'GET', `${base}/setup/checkpoints`)
          }
          case 'abort': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            return apiCall(ctx, 'POST', `${base}/setup/abort`, {})
          }
          case 'integration_contract': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            return apiCall(ctx, 'GET', `${base}/integration-contract`)
          }
          case 'enrich': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            const r = await apiCall(ctx, 'POST', `${base}/enrich/start`, {})
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint: 'Enrich is async (HTTP 202) and COST-INCURRING. Poll specrails_setup(checkpoints) until isEnriching === false, or stream the setup_complete / setup_turn_done / setup_error WS events. Use enrich_message to answer clarifying questions.',
            }
          }
          case 'enrich_message': {
            const base = projectPath(ctx, args.projectId as string | undefined)
            const sessionId = args.sessionId as string | undefined
            const message = args.message as string | undefined
            if (!sessionId) throw new Error('enrich_message requires a "sessionId".')
            if (!message || !message.trim()) throw new Error('enrich_message requires a non-empty "message".')
            const r = await apiCall(ctx, 'POST', `${base}/enrich/message`, { sessionId, message })
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint: 'Enrich-message is async (HTTP 202) and COST-INCURRING. Poll specrails_setup(checkpoints) until isEnriching === false, or stream the setup_turn_done / setup_error WS events.',
            }
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
