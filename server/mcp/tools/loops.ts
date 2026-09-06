import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, originConversationDefaults } from './types'

/**
 * Loops — the GLOBAL (cross-project) visual loop-builder library. Routes live at
 * `/api/loops*` and `/api/loop-templates` (NOT under `/projects` — no projectId).
 * Gated server-side by SPECRAILS_LOOPS_SECTION (every route 404s when off).
 * Exception: the standalone run actions (`run` / `run_get`) ARE project-scoped
 * (`/api/projects/:projectId/loop-runs*`) — a ticket-less loop runs directly
 * against a project with no rail and no ticket.
 *
 * A single domain-facade tool with an `action` enum and a dynamic tier:
 *   - read:        list, get, templates, factory, commands, constants_list,
 *                  preview, run_get
 *   - write:       constant_create, constant_update, import, create, from_template,
 *                  fork, update, publish, unpublish, duplicate
 *   - ai-spawn:    run (spawns an AI CLI, incurs cost, async 202)
 *   - destructive: constant_delete, delete
 */
export function loopsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_loops',
      title: 'Loops',
      description:
        'Manage the global (cross-project) loop library and its templates/factory/constants. ' +
        'Loops are visual builder graphs reused across projects; this is an APP-LEVEL domain (no projectId, except the run actions). ' +
        'To RUN a loop on a project\'s tickets: publish it, then specrails_rails(launch, mode:\'loop\', loopId=…). ' +
        'For a standalone ticket-less run use the run action. ' +
        'Actions: ' +
        'list (all saved loops), ' +
        'get (one loop by id), ' +
        'templates (built-in template catalog with graphs), ' +
        'factory (built-in locked factory loops), ' +
        'commands (magic-command catalog for the builder palette), ' +
        'constants_list (global cross-loop constants), ' +
        'constant_create (write), constant_update (write), constant_delete (destructive), ' +
        'preview (dry-run resolve tokens of a graph — no spawn), ' +
        'import (import loops from an export envelope), ' +
        'create (new Draft loop), ' +
        'from_template (instantiate from a template), ' +
        'fork (fork a factory loop into an editable Draft), ' +
        'update (name/description/graph — reverts to Draft, 409 while running), ' +
        'publish (graph-validated), unpublish (409 while running), ' +
        'duplicate (copy a loop), ' +
        'delete (destructive — 409 while running), ' +
        'run (ai-spawn — standalone ticket-less run of a Published loop against a project: spawns an AI CLI, incurs token cost, returns 202 with loopRunId), ' +
        'run_get (read one loop run\'s live/terminal state — the post-timeout recovery read).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'delete' || action === 'constant_delete') return 'destructive'
        if (action === 'run') return 'ai-spawn'
        if (
          [
            'constant_create',
            'constant_update',
            'import',
            'create',
            'from_template',
            'fork',
            'update',
            'publish',
            'unpublish',
            'duplicate',
          ].includes(action)
        ) {
          return 'write'
        }
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            'list',
            'get',
            'templates',
            'factory',
            'commands',
            'constants_list',
            'constant_create',
            'constant_update',
            'constant_delete',
            'preview',
            'import',
            'create',
            'from_template',
            'fork',
            'update',
            'publish',
            'unpublish',
            'duplicate',
            'delete',
            'run',
            'run_get',
          ])
          .describe('Operation to perform'),
        projectId: z
          .string()
          .optional()
          .describe('Project id (run / run_get only — defaults to the active project; ignored by every other action)'),
        loopId: z.string().optional().describe('Loop id (for get / update / publish / unpublish / duplicate / delete / run — must be Published for run)'),
        repositoryIds: z.array(z.string().min(1)).min(1).max(50).optional().describe('run only: repository memberships to include in one coordinated standalone execution; omission retains primary-only behavior.'),
        loopRunId: z.string().optional().describe('Loop run id (for run_get — returned by run)'),
        constantId: z.string().optional().describe('Constant id (for constant_update / constant_delete)'),
        templateId: z.string().optional().describe('Template id (for from_template)'),
        factoryId: z.string().optional().describe('Factory loop id (for fork)'),
        name: z
          .string()
          .optional()
          .describe('Loop or constant name (required for create / constant_create; optional override for from_template / fork / duplicate / update)'),
        description: z.string().optional().describe('Loop description (for create / update)'),
        graph: z
          .record(z.unknown())
          .optional()
          .describe('Loop graph object { nodes, edges, ... } (for create / update; required for preview)'),
        value: z.string().optional().describe('Constant value (for constant_create / constant_update)'),
        provider: z
          .string()
          .optional()
          .describe('Provider for token resolution in preview (default "claude") / AI engine for run (must be installed on the project; defaults to the launching conversation provider, otherwise project primary)'),
        model: z
          .string()
          .optional()
          .describe('Model for run — validated against the chosen provider\'s catalog; omit for the provider default'),
        reasoning_effort: z
          .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
          .optional()
          .describe('Provider-supported reasoning-effort tier for run; Kimi K3 supports low/high/max'),
        loops: z.array(z.unknown()).optional().describe('Array of loop export envelopes (for import)'),
      },
      async handler(ctx, args) {
        const action = args.action as string
        const loopId = args.loopId as string | undefined
        const constantId = args.constantId as string | undefined

        switch (action) {
          // ── Reads ──────────────────────────────────────────────────────────
          case 'list':
            return apiCall(ctx, 'GET', '/loops')
          case 'get': {
            if (!loopId) throw new Error('get requires a "loopId".')
            return apiCall(ctx, 'GET', `/loops/${encodeURIComponent(loopId)}`)
          }
          case 'templates':
            return apiCall(ctx, 'GET', '/loop-templates')
          case 'factory':
            return apiCall(ctx, 'GET', '/loops/factory')
          case 'commands':
            return apiCall(ctx, 'GET', '/loops/commands')
          case 'constants_list':
            return apiCall(ctx, 'GET', '/loops/constants')
          case 'preview': {
            const graph = args.graph as Record<string, unknown> | undefined
            if (!graph) throw new Error('preview requires a "graph".')
            return apiCall(ctx, 'POST', '/loops/preview', {
              graph,
              ...(args.provider !== undefined ? { provider: args.provider as string } : {}),
            })
          }

          // ── Constants (write / destructive) ─────────────────────────────────
          case 'constant_create': {
            const name = args.name as string | undefined
            if (!name) throw new Error('constant_create requires a "name".')
            return apiCall(ctx, 'POST', '/loops/constants', {
              name,
              value: (args.value as string | undefined) ?? '',
            })
          }
          case 'constant_update': {
            if (!constantId) throw new Error('constant_update requires a "constantId".')
            if (args.value === undefined) throw new Error('constant_update requires "value" (use an empty string to clear it).')
            return apiCall(ctx, 'PUT', `/loops/constants/${encodeURIComponent(constantId)}`, {
              value: args.value as string,
            })
          }
          case 'constant_delete': {
            if (!constantId) throw new Error('constant_delete requires a "constantId".')
            return apiCall(ctx, 'DELETE', `/loops/constants/${encodeURIComponent(constantId)}`)
          }

          // ── Loops (write) ───────────────────────────────────────────────────
          case 'import': {
            const loops = args.loops as unknown[] | undefined
            if (!Array.isArray(loops)) throw new Error('import requires a "loops" array.')
            return apiCall(ctx, 'POST', '/loops/import', { loops })
          }
          case 'create': {
            const name = args.name as string | undefined
            if (!name) throw new Error('create requires a "name".')
            return apiCall(ctx, 'POST', '/loops', {
              name,
              ...(args.description !== undefined ? { description: args.description as string } : {}),
              ...(args.graph !== undefined ? { graph: args.graph as Record<string, unknown> } : {}),
            })
          }
          case 'from_template': {
            const templateId = args.templateId as string | undefined
            if (!templateId) throw new Error('from_template requires a "templateId".')
            return apiCall(ctx, 'POST', `/loops/from-template/${encodeURIComponent(templateId)}`, {
              ...(args.name !== undefined ? { name: args.name as string } : {}),
            })
          }
          case 'fork': {
            const factoryId = args.factoryId as string | undefined
            if (!factoryId) throw new Error('fork requires a "factoryId".')
            return apiCall(ctx, 'POST', `/loops/factory/${encodeURIComponent(factoryId)}/fork`, {
              ...(args.name !== undefined ? { name: args.name as string } : {}),
            })
          }
          case 'update': {
            if (!loopId) throw new Error('update requires a "loopId".')
            const body: Record<string, unknown> = {}
            if (args.name !== undefined) body.name = args.name as string
            if (args.description !== undefined) body.description = args.description as string
            if (args.graph !== undefined) body.graph = args.graph as Record<string, unknown>
            return apiCall(ctx, 'PUT', `/loops/${encodeURIComponent(loopId)}`, body)
          }
          case 'publish': {
            if (!loopId) throw new Error('publish requires a "loopId".')
            return apiCall(ctx, 'POST', `/loops/${encodeURIComponent(loopId)}/publish`)
          }
          case 'unpublish': {
            if (!loopId) throw new Error('unpublish requires a "loopId".')
            return apiCall(ctx, 'POST', `/loops/${encodeURIComponent(loopId)}/unpublish`)
          }
          case 'duplicate': {
            if (!loopId) throw new Error('duplicate requires a "loopId".')
            return apiCall(ctx, 'POST', `/loops/${encodeURIComponent(loopId)}/duplicate`, {
              ...(args.name !== undefined ? { name: args.name as string } : {}),
            })
          }

          // ── Standalone runs (project-scoped) ────────────────────────────────
          case 'run': {
            if (!loopId) throw new Error('run requires a "loopId" (the loop must be Published).')
            const base = projectPath(ctx, args.projectId as string | undefined)
            const defaults = originConversationDefaults(ctx)
            const provider = (args.provider as string | undefined) ?? defaults.provider
            const model = (args.model as string | undefined)
              ?? (provider === defaults.provider ? defaults.model : undefined)
            const effort = (args.reasoning_effort as string | undefined)
              ?? (provider === defaults.provider && (!defaults.model || model === defaults.model)
                ? defaults.reasoningEffort : undefined)
            const r = await apiCall(ctx, 'POST', `${base}/loop-runs`, {
              loopId,
              ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
              ...(provider !== undefined ? { provider } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(effort !== undefined ? { reasoning_effort: effort } : {}),
            })
            return {
              ...(r as Record<string, unknown>),
              hint: 'Run accepted (202). Use specrails_watch with ref:loopRunId and kind:"loop_run" to recover live or already-terminal state. Settled means finished, not necessarily successful: inspect final_outcome/status. Use specrails_loops(run_get, loopRunId) for durable details.',
            }
          }
          case 'run_get': {
            const loopRunId = args.loopRunId as string | undefined
            if (!loopRunId) throw new Error('run_get requires a "loopRunId".')
            const base = projectPath(ctx, args.projectId as string | undefined)
            return apiCall(ctx, 'GET', `${base}/loop-runs/${encodeURIComponent(loopRunId)}`)
          }

          // ── Destructive ─────────────────────────────────────────────────────
          case 'delete': {
            if (!loopId) throw new Error('delete requires a "loopId".')
            return apiCall(ctx, 'DELETE', `/loops/${encodeURIComponent(loopId)}`)
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
