import { z } from 'zod'
import path from 'node:path'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { SPECRAILS_GUIDE } from '../guide'
import type { McpToolContext, McpToolSpec } from './types'
import { setActiveProject, toolTierAllowed } from './types'

/** One serialized input field for `specrails_describe`. */
interface DescribedField {
  name: string
  description?: string
  type: string
  enumValues?: string[]
  optional: boolean
}

/**
 * Serialize a raw-shape zod field into `{ name, description, type, enumValues?,
 * optional }`. Unwraps optional/default/nullable wrappers (keeping the OUTERMOST
 * `.describe()` string, the convention across the tool files) down to the base
 * type so the model sees the real type + enum values instead of a bare key name.
 */
function describeZodField(name: string, field: z.ZodTypeAny): DescribedField {
  let current: z.ZodTypeAny = field
  let optional = false
  let nullable = false
  let description: string | undefined
  for (;;) {
    if (description === undefined && current.description !== undefined) description = current.description
    const def = (current as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def
    const typeName = def?.typeName
    if ((typeName === 'ZodOptional' || typeName === 'ZodDefault') && def?.innerType) {
      optional = true
      current = def.innerType
      continue
    }
    if (typeName === 'ZodNullable' && def?.innerType) {
      nullable = true
      current = def.innerType
      continue
    }
    break
  }
  const baseName = ((current as { _def?: { typeName?: string } })._def?.typeName ?? 'ZodUnknown')
    .replace(/^Zod/, '')
    .toLowerCase()
  const type = nullable ? `${baseName} | null` : baseName
  const out: DescribedField = { name, type, optional }
  if (description !== undefined) out.description = description
  if (current instanceof z.ZodEnum) out.enumValues = [...(current.options as string[])]
  return out
}

function permissions(ctx: McpToolContext, spec: McpToolSpec, args: Record<string, unknown>) {
  const tier = typeof spec.tier === 'function' ? spec.tier(args) : spec.tier
  return { tier, allowed: toolTierAllowed(ctx, tier) }
}

function actions(ctx: McpToolContext, spec: McpToolSpec) {
  const field = spec.inputSchema.action
  if (!(field instanceof z.ZodEnum)) return []
  return (field.options as string[]).map(action => ({ action, ...permissions(ctx, spec, { action }) }))
}

const STOP_WORDS = new Set('a an the to for of in and or with how do i my this el la los las un una de del en y o con como que quiero para mi por'.split(' '))
const INTENTS: Record<string, string[]> = {
  proyecto: ['project', 'context'], proyectos: ['projects'], contexto: ['context', 'overview'],
  codigo: ['code', 'search'], buscar: ['search', 'find'], archivo: ['file'], archivos: ['file', 'tree'],
  implementar: ['launch', 'run', 'implement'], implementacion: ['implement', 'run'], lanzar: ['launch', 'run'],
  ejecucion: ['job', 'run'], ejecuciones: ['jobs', 'runs'], fallida: ['failed', 'logs'], error: ['error', 'logs'],
  mision: ['conversation'], conversar: ['chat'], especificaciones: ['specs'], especificacion: ['spec'],
  revisar: ['review', 'packet'], cambios: ['diff', 'git'], rama: ['branch', 'git'], ramas: ['branch'],
  esperar: ['watch', 'wait'], estado: ['status', 'context'], bucle: ['loop'], bucles: ['loops'],
  herramientas: ['tools'], permisos: ['tier', 'permissions'], configurar: ['settings'],
}
const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

function intentTerms(query: string): string[] {
  const words = normalize(query).split(/[^a-z0-9_]+/).filter(word => word.length > 1 && !STOP_WORDS.has(word))
  return [...new Set(words.flatMap(word => [word, ...(INTENTS[word] ?? [])]))]
}

/**
 * Meta tools that teach the platform and aid discovery.
 * `getSpecs` returns the full catalog (passed lazily to avoid a cycle).
 */
export function metaTools(getSpecs: () => McpToolSpec[]): McpToolSpec[] {
  return [
    {
      name: 'specrails_guide',
      title: 'Platform guide',
      description:
        'Returns a self-contained guide to Specrails: concepts, workflow, invariants, and how to use these tools. ' +
        'Read this first — call once per session before your first domain call.',
      tier: 'read',
      inputSchema: {},
      handler: () => SPECRAILS_GUIDE,
    },
    {
      name: 'specrails_search',
      title: 'Search tools',
      description: 'Find the right Specrails tool/action for an English or Spanish intent. Searches tool descriptions, actions and input fields; returns current permissions. Follow with describe for exact arguments.',
      tier: 'read',
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe('Natural-language intent, e.g. "launch the pipeline for a ticket" or "buscar código del proyecto"'),
      },
      handler: (ctx, args) => {
        const terms = intentTerms(String(args.query ?? ''))
        const scored = getSpecs()
          .filter((s) => s.name !== 'specrails_search')
          .map((s) => {
            const actionList = actions(ctx, s)
            const name = normalize(`${s.name} ${s.title}`)
            const description = normalize(s.description)
            const schema = normalize(JSON.stringify(toJsonSchemaCompat(z.object(s.inputSchema))))
            const score = terms.reduce((acc, term) => acc + (name.includes(term) ? 8 : 0) +
              (actionList.some(item => item.action.includes(term)) ? 5 : 0) +
              (description.includes(term) ? 2 : 0) + (schema.includes(term) ? 1 : 0), 0)
            return { name: s.name, title: s.title, description: s.description, score,
              actions: actionList, ...(actionList.length ? {} : permissions(ctx, s, {})),
              permissionNote: 'Action previews use default arguments. Describe with arguments for the exact tier; execution rechecks current permissions.' }
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
      description: 'Return a tool\'s complete JSON input schema, including nested objects, arrays, required fields, enums and bounds, plus per-action permissions. Optionally validate prospective arguments and preview their tier without executing anything.',
      tier: 'read',
      inputSchema: {
        name: z.string().describe('Tool name, e.g. "specrails_rails"'),
        arguments: z.record(z.unknown()).optional().describe('Optional prospective tool arguments to validate and preview permissions; never executes the tool'),
      },
      handler: (ctx, args) => {
        const name = String(args.name ?? '')
        const spec = getSpecs().find((s) => s.name === name)
        if (!spec) throw new Error(`Unknown tool "${name}". Use specrails_search to find one.`)
        const schema = z.object(spec.inputSchema)
        const prospective = args.arguments as Record<string, unknown> | undefined
        const validation = prospective === undefined ? undefined : schema.safeParse(prospective)
        return {
          name: spec.name,
          title: spec.title,
          description: spec.description,
          inputSchema: toJsonSchemaCompat(schema),
          actions: actions(ctx, spec),
          permissionNote: 'Action previews use default arguments. Validation checks the shared JSON schema only; action-specific requirements and backend state are checked at execution. No tool is executed here.',
          ...(validation ? { validation: validation.success
            ? { valid: true, ...permissions(ctx, spec, validation.data) }
            : { valid: false, issues: validation.error.issues.map(issue => ({ path: issue.path, message: issue.message })) } } : {}),
          inputFields: Object.entries(spec.inputSchema).map(([fieldName, field]) =>
            describeZodField(fieldName, field as z.ZodTypeAny),
          ),
        }
      },
    },
    {
      name: 'specrails_select_project',
      title: 'Select active project',
      description: 'Set this MCP session\'s active project so per-project tools may omit projectId. Pass an id or path, or null to clear. A mission\'s project pin is controlled by the conversation UI; this tool cannot override it.',
      tier: 'read',
      inputSchema: {
        projectId: z.string().nullable().optional().describe('Project id to make active, or null to clear'),
        path: z.string().optional().describe('Resolve+select a project by filesystem path instead of id'),
      },
      handler: (ctx, args) => {
        if (args.path !== undefined && args.projectId !== undefined) throw new Error('Provide either path or projectId, not both.')
        const project = args.path
          ? ctx.registry.listProjects().find(p => path.resolve(p.path) === path.resolve(String(args.path)))
          : typeof args.projectId === 'string' ? ctx.registry.getProjectRow(args.projectId) : undefined
        if (args.path && !project) throw new Error(`No project registered at path "${args.path}".`)
        if (args.projectId && !project) throw new Error(`Unknown projectId "${args.projectId}".`)
        if (!project && args.projectId !== null) throw new Error('Provide a projectId, a path, or null.')
        const id = project?.id ?? null
        if (ctx.requestProjectId !== undefined && ctx.requestProjectId !== id) {
          throw new Error('This mission uses its conversation project pin. Change the pin in the mission UI, or pass projectId explicitly for an intentional cross-project operation; selecting a default here cannot change the pin.')
        }
        setActiveProject(ctx, id)
        return project ? { active: id, name: project.name, available: !!ctx.registry.getContext(project.id) } : { active: null }
      },
    },
  ]
}
