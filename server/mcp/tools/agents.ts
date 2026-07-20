import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * Agents domain — agent PROFILES (declarative per-project routing config) and
 * the provider-native agents CATALOG (read-only `sr-*` upstream agents +
 * user-authored `custom-*` roles, with capability-gated AI generate/test/
 * iterative-refine on the custom ones).
 *
 * Every operation is per-project (mounted at /api/projects/:projectId/profiles)
 * and is gated by SPECRAILS_AGENTS_SECTION — a disabled server 404s every route.
 *
 * The catalog `generate`, `test`, `refine_start`, and `refine_turn` actions
 * SPAWN the selected provider CLI and incur real cost when that adapter exposes
 * a safe output-only/read-only policy (refine records ai_invocations and
 * streams agent_refine_* WS events). Other actions read/write the provider's
 * native custom-role artifact (`custom-*.md`, or Kimi
 * `custom-<id>/SKILL.md`).
 */
export function agentsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_agents',
      title: 'Agents (Profiles & Catalog)',
      description:
        'Manage provider-aware agent PROFILES and the agents CATALOG for a project. Pass provider to target a non-primary installed provider. ' +
        'PROFILE actions: list, get, resolve (preview which profile a rail would resolve to), create, update, delete (destructive — protected default/project-default cannot be deleted), ' +
        'duplicate, rename, migrate (seed a default profile from installed provider-native sr-* role frontmatter), analytics (per-profile metrics), core_version (specrails-core version + 4.1.0 profile-aware check). ' +
        'CATALOG actions: catalog_list, catalog_get (full provider-native role body), versions (custom role edit history), create_custom, update_custom, delete_custom (destructive), ' +
        'generate (AI-generate a draft custom role — selected provider spawn, costs), test (AI smoke-test a draft body — selected provider spawn, costs), ' +
        'refine_start / refine_turn (AI iterative refine — selected provider spawn, cost, stream over WS), refine_list, refine_get, refine_patch (toggle autoTest), refine_cancel (kill the spawn), refine_apply (write the refined draft). AI automation is rejected when the provider lacks a safe none/read-only tool policy; Kimi custom roles remain manually editable.',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (['delete', 'delete_custom'].includes(action)) return 'destructive'
        if (['generate', 'test', 'refine_start', 'refine_turn'].includes(action)) return 'ai-spawn'
        if (
          [
            'create',
            'update',
            'duplicate',
            'rename',
            'migrate',
            'create_custom',
            'update_custom',
            'refine_patch',
            'refine_cancel',
            'refine_apply',
          ].includes(action)
        ) {
          return 'write'
        }
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            // PROFILES
            'list',
            'get',
            'resolve',
            'create',
            'update',
            'delete',
            'duplicate',
            'rename',
            'migrate',
            'analytics',
            'core_version',
            // CATALOG (definitions)
            'catalog_list',
            'catalog_get',
            'versions',
            'create_custom',
            'update_custom',
            'delete_custom',
            'generate',
            'test',
            // CATALOG (AI refine)
            'refine_start',
            'refine_turn',
            'refine_list',
            'refine_get',
            'refine_patch',
            'refine_cancel',
            'refine_apply',
          ])
          .describe('Operation to perform (profile or catalog action)'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        provider: z
          .string()
          .optional()
          .describe('Installed project provider to target (defaults to the project primary provider)'),
        // Profile params
        name: z
          .string()
          .optional()
          .describe("Profile name (get/update/delete/duplicate/rename source). For duplicate/rename, the NEW name goes in `newName`."),
        newName: z.string().optional().describe('New profile name (for duplicate / rename)'),
        profileName: z
          .string()
          .optional()
          .describe('Explicit profile name to preview in `resolve` (omit to resolve the project default)'),
        profile: z
          .record(z.unknown())
          .optional()
          .describe('Full Profile body for create/update: { schemaVersion:1, name, description?, provider?, orchestrator:{model}, agents:[], routing:[] }'),
        windowDays: z.number().int().optional().describe('analytics time window in days (1-365, default 30)'),
        // Catalog params
        agentId: z
          .string()
          .optional()
          .describe('Agent id for catalog_get/versions/update_custom/delete_custom and all refine actions (custom-* for mutations, sr-*|custom-* for reads)'),
        body: z.string().optional().describe('Agent .md body (for create_custom / update_custom)'),
        agentName: z
          .string()
          .optional()
          .describe('New custom agent id for create_custom — must match ^custom-[a-z0-9][a-z0-9-]*$'),
        description: z.string().optional().describe('Plain-language description for `generate` (AI draft a custom agent)'),
        draftBody: z.string().optional().describe('Draft agent body to smoke-test in `test`'),
        sampleTask: z.string().optional().describe('Sample task the `test` action runs the draft against'),
        instruction: z.string().optional().describe('Refine instruction (for refine_start / refine_turn)'),
        autoTest: z.boolean().optional().describe('Auto-test the refined draft (refine_start default true; refine_patch toggles it)'),
        refineId: z.string().optional().describe('Refine session id (for refine_get/refine_turn/refine_patch/refine_cancel/refine_apply)'),
        force: z.boolean().optional().describe('Bypass the disk-hash guard when applying a refine draft (refine_apply)'),
      },
      async handler(ctx, args) {
        const base = `${projectPath(ctx, args.projectId as string | undefined)}/profiles`
        const action = args.action as string
        const provider = args.provider as string | undefined
        const withProvider = (url: string): string => {
          if (!provider) return url
          return `${url}${url.includes('?') ? '&' : '?'}provider=${encodeURIComponent(provider)}`
        }

        const agentId = args.agentId as string | undefined
        const refineId = args.refineId as string | undefined
        const profileName = args.name as string | undefined

        switch (action) {
          // ── PROFILES ────────────────────────────────────────────────────
          case 'list':
            return apiCall(ctx, 'GET', withProvider(base))
          case 'get': {
            if (!profileName) throw new Error('get requires a profile "name".')
            return apiCall(ctx, 'GET', withProvider(`${base}/${encodeURIComponent(profileName)}`))
          }
          case 'resolve': {
            const p = args.profileName as string | undefined
            const qs = p ? `?profile=${encodeURIComponent(p)}` : ''
            return apiCall(ctx, 'GET', withProvider(`${base}/resolve${qs}`))
          }
          case 'create': {
            if (!args.profile) throw new Error('create requires a "profile" body.')
            return apiCall(ctx, 'POST', withProvider(base), args.profile)
          }
          case 'update': {
            if (!profileName) throw new Error('update requires a profile "name".')
            if (!args.profile) throw new Error('update requires a "profile" body (its name must equal "name").')
            return apiCall(ctx, 'PATCH', withProvider(`${base}/${encodeURIComponent(profileName)}`), args.profile)
          }
          case 'delete': {
            if (!profileName) throw new Error('delete requires a profile "name".')
            return apiCall(ctx, 'DELETE', withProvider(`${base}/${encodeURIComponent(profileName)}`))
          }
          case 'duplicate': {
            if (!profileName) throw new Error('duplicate requires a source profile "name".')
            const newName = args.newName as string | undefined
            if (!newName) throw new Error('duplicate requires a "newName".')
            return apiCall(ctx, 'POST', withProvider(`${base}/${encodeURIComponent(profileName)}/duplicate`), { name: newName })
          }
          case 'rename': {
            if (!profileName) throw new Error('rename requires a source profile "name".')
            const newName = args.newName as string | undefined
            if (!newName) throw new Error('rename requires a "newName".')
            return apiCall(ctx, 'POST', withProvider(`${base}/${encodeURIComponent(profileName)}/rename`), { name: newName })
          }
          case 'migrate':
            return apiCall(ctx, 'POST', withProvider(`${base}/migrate-from-settings`))
          case 'analytics': {
            const wd = args.windowDays as number | undefined
            const qs = typeof wd === 'number' ? `?windowDays=${wd}` : ''
            return apiCall(ctx, 'GET', `${base}/analytics${qs}`)
          }
          case 'core_version':
            return apiCall(ctx, 'GET', `${base}/core-version`)

          // ── CATALOG: definitions ────────────────────────────────────────
          case 'catalog_list':
            return apiCall(ctx, 'GET', withProvider(`${base}/catalog`))
          case 'catalog_get': {
            if (!agentId) throw new Error('catalog_get requires an "agentId".')
            return apiCall(ctx, 'GET', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}`))
          }
          case 'versions': {
            if (!agentId) throw new Error('versions requires an "agentId".')
            return apiCall(ctx, 'GET', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/versions`))
          }
          case 'create_custom': {
            const id = args.agentName as string | undefined
            const body = args.body as string | undefined
            if (!id) throw new Error('create_custom requires an "agentName" (custom-* id).')
            if (!body) throw new Error('create_custom requires a "body".')
            return apiCall(ctx, 'POST', withProvider(`${base}/catalog`), { id, body })
          }
          case 'update_custom': {
            if (!agentId) throw new Error('update_custom requires an "agentId" (custom-* only).')
            const body = args.body as string | undefined
            if (!body) throw new Error('update_custom requires a "body".')
            return apiCall(ctx, 'PATCH', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}`), { body })
          }
          case 'delete_custom': {
            if (!agentId) throw new Error('delete_custom requires an "agentId" (custom-* only).')
            return apiCall(ctx, 'DELETE', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}`))
          }

          // ── CATALOG: AI spawns (cost) ───────────────────────────────────
          case 'generate': {
            const name = args.agentName as string | undefined
            const description = args.description as string | undefined
            if (!name) throw new Error('generate requires an "agentName" (custom-* id).')
            if (!description) throw new Error('generate requires a "description".')
            return apiCall(ctx, 'POST', withProvider(`${base}/catalog/generate`), { name, description })
          }
          case 'test': {
            const draftBody = args.draftBody as string | undefined
            const sampleTask = args.sampleTask as string | undefined
            if (!draftBody) throw new Error('test requires a "draftBody".')
            if (!sampleTask) throw new Error('test requires a "sampleTask".')
            return apiCall(ctx, 'POST', withProvider(`${base}/catalog/test`), {
              ...(agentId ? { agentId } : {}),
              draftBody,
              sampleTask,
            })
          }

          // ── CATALOG: AI refine sessions ─────────────────────────────────
          case 'refine_start': {
            if (!agentId) throw new Error('refine_start requires an "agentId" (custom-* only).')
            const instruction = args.instruction as string | undefined
            if (!instruction) throw new Error('refine_start requires an "instruction".')
            const r = await apiCall(ctx, 'POST', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine`), {
              instruction,
              ...(typeof args.autoTest === 'boolean' ? { autoTest: args.autoTest } : {}),
            })
            return {
              ...(r as Record<string, unknown>),
              hint: 'Refine streams over WS (agent_refine_* events). Use refine_get with the returned refineId to poll the session, then refine_apply to write the draft to disk.',
            }
          }
          case 'refine_turn': {
            if (!agentId) throw new Error('refine_turn requires an "agentId".')
            if (!refineId) throw new Error('refine_turn requires a "refineId".')
            const instruction = args.instruction as string | undefined
            if (!instruction) throw new Error('refine_turn requires an "instruction".')
            const r = await apiCall(
              ctx,
              'POST',
              withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine/${encodeURIComponent(refineId)}/turn`),
              { instruction },
            )
            return {
              ...(r as Record<string, unknown>),
              hint: 'The turn streams over WS (agent_refine_* events). Use refine_get with the refineId to read the updated draft.',
            }
          }
          case 'refine_list': {
            if (!agentId) throw new Error('refine_list requires an "agentId".')
            return apiCall(ctx, 'GET', withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine`))
          }
          case 'refine_get': {
            if (!agentId) throw new Error('refine_get requires an "agentId".')
            if (!refineId) throw new Error('refine_get requires a "refineId".')
            return apiCall(
              ctx,
              'GET',
              withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine/${encodeURIComponent(refineId)}`),
            )
          }
          case 'refine_patch': {
            if (!agentId) throw new Error('refine_patch requires an "agentId".')
            if (!refineId) throw new Error('refine_patch requires a "refineId".')
            if (typeof args.autoTest !== 'boolean') throw new Error('refine_patch requires a boolean "autoTest".')
            return apiCall(
              ctx,
              'PATCH',
              withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine/${encodeURIComponent(refineId)}`),
              { autoTest: args.autoTest },
            )
          }
          case 'refine_cancel': {
            if (!agentId) throw new Error('refine_cancel requires an "agentId".')
            if (!refineId) throw new Error('refine_cancel requires a "refineId".')
            return apiCall(
              ctx,
              'DELETE',
              withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine/${encodeURIComponent(refineId)}`),
            )
          }
          case 'refine_apply': {
            if (!agentId) throw new Error('refine_apply requires an "agentId".')
            if (!refineId) throw new Error('refine_apply requires a "refineId".')
            return apiCall(
              ctx,
              'POST',
              withProvider(`${base}/catalog/${encodeURIComponent(agentId)}/refine/${encodeURIComponent(refineId)}/apply`),
              { ...(typeof args.force === 'boolean' ? { force: args.force } : {}) },
            )
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
