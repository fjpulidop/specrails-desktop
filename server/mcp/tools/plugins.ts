import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, originConversationDefaults, projectPath } from './types'

/**
 * Plugins (Integrations) domain facade. Per-project marketplace of MCP-based
 * integrations (bundled-only in v1). Maps each action to the matching REST
 * endpoint under `/api/projects/:projectId/plugins`.
 *
 * Excluded by design (v1 out of scope): the `uv` prerequisite installer
 * (`/plugins/_prerequisites/:prereq/install`) and the marketplace
 * global-settings mutation (`/plugins/_marketplace/disable`).
 */
export function pluginsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_plugins',
      title: 'Plugins',
      description:
        'List and manage a project\'s MCP-based integration plugins (Integrations). ' +
        'Actions: list (catalog with status/health/version/drift), preview (dry-run install diff + requirements), ' +
        'install (write — runs the installer + verify, updates the provider-native MCP registry, streams plugin.install_progress; long-running), ' +
        'uninstall (destructive — reverts contributors, removes owned mcpServers + installed files, drops state), ' +
        'activate (re-enable an installed-but-off plugin), deactivate (toggle off without uninstalling), ' +
        'update (apply manifest drift — re-merge owned mcpServers + re-apply contributors), ' +
        'health (on-demand verify of an installed plugin).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'uninstall') return 'destructive'
        if (['install', 'activate', 'deactivate', 'update'].includes(action)) return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum(['list', 'preview', 'install', 'uninstall', 'activate', 'deactivate', 'update', 'health'])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        provider: z.string().optional().describe(
          'Configured AI provider to manage (defaults to the launching conversation provider, then the project primary)',
        ),
        name: z
          .string()
          .optional()
          .describe('Bundled plugin name (required for preview/install/uninstall/activate/deactivate/update/health)'),
      },
      async handler(ctx, args) {
        const base = `${projectPath(ctx, args.projectId as string | undefined)}/plugins`
        const action = args.action as string
        const name = args.name as string | undefined
        const provider = (args.provider as string | undefined)
          ?? originConversationDefaults(ctx).provider
        const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
        const body = provider ? { provider } : undefined

        const requireName = (): string => {
          if (!name) throw new Error(`Action "${action}" requires a "name" (bundled plugin name).`)
          return encodeURIComponent(name)
        }

        switch (action) {
          case 'list':
            return apiCall(ctx, 'GET', `${base}${query}`)
          case 'preview':
            return apiCall(ctx, 'GET', `${base}/${requireName()}/preview-install${query}`)
          case 'install': {
            const r = await apiCall(ctx, 'POST', `${base}/${requireName()}/install`, body)
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint: 'Install runs the plugin installer + verify and streams plugin.install_progress / plugin.installed WS events. Use specrails_watch to observe progress, or call action="health" to confirm the plugin verified.',
            }
          }
          case 'uninstall':
            return apiCall(ctx, 'DELETE', `${base}/${requireName()}${query}`)
          case 'activate':
            return apiCall(ctx, 'POST', `${base}/${requireName()}/activate`, body)
          case 'deactivate':
            return apiCall(ctx, 'POST', `${base}/${requireName()}/deactivate`, body)
          case 'update':
            return apiCall(ctx, 'POST', `${base}/${requireName()}/update`, body)
          case 'health':
            return apiCall(ctx, 'GET', `${base}/${requireName()}/health${query}`)
          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
