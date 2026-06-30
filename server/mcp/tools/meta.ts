import { z } from 'zod'
import { SPECRAILS_GUIDE } from '../guide'
import type { McpToolSpec } from './types'
import { setActiveProject, requireProject } from './types'

/**
 * Meta tools that teach the platform and aid discovery.
 * `getSpecs` returns the full catalog (passed lazily to avoid a cycle).
 */
export function metaTools(getSpecs: () => McpToolSpec[]): McpToolSpec[] {
  return [
    {
      name: 'specrails_guide',
      title: 'Platform guide',
      description: 'Returns a self-contained guide to Specrails: concepts, workflow, invariants, and how to use these tools. Read this first.',
      tier: 'read',
      inputSchema: {},
      handler: () => SPECRAILS_GUIDE,
    },
    {
      name: 'specrails_search',
      title: 'Search tools',
      description: 'Find the right Specrails tool/action for an intent. Returns matching tools with their descriptions.',
      tier: 'read',
      inputSchema: {
        query: z.string().describe('Natural-language intent, e.g. "launch the pipeline for a ticket"'),
      },
      handler: (_ctx, args) => {
        const q = String(args.query ?? '').toLowerCase().trim()
        const terms = q.split(/\s+/).filter(Boolean)
        const scored = getSpecs()
          .filter((s) => s.name !== 'specrails_search')
          .map((s) => {
            const hay = `${s.name} ${s.title} ${s.description}`.toLowerCase()
            const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0)
            return { name: s.name, title: s.title, description: s.description, score }
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
        return scored.length ? scored : { hint: 'No direct match. Call specrails_guide for an overview, or list all tools.' }
      },
    },
    {
      name: 'specrails_describe',
      title: 'Describe a tool',
      description: 'Return the full description and input schema summary for a named Specrails tool.',
      tier: 'read',
      inputSchema: {
        name: z.string().describe('Tool name, e.g. "specrails_rails"'),
      },
      handler: (_ctx, args) => {
        const name = String(args.name ?? '')
        const spec = getSpecs().find((s) => s.name === name)
        if (!spec) throw new Error(`Unknown tool "${name}". Use specrails_search to find one.`)
        return {
          name: spec.name,
          title: spec.title,
          description: spec.description,
          inputFields: Object.keys(spec.inputSchema),
        }
      },
    },
    {
      name: 'specrails_select_project',
      title: 'Select active project',
      description: 'Set the active project so subsequent per-project tools may omit projectId. Pass an id or a path. Pass null to clear.',
      tier: 'read',
      inputSchema: {
        projectId: z.string().nullable().optional().describe('Project id to make active, or null to clear'),
        path: z.string().optional().describe('Resolve+select a project by filesystem path instead of id'),
      },
      handler: (ctx, args) => {
        if (args.path) {
          const pc = ctx.registry.getContextByPath(String(args.path))
          if (!pc) throw new Error(`No project registered at path "${args.path}".`)
          setActiveProject(pc.project.id)
          return { active: pc.project.id, name: pc.project.name }
        }
        if (args.projectId === null) {
          setActiveProject(null)
          return { active: null }
        }
        const id = args.projectId as string | undefined
        if (!id) throw new Error('Provide a projectId, a path, or null.')
        const pc = requireProject(ctx, id)
        setActiveProject(pc.project.id)
        return { active: pc.project.id, name: pc.project.name }
      },
    },
  ]
}
