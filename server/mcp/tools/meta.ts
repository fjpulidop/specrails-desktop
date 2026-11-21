import { z } from 'zod'
import { canonicalRepositoryPath, repositoryPathKey, getProjectRepositories } from '../../project-repositories'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { GUIDE_TOPIC_IDS, findGuideTopic, guideIndex } from '../guide'
import { McpToolError } from './envelope'
import type { McpToolContext, McpToolSpec } from './types'
import { setActiveProject, toolTierAllowed } from './types'
import { advertisedActions, describeActionFields, validateActionArgs } from './actions'
import { fieldsForAction } from './wire-schema'

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
type ZodDefLike = { typeName?: string; type?: string; innerType?: z.ZodTypeAny }

/** Lower-case kind of a zod schema: zod 3 exposes `_def.typeName` ('ZodOptional'), zod 4 `_def.type` ('optional'). */
function zodKind(schema: z.ZodTypeAny): string {
  const def = (schema as { _def?: ZodDefLike })._def
  return (def?.typeName?.replace(/^Zod/, '') ?? def?.type ?? 'unknown').toLowerCase()
}

function describeZodField(name: string, field: z.ZodTypeAny): DescribedField {
  let current: z.ZodTypeAny = field
  let optional = false
  let nullable = false
  let description: string | undefined
  for (;;) {
    if (description === undefined && current.description !== undefined) description = current.description
    const def = (current as { _def?: ZodDefLike })._def
    const kind = zodKind(current)
    if ((kind === 'optional' || kind === 'default') && def?.innerType) {
      optional = true
      current = def.innerType
      continue
    }
    if (kind === 'nullable' && def?.innerType) {
      nullable = true
      current = def.innerType
      continue
    }
    break
  }
  const baseName = zodKind(current)
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

/** Advertised actions with their default-argument tier and (when declared) the arguments they take. */
function actions(ctx: McpToolContext, spec: McpToolSpec) {
  return advertisedActions(spec).map(action => {
    const fields = spec.actionFields?.[action]
    return {
      action, ...permissions(ctx, spec, { action }),
      ...(fields ? { takes: describeActionFields(fields), ...(fields.required?.length ? { required: [...fields.required] } : {}), ...(fields.oneOf?.length ? { oneOf: [...fields.oneOf] } : {}) } : {}),
    }
  })
}

/** Per-action validation result for prospective arguments (never throws). */
function actionIssues(spec: McpToolSpec, args: Record<string, unknown>): string | null {
  try {
    const routed = spec.resolveAlias?.(args)
    validateActionArgs(routed?.spec.name ?? spec.name, (routed?.spec as McpToolSpec | undefined)?.actionFields ?? spec.actionFields, routed?.args ?? args)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * One action of a tool: tier, the arguments it requires and the complete
 * description of every field it takes (the full docs behind the brief
 * tools/list text, see ./wire-schema.ts). An alias action is described as the
 * call it stands for.
 */
function describeAction(ctx: McpToolContext, spec: McpToolSpec, requested: string) {
  const advertised = advertisedActions(spec)
  const routed = spec.resolveAlias?.({ action: requested }) ?? null
  const target = (routed?.spec as McpToolSpec | undefined) ?? spec
  const action = routed ? String(routed.args.action) : requested
  const targetActions = advertisedActions(target)
  if (!targetActions.includes(action)) {
    throw new McpToolError('invalid_input', `${spec.name} has no action "${requested}". Actions: ${advertised.join(', ')}.`, { choices: advertised })
  }
  const declared = target.actionFields?.[action]
  const names = fieldsForAction(target, targetActions, action)
  const fields = names.map(name => describeZodField(name, target.inputSchema[name] as z.ZodTypeAny))
  const jsonSchema = toJsonSchemaCompat(z.object(Object.fromEntries(names.map(name => [name, target.inputSchema[name]])))) as { properties?: unknown }
  const others = Object.keys(target.inputSchema).filter(name => name !== 'action' && !names.includes(name))
  return {
    name: target.name,
    ...(routed ? { aliasOf: `${target.name}(${action})`, requested: `${spec.name}(${requested})` } : {}),
    action, ...permissions(ctx, target, { action }),
    ...(declared ? { takes: describeActionFields(declared), ...(declared.required?.length ? { required: [...declared.required] } : {}), ...(declared.oneOf?.length ? { oneOf: [...declared.oneOf] } : {}) } : {}),
    fields,
    properties: jsonSchema.properties ?? {},
    ...(others.length ? { otherFields: others } : {}),
    note: 'Fields of this action with their complete descriptions. otherFields belong to other actions; specrails_describe(name) returns the whole schema. Validate a call with specrails_describe(name, arguments).',
  }
}

const STOP_WORDS = new Set('a an the to for of in and or with how do i my me is are was be it what which right now this el la los las un una de del en y o con como que quiero para mi por esta estan hay tengo me ahora'.split(' '))
const INTENTS: Record<string, string[]> = {
  proyecto: ['project', 'context'], proyectos: ['projects'], contexto: ['context', 'overview'],
  codigo: ['code', 'search'], buscar: ['search', 'find'], archivo: ['file'], archivos: ['file', 'tree'],
  implementar: ['launch', 'run', 'implement'], implementacion: ['implement', 'run'], lanzar: ['launch', 'run'],
  ejecucion: ['job', 'run'], ejecuciones: ['jobs', 'runs'], fallida: ['failure', 'diagnose_failure', 'logs'], error: ['error', 'logs'],
  mision: ['missions', 'conversation'], conversar: ['chat'], especificaciones: ['specs'], especificacion: ['spec'],
  revisar: ['review', 'packet'], cambios: ['diff', 'git'], rama: ['branch', 'git'], ramas: ['branch'],
  esperar: ['watch', 'wait'], estado: ['status', 'context'], bucle: ['loop'], bucles: ['loops'],
  herramientas: ['tools'], permisos: ['tier', 'permissions'], configurar: ['settings'],
  // App-wide glance, inbox, missions and failures (EN synonyms + ES intents).
  pasando: ['status', 'glance'], resumen: ['status', 'glance'], vistazo: ['status', 'glance'], happening: ['status', 'glance'],
  glance: ['status'], overview: ['status', 'context'], mood: ['status'], dashboard: ['status'],
  pendiente: ['inbox', 'needs'], pendientes: ['inbox', 'needs'], bandeja: ['inbox'], necesita: ['inbox', 'needs'], atencion: ['inbox', 'needs'],
  waiting: ['inbox', 'question'], attention: ['inbox', 'needs'], needs: ['inbox'], pregunta: ['question', 'inbox'], responder: ['answer', 'inbox'],
  reintentar: ['retry'], reanudar: ['resume'], misiones: ['missions'], agente: ['missions', 'agent'], agentes: ['missions', 'agents'],
  missions: ['missions'], mission: ['missions'], detener: ['abort', 'stop'], parar: ['abort', 'stop'],
  fallo: ['failure', 'diagnose_failure', 'logs'], fallos: ['failure', 'diagnose_failure'], fallado: ['failure', 'diagnose_failure'],
  failed: ['failure', 'diagnose_failure', 'logs'], why: ['diagnose_failure', 'failure'], registros: ['logs'], logs: ['logs'],
  gasto: ['spending', 'spend'], gastos: ['spending', 'spend'], coste: ['spending', 'cost'], costo: ['spending', 'cost'], hoy: ['today', 'status'],
  // Board, spend, resources, runtime runs, background processes, spec changes (EN synonyms + ES intents).
  board: ['board', 'columns'], tablero: ['board', 'columns'], columnas: ['board', 'columns'], kanban: ['board'], backlog: ['board', 'specs'],
  spend: ['spend', 'spending'], spent: ['spend', 'spending'], budget: ['spend', 'budget', 'caps'], presupuesto: ['spend', 'budget', 'caps'],
  cap: ['spend', 'caps'], caps: ['spend', 'caps'], limite: ['spend', 'caps'], gastado: ['spend', 'spending'], dinero: ['spend', 'cost'],
  resources: ['resources', 'cpu', 'memory'], recursos: ['resources', 'cpu', 'memory'], memoria: ['resources', 'memory'], cpu: ['resources', 'cpu'],
  ram: ['resources', 'memory'], consumo: ['resources', 'spend'], procesos: ['resources', 'background', 'processes'], process: ['background', 'resources'],
  runtime: ['runs', 'state'], run: ['runs', 'launch'], recuperar: ['recover', 'resume', 'runs'], recover: ['recover', 'resume', 'runs'],
  aprobar: ['approve', 'resume', 'runs'], approve: ['approve', 'resume', 'runs'], evidencia: ['evidence', 'runs'], evidence: ['evidence', 'runs'],
  steer: ['steer', 'runs'], dirigir: ['steer', 'runs'], guiar: ['steer', 'runs'], liquidar: ['settle', 'runs'], settle: ['settle', 'runs'],
  servidor: ['background', 'start', 'server'], server: ['background', 'start'], dev: ['background', 'start'], segundo: ['background'], plano: ['background'],
  arrancar: ['background', 'start', 'launch'], iniciar: ['start', 'launch'], matar: ['kill', 'background'], kill: ['kill', 'background'],
  crear: ['create', 'write'], editar: ['update', 'write', 'ai_edit'], cambiar: ['update', 'write'], borrar: ['delete', 'write'], eliminar: ['delete', 'write'],
  nota: ['addendum', 'write'], addendum: ['addendum', 'write'], buscar_spec: ['search', 'specs'], search_specs: ['search', 'specs'],
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
        'The Specrails platform guide, by topic: concepts, workflow, invariants and how to use these tools. ' +
        'Without topic it returns the topic index (read it first, once per session); with topic it returns that topic.',
      tier: 'read',
      inputSchema: {
        topic: z.string().trim().max(64).optional().describe('Topic id from the index, e.g. "rails-and-launch"; omit for the index'),
      },
      handler: (_ctx, args) => {
        const requested = typeof args.topic === 'string' ? args.topic.trim() : ''
        if (!requested) return guideIndex()
        const topic = findGuideTopic(requested)
        if (!topic) {
          throw new McpToolError('invalid_input', `Unknown guide topic "${requested}". Valid topics: ${GUIDE_TOPIC_IDS.join(', ')}.`, { choices: [...GUIDE_TOPIC_IDS] })
        }
        return topic.body()
      },
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
        action: z.string().trim().min(1).max(64).optional().describe('Return only this action: its tier, required arguments and the complete docs of the fields it takes (the tools/list schema carries brief descriptions). Ignored with arguments'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Optional prospective tool arguments to validate and preview permissions; never executes the tool'),
      },
      handler: (ctx, args) => {
        const name = String(args.name ?? '')
        const spec = getSpecs().find((s) => s.name === name)
        if (!spec) throw new Error(`Unknown tool "${name}". Use specrails_search to find one.`)
        const schema = z.object(spec.inputSchema)
        if (typeof args.action === 'string' && args.action.trim() && args.arguments === undefined) return describeAction(ctx, spec, args.action.trim())
        const prospective = args.arguments as Record<string, unknown> | undefined
        const validation = prospective === undefined ? undefined : schema.safeParse(prospective)
        const actionProblem = validation?.success ? actionIssues(spec, validation.data) : null
        return {
          name: spec.name,
          title: spec.title,
          description: spec.description,
          inputSchema: toJsonSchemaCompat(schema),
          actions: actions(ctx, spec),
          permissionNote: 'Action previews use default arguments. Validation checks the JSON schema and each action\'s required arguments; backend state is checked at execution. No tool is executed here.',
          ...(validation ? { validation: validation.success && !actionProblem
            ? { valid: true, ...permissions(ctx, spec, validation.data) }
            : validation.success
            ? { valid: false, issues: [{ path: ['action'], message: actionProblem }] }
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
        const key = args.path ? repositoryPathKey(canonicalRepositoryPath(String(args.path))) : undefined
        const matches = key ? ctx.registry.listProjects().filter(project => getProjectRepositories(project).some(repository =>
          [repository.path, ...(repository.workspacePaths ?? (repository.workspacePath ? [repository.workspacePath] : []))].some(root => repositoryPathKey(canonicalRepositoryPath(root)) === key))) : []
        if (matches.length > 1) throw new Error('Ambiguous project path; provide an explicit projectId.')
        const project = key ? matches[0] : typeof args.projectId === 'string' ? ctx.registry.getProjectRow(args.projectId) : undefined
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
