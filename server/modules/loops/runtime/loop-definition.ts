import { expandCommands } from './loop-command-catalog'
import { resolveConstants } from './loop-constants'
import {
  assertDefinitionGraph,
  interpolateSpec,
  validateLoopGraph,
  type CoreNodeKind,
  type LoopGraph,
  type LoopNode,
  type LoopSpec,
} from './loop-graph'

export interface CoreDefinitionNode {
  kind: CoreNodeKind
  params: Record<string, unknown>
  ends: Record<string, string | null>
  retry?: { maxAttempts?: number; backoffMs?: number; retryOn?: string[] }
  label?: string
}
export interface CoreComponentDefinition {
  entry: string
  nodes: Record<string, CoreDefinitionNode>
  maxTransitions?: number
  inputs?: string[]
  outputs?: string[]
}
/** Publication omits version; Core validates and supplies its canonical hash. */
export interface CoreWorkflowDefinition extends CoreComponentDefinition {
  schemaVersion: 1
  id: string
  version?: string
  title: string
  journal: 'ledger-only' | 'implementation'
  change: 'new' | 'existing' | 'none'
  maxTransitions: number
  roles: string[]
  budget?: { maxCostUsd?: number; maxTokens?: number; maxDurationMs?: number }
  policies?: LoopGraph['config']['policies']
  components?: Record<string, CoreComponentDefinition>
  delivery: { requiresVerified: boolean }
}
export interface DefinitionLaunch {
  id?: string
  title?: string
  spec?: LoopSpec
  constants: Record<string, string>
  provider: string
  model?: string
  effort?: string
  roles?: Record<string, { access?: 'read' | 'write' }>
  /** Admission resolves global connection defaults before freezing prompt engines. */
  loopAgents?: LoopGraph['config']['agents']
  repositoryCount?: number
  changeId?: string
  briefing?: string
  addendaIds?: readonly string[]
}

const AI_KINDS = new Set<CoreNodeKind>(['prompt', 'role-turn', 'decider', 'implementation', 'implementation-step'])
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** No I/O, model call, hash implementation or scheduling belongs in this adapter. */
export function compileLoopToDefinition(graph: LoopGraph, launch: DefinitionLaunch): CoreWorkflowDefinition {
  assertDefinitionGraph(graph)
  const allGraphs = [graph, ...Object.values(graph.components ?? {})]
  if (!graph.config.agents && allGraphs.some(body => body.nodes.some(node => node.data?.kind === 'implementation-step'))) throw new Error('Independent implementation steps require loop-owned agents')
  for (const body of allGraphs) {
    assertDefinitionGraph(body)
    const validation = validateLoopGraph(body)
    if (!validation.valid)
      throw new Error(
        validation.errors.map((error) => `${error.nodeId ?? 'graph'}: ${error.message}`).join('\n'),
      )
    if (body !== graph && body.components && Object.keys(body.components).length) {
      throw new Error(
        'Reusable components belong in the top-level component library; nested pieces reference that library.',
      )
    }
  }
  const writes = allGraphs.some((body) => body.nodes.some((node) => pieceWrites(node, launch.roles)))
  const roleIds = new Set<string>()
  const compileBody = (body: LoopGraph): CoreComponentDefinition => {
    const start = body.nodes.find((node) => node.type === 'start')!
    const entry = body.edges.find((edge) => edge.source === start.id)!.target
    if (body.edges.some((edge) => edge.target === start.id))
      throw new Error('A Core workflow cannot route back to the visual Start node.')
    const nodes: Record<string, CoreDefinitionNode> = {}
    for (const node of [...body.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
      if (node.type === 'start') continue
      const kind = node.type === 'end' ? 'end' : node.data!.kind!
      const rawParams =
        node.type === 'end'
          ? {
              outcome: node.data?.outcome ?? 'success',
              ...(typeof node.data?.requiresVerified === 'boolean'
                ? { requiresVerified: node.data.requiresVerified }
                : {}),
              ...(typeof node.data?.exit === 'string' ? { exit: node.data.exit } : {}),
              ...(typeof node.data?.reason === 'string' ? { reason: node.data.reason } : {}),
              ...(typeof node.data?.blockerFrom === 'string' ? { blockerFrom: node.data.blockerFrom } : {}),
            }
          : node.data!.params!
      const promptRole = node.id === 'fix' ? 'fixer' : node.id === 'prepare' ? 'architect' : rawParams.access === 'read' ? 'reviewer' : 'developer'
      const agents = graph.config.agents ? launch.loopAgents ?? graph.config.agents : undefined
      const loopEngine = agents ? (promptRole === 'fixer' ? agents.fixer ?? agents.agents.developer : agents.agents[promptRole]) : undefined
      const engineInput = { ...(loopEngine ? { provider: loopEngine.provider, ...(loopEngine.model ? { model: loopEngine.model } : {}), ...(loopEngine.effort ? { effort: loopEngine.effort } : {}), ...(loopEngine.thinking ? { thinking: loopEngine.thinking } : {}), ...(loopEngine.maxTurns ? { maxTurns: loopEngine.maxTurns } : {}) } : {}), ...(object(rawParams.engine) ? rawParams.engine : {}) }
      const inherited = engineInput.provider === 'inherit'
      const provider = inherited ? launch.provider : typeof engineInput.provider === 'string' ? engineInput.provider : launch.provider
      if (inherited) {
        engineInput.provider = provider
        if (!engineInput.model && launch.model) engineInput.model = launch.model
        if (!engineInput.effort && launch.effort) engineInput.effort = launch.effort
      }
      const params = resolveValue(rawParams, launch, provider) as Record<string, unknown>
      if (kind === 'prompt') {
        params.engine = {
          provider,
          ...(!loopEngine && provider === launch.provider && launch.model ? { model: launch.model } : {}),
          ...(!loopEngine && provider === launch.provider && launch.effort ? { effort: launch.effort } : {}),
          ...engineInput,
        }
        if (
          typeof rawParams.text === 'string' &&
          /^\s*\{\{\s*cmd:[\w:-]+\s*\}\}/.test(rawParams.text) &&
          typeof params.text === 'string'
        ) {
          const native = params.text.match(/^\s*(?:\/|\$)([a-z][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/)
          if (native) {
            params.nativeCommand = { id: native[1].replace(/^skill:/, ''), args: native[2] ?? '' }
            delete params.text
          }
        }
      }
      if (kind === 'prompt' && graph.config.agents) {
        const definition = agents?.rolePrompts?.[promptRole]?.replaceAll('{{', '{{{{')
        if (definition) {
          if (object(params.nativeCommand)) params.nativeCommand = { ...params.nativeCommand, args: String(params.nativeCommand.args ?? '') + '\n\nLoop agent definition:\n' + definition }
          else if (typeof params.text === 'string') params.text = definition + '\n\n' + params.text
        }
      }
      if (launch.briefing && ['prompt','role-turn','decider'].includes(kind)) {
        const suffix = '\n\nFrozen launch context:\n' + launch.briefing
        if (object(params.nativeCommand)) params.nativeCommand = { ...params.nativeCommand, args: String(params.nativeCommand.args ?? '') + suffix }
        else for (const field of ['text','prompt','goal']) if (typeof params[field] === 'string') params[field] += suffix
      }
      if ((kind === 'implementation' || kind === 'implementation-step')) for (const role of ['architect', 'developer', 'reviewer']) roleIds.add(role)
      if ((kind === 'role-turn' || kind === 'decider') && typeof params.roleId === 'string')
        roleIds.add(params.roleId)
      if (kind === 'end' && params.outcome === 'success' && params.requiresVerified === undefined)
        params.requiresVerified = writes
      const ends = Object.fromEntries(
        body.edges.filter((edge) => edge.source === node.id).map((edge) => [edge.label!, edge.target]),
      )
      nodes[node.id] = {
        kind,
        params,
        ends,
        ...(node.data?.retry
          ? {
              retry: {
                ...node.data.retry,
                ...(node.data.retry.retryOn ? { retryOn: [...node.data.retry.retryOn] } : {}),
              },
            }
          : {}),
        ...(typeof node.data?.label === 'string' ? { label: node.data.label } : {}),
      }
    }
    return {
      entry,
      nodes,
      maxTransitions: expandedTransitionBound(body, graph.components ?? {}, launch),
      ...(body.inputs ? { inputs: [...body.inputs] } : {}),
      ...(body.outputs ? { outputs: [...body.outputs] } : {}),
    }
  }
  const body = compileBody(graph)
  // Specialize the Desktop Implement recipe with the frozen launch scope.
  // Its ordinary review/candidate gates remain in place; an addendum cannot
  // disappear behind a generic approved=true response.
  if (launch.id === 'factory:implement' && launch.addendaIds?.length) {
    const reviewer = body.nodes.reviewer
    const policy = body.nodes['review-policy']
    if (reviewer?.kind === 'role-turn' && policy?.kind === 'condition' && object(reviewer.params.structuredOutput)) {
      const schema = reviewer.params.structuredOutput
      const entries = Object.fromEntries(launch.addendaIds.map((id, index) => [`a${index}`, {
        type: 'object', additionalProperties: false, required: ['id', 'verdict', 'files', 'tests'],
        properties: {
          id: { type: 'string', const: id },
          verdict: { enum: ['applied', 'partial', 'blocked'] },
          files: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
          tests: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
        },
      }]))
      reviewer.params.structuredOutput = {
        ...schema, properties: { ...(object(schema.properties) ? schema.properties : {}), addenda: { type: 'object', additionalProperties: false, properties: entries, required: Object.keys(entries) } },
        required: [...(Array.isArray(schema.required) ? schema.required : []), 'addenda'],
      }
      reviewer.params.prompt += '\nReport every frozen addendum in addenda (slots in launch order): ' + JSON.stringify(launch.addendaIds) + '. Inspect real code and verification evidence. Use applied only with concrete files and executed tests; otherwise partial or blocked. Also include one line per addendum in summary: - [id] applied — files: paths — tests: commands and results.'
      const checks = launch.addendaIds.map((_, index) => {
        const ref = `$outputs.reviewer.structured.addenda.a${index}`
        return `${ref}.verdict == "applied" && ${ref}.files.length > 0 && ${ref}.tests.length > 0`
      })
      // Core bounds expression length/token count. Keep large addendum scopes
      // in small successive gates instead of generating one unbounded expression.
      let next = reviewer.ends.next
      for (let offset = checks.length - 1; offset >= 0; offset -= 10) {
        const first = Math.max(0, offset - 9)
        let id = `addenda-review-${first}`
        while (body.nodes[id]) id += '-gate'
        body.nodes[id] = { kind: 'condition', params: { expr: checks.slice(first, offset + 1).map(expr => `(${expr})`).join(' && ') }, ends: { true: next, false: policy.ends.false } }
        next = id
      }
      reviewer.ends.next = next
      body.maxTransitions = Math.min(10000, body.maxTransitions! + Math.ceil(checks.length / 10) * graph.config.maxIterations)
    }
  }
  const components = Object.fromEntries(
    Object.entries(graph.components ?? {})
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([id, component]) => [id, compileBody(component)]),
  )
  const implementation = [body, ...Object.values(components)].some((component) =>
    Object.values(component.nodes).some((node) => (node.kind === 'implementation' || node.kind === 'implementation-step')),
  )
  const budget = {
    ...(graph.config.maxCostUsd && graph.config.maxCostUsd > 0
      ? { maxCostUsd: graph.config.maxCostUsd }
      : {}),
    ...(graph.config.maxTokens ? { maxTokens: graph.config.maxTokens } : {}),
    ...(graph.config.timeoutMinutes > 0
      ? { maxDurationMs: Math.round(graph.config.timeoutMinutes * 60_000) }
      : {}),
  }
  const id = (launch.id ?? 'desktop-workflow')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 64)
  if (!/^[a-z0-9]/.test(id)) throw new Error('Workflow id must start with a letter or number.')
  return {
    schemaVersion: 1,
    id,
    title: launch.title ?? 'Workflow',
    journal: graph.config.journal ?? (implementation ? 'implementation' : 'ledger-only'),
    change: graph.config.change ?? (implementation ? (launch.changeId ? 'existing' : 'new') : 'none'),
    ...body,
    maxTransitions: body.maxTransitions!,
    roles: [...roleIds].sort(),
    ...(Object.keys(budget).length ? { budget } : {}),
    ...(graph.config.policies ? { policies: { ...graph.config.policies } } : {}),
    ...(Object.keys(components).length ? { components } : {}),
    delivery: { requiresVerified: writes },
  }
}

function pieceWrites(node: LoopNode, roles: DefinitionLaunch['roles']): boolean {
  if (node.type !== 'core') return false
  const kind = node.data?.kind,
    params = node.data?.params ?? {}
  if (kind === 'prompt') return params.access !== 'read'
  if (kind === 'role-turn') return (roles ?? {})[String(params.roleId)]?.access !== 'read'
  return ['verify', 'shell', 'openspec-archive', 'implementation', 'implementation-step'].includes(kind ?? '')
}

/** Expand templates once. Text inserted by spec/constants cannot introduce another token. */
function resolveValue(value: unknown, launch: DefinitionLaunch, provider: string): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\{\{\{\{|\{\{\s*(?:spec\.\w+|const:[A-Za-z0-9_.-]+|cmd:[\w:-]+)\s*\}\}/g,
      (token) => {
        if (token === '{{{{') return token // Core resolves the literal escape at execution.
        if (/^\{\{\s*spec\./.test(token)) return interpolateSpec(token, launch.spec).replaceAll('{{', '{{{{')
        if (/^\{\{\s*const:/.test(token)) return resolveConstants(token.replace(/\s+/g, ''), launch.constants).replaceAll('{{', '{{{{')
        // Registry templates contain launch tokens themselves. Resolve only
        // those trusted tokens, never commands introduced by task data.
        return expandCommands(token, { provider, ticketIds: launch.spec?.ticketIds, specId: launch.spec?.id }).replace(
          /\{\{\s*(?:spec\.\w+|const:[A-Za-z0-9_.-]+)\s*\}\}/g,
          nested => (/^\{\{\s*spec\./.test(nested)
            ? interpolateSpec(nested, launch.spec)
            : resolveConstants(nested.replace(/\s+/g, ''), launch.constants)).replaceAll('{{', '{{{{'),
        )
      },
    )
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, launch, provider))
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveValue(child, launch, provider)]),
    )
  return value
}

/** Nested visits share Core's global budget. Dynamic fan-out requires an explicit cap or the engine ceiling. */
function expandedTransitionBound(
  body: LoopGraph,
  library: NonNullable<LoopGraph['components']>,
  launch: DefinitionLaunch,
  ancestors: string[] = [],
): number {
  if (body.config.maxTransitions !== undefined) return body.config.maxTransitions
  const weights = new Map<string, number>()
  for (const node of body.nodes) {
    const kind = node.data?.kind,
      params = node.data?.params ?? {}
    if (kind === 'implementation' || (kind === 'map' && object(params.over))) return 10_000
    if (kind !== 'component' && kind !== 'map') continue
    const ref = String(kind === 'component' ? params.ref : params.body)
    if (ancestors.includes(ref))
      throw new Error('Reusable components cannot recursively reference themselves.')
    const child = library[ref]
    if (!child) continue // Core reports the exact missing-reference diagnostic.
    const visits = expandedTransitionBound(child, library, launch, [...ancestors, ref])
    if (visits === 10_000) return 10_000
    const count =
      kind === 'map'
        ? params.over === 'tickets'
          ? Math.max(1, launch.spec?.ticketIds?.length ?? 1)
          : launch.repositoryCount
        : 1
    if (count === undefined) return 10_000
    weights.set(node.id, 1 + visits * count)
  }
  return transitionBound(body, weights)
}

/** Count the largest strongly connected region; retries have a separate bounded allowance. */
function transitionBound(graph: LoopGraph, weights = new Map<string, number>()): number {
  const nodes = graph.nodes.filter((node) => node.type !== 'start')
  const adjacency = new Map(
    nodes.map((node) => [
      node.id,
      graph.edges.filter((edge) => edge.source === node.id).map((edge) => edge.target),
    ]),
  )
  let nextIndex = 0,
    largestCycle = 0,
    cyclicNodes = 0
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>()
  const visit = (id: string): void => {
    indices.set(id, nextIndex)
    low.set(id, nextIndex++)
    stack.push(id)
    active.add(id)
    for (const target of adjacency.get(id) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        low.set(id, Math.min(low.get(id)!, low.get(target)!))
      } else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!))
    }
    if (low.get(id) !== indices.get(id)) return
    let count = 0,
      members = 0,
      current: string
    do {
      current = stack.pop()!
      active.delete(current)
      count += weights.get(current) ?? 1
      members += 1
    } while (current !== id)
    if (members > 1 || adjacency.get(id)?.includes(id)) {
      largestCycle = Math.max(largestCycle, count)
      cyclicNodes += count
    }
  }
  for (const node of nodes) if (!indices.has(node.id)) visit(node.id)
  const retryNodes = nodes.filter((node) =>
    node.data?.retry ? (node.data.retry.maxAttempts ?? 1) > 1 : AI_KINDS.has(node.data?.kind as CoreNodeKind),
  ).length
  const bound =
    Math.max(
      [...nodes].reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0),
      graph.config.maxIterations * largestCycle +
        nodes.reduce((sum, node) => sum + (weights.get(node.id) ?? 1), 0) -
        cyclicNodes,
    ) +
    2 * retryNodes
  if (bound > 10_000) throw new Error('Workflow transition budget exceeds Core limit of 10000.')
  return Math.max(1, bound)
}
