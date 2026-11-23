import { z } from 'zod'
import type { McpTier } from '../mcp-tiers'
import { McpToolError } from './envelope'

/**
 * Action-facade plumbing shared by every tool with an `action` enum:
 *
 * - `actionEnum(advertised, hidden)`: the runtime accepts every action, but the
 *   client-facing JSON schema lists only the advertised ones. Hidden actions are
 *   legacy names kept working after an action moved to another tool.
 * - `ActionAlias`: where a hidden action now lives (`tool` + `action`, plus fixed
 *   arguments such as `mode`). `linkAliases` routes the tier, the Intent
 *   exception and the handler to the target, so an alias behaves exactly like
 *   the call it stands for.
 * - `ActionFields`: the arguments each action takes. MCP tool input schemas must
 *   be a single JSON object (a top-level oneOf is rejected by several clients),
 *   so the schema stays a flat union of optional fields and each action is
 *   validated at runtime with an `invalid_input` error naming its fields.
 *
 * Pure module apart from the zod schema it returns.
 */

/** Minimal structural view of a tool spec, so this module does not import types.ts (cycle). */
export interface AliasableSpec {
  name: string
  tier: McpTier | ((args: Record<string, unknown>) => McpTier)
  inputSchema: Record<string, unknown>
  handler: (ctx: never, args: Record<string, unknown>) => unknown
  tierException?: (ctx: never, args: Record<string, unknown>) => boolean
  aliases?: Record<string, ActionAlias>
  actionFields?: Record<string, ActionFields>
  resolveAlias?: (args: Record<string, unknown>) => ResolvedAlias | null
}

export interface ActionAlias {
  tool: string
  action: string
  /** Fixed arguments the alias implies (e.g. `{ mode: 'recover' }`); explicit caller arguments win. */
  args?: Record<string, unknown>
}

export interface ActionFields {
  /** Every listed field must be present. */
  required?: readonly string[]
  /** At least one of these fields must be present. */
  oneOf?: readonly string[]
  optional?: readonly string[]
}

export interface ResolvedAlias {
  spec: AliasableSpec
  args: Record<string, unknown>
}

/**
 * The `action` field: accepts advertised + hidden values, advertises only the
 * former (zod v4 metadata overrides the generated `enum`).
 */
export function actionEnum<const A extends readonly [string, ...string[]]>(advertised: A, hidden: readonly string[] = []) {
  const all = [...advertised, ...hidden.filter((action) => !advertised.includes(action))] as [string, ...string[]]
  return z.enum(all).meta({ enum: [...advertised] }).describe('Operation to perform')
}

/** The advertised actions of a spec (hidden legacy aliases excluded). */
export function advertisedActions(spec: Pick<AliasableSpec, 'inputSchema' | 'aliases'>): string[] {
  const field = spec.inputSchema.action
  if (!(field instanceof z.ZodEnum)) return []
  const hidden = new Set(Object.keys(spec.aliases ?? {}))
  return (field.options as string[]).filter((action) => !hidden.has(action))
}

/** Mapped call for an alias action, or null when `args.action` is not an alias. */
export function aliasCall(spec: AliasableSpec, specs: readonly AliasableSpec[], args: Record<string, unknown>): ResolvedAlias | null {
  const action = typeof args.action === 'string' ? args.action : null
  const alias = action ? spec.aliases?.[action] : undefined
  if (!alias) return null
  const target = specs.find((candidate) => candidate.name === alias.tool)
  if (!target) throw new Error(`Alias ${spec.name}(${action}) points at unknown tool ${alias.tool}.`)
  return { spec: target, args: { ...(alias.args ?? {}), ...args, action: alias.action } }
}

/**
 * Wire every spec's aliases to their targets: tier, Intent exception and
 * handler of an alias action are the target's. Mutates and returns `specs`
 * (called once while building the catalog). Throws on a dangling alias.
 */
export function linkAliases<S extends AliasableSpec>(specs: S[]): S[] {
  for (const spec of specs) {
    if (!spec.aliases || spec.resolveAlias) continue
    for (const [action, alias] of Object.entries(spec.aliases)) {
      const target = specs.find((candidate) => candidate.name === alias.tool)
      if (!target) throw new Error(`Alias ${spec.name}(${action}) points at unknown tool ${alias.tool}.`)
      if (target.aliases?.[alias.action]) throw new Error(`Alias ${spec.name}(${action}) points at another alias.`)
    }
    const own = { tier: spec.tier, handler: spec.handler, tierException: spec.tierException }
    const resolve = (args: Record<string, unknown>) => aliasCall(spec, specs, args)
    spec.resolveAlias = resolve
    spec.tier = (args) => {
      const routed = resolve(args)
      const tier = routed ? routed.spec.tier : own.tier
      const callArgs = routed ? routed.args : args
      return typeof tier === 'function' ? tier(callArgs) : tier
    }
    spec.handler = (ctx, args) => {
      const routed = resolve(args)
      return routed ? routed.spec.handler(ctx, routed.args) : own.handler(ctx, args)
    }
    spec.tierException = (ctx, args) => {
      const routed = resolve(args)
      const exception = routed ? routed.spec.tierException : own.tierException
      return exception ? exception(ctx, routed ? routed.args : args) : false
    }
  }
  return specs
}

const present = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** Human list of the fields an action takes, e.g. `jobId (required), limit`. */
export function describeActionFields(fields: ActionFields): string {
  const parts = [
    ...(fields.required ?? []).map((field) => `${field} (required)`),
    ...(fields.oneOf?.length ? [`one of ${fields.oneOf.join('/')}`] : []),
    ...(fields.optional ?? []),
  ]
  return parts.length ? parts.join(', ') : 'no arguments besides projectId'
}

/**
 * Runtime per-action validation. Missing required fields fail with
 * `invalid_input` listing what the action takes; fields the action ignores are
 * tolerated (older clients send them) and simply not forwarded by the handler.
 */
export function validateActionArgs(tool: string, fields: Record<string, ActionFields> | undefined, args: Record<string, unknown>): void {
  const action = typeof args.action === 'string' ? args.action : null
  const spec = action ? fields?.[action] : undefined
  if (!action || !spec) return
  const missing = (spec.required ?? []).filter((field) => !present(args[field]))
  const needsOne = spec.oneOf?.length && !spec.oneOf.some((field) => present(args[field]))
  if (!missing.length && !needsOne) return
  const what = [
    ...(missing.length ? [`missing ${missing.map((field) => `"${field}"`).join(', ')}`] : []),
    ...(needsOne ? [`needs one of ${spec.oneOf!.map((field) => `"${field}"`).join(', ')}`] : []),
  ].join('; ')
  throw new McpToolError('invalid_input', `${tool}(${action}) ${what}. It takes: ${describeActionFields(spec)}.`, {
    next: [{ tool: 'specrails_describe', args: { name: tool }, why: 'Every action with the arguments it takes.' }],
  })
}

// ── v1 → v2 alias bridge ─────────────────────────────────────────────────────
//
// Where each v1 tool action lives in the v2 catalog (server/mcp/v2). While the
// `mcp_v2` flag serves v2, the v1 tools stay callable as hidden aliases and
// every aliased result carries `warnings: ["deprecated: use <tool>(<action>)"]`
// built from this table; a v2 action that is still a stub names its v1
// equivalent (reverse lookup). Kept here, next to the v1 alias machinery, and
// free of v2 imports; server/mcp/v2/aliases.test.ts proves every target exists.

export interface V2Target {
  tool: string
  action: string
  /** Fixed arguments the v2 call needs to do what the v1 action did (`options.discard: true`). */
  args?: Record<string, unknown>
}

interface V1Mapping {
  /** Target of every action not listed in `actions` (and of an action-less tool). */
  tool: string
  action?: string
  actions?: Record<string, string | V2Target>
}

const same = (...names: string[]) => Object.fromEntries(names.map((name) => [name, name]))
const prefixed = (prefix: string, ...names: string[]) => Object.fromEntries(names.map((name) => [name, `${prefix}${name}`]))

const SPEC_WRITES: Record<string, string> = {
  ...same('create', 'update', 'delete', 'restore', 'ai_edit', 'smash', 'smash_undo'),
  commit_draft: 'create', from_prompt: 'create', generate: 'create', save_draft: 'create', cancel_ai_edit: 'ai_edit',
  contract_refine: 'refine', delete_epic_children: 'bulk_update',
  add_addendum: 'addendum_add', update_addendum: 'addendum_update', dismiss_addendum: 'addendum_dismiss',
  reopen_addendum: 'addendum_reopen', delete_addendum: 'addendum_delete',
}

/** First-party tools that are not deprecated (served unchanged to in-app sessions). */
export const V1_UNALIASED_TOOLS: ReadonlySet<string> = new Set(['specrails_mission'])

export const V1_TO_V2: Record<string, V1Mapping> = {
  specrails_status: { tool: 'specrails_overview', action: 'app' },
  specrails_board: { tool: 'specrails_overview', action: 'project' },
  specrails_context: { tool: 'specrails_overview', action: 'context' },
  specrails_spend: { tool: 'specrails_insights', action: 'spend' },
  specrails_resources: { tool: 'specrails_insights', action: 'resources' },
  specrails_watch: { tool: 'specrails_wait', action: 'until' },
  specrails_guide: { tool: 'specrails_system', action: 'help' },
  specrails_search: { tool: 'specrails_system', action: 'help' },
  specrails_describe: { tool: 'specrails_system', action: 'help' },
  specrails_select_project: { tool: 'specrails_projects', action: 'select' },
  specrails_projects: { tool: 'specrails_projects', actions: { ...same('list', 'get', 'repositories', 'repository_add', 'repository_update', 'repository_remove', 'unregister'), resolve: 'get' } },
  specrails_inbox: { tool: 'specrails_inbox', actions: { ...same('list', 'open', 'answer'), question: 'open', resume: { tool: 'specrails_runs', action: 'resume' }, retry: { tool: 'specrails_runs', action: 'remedy' } } },
  specrails_missions: { tool: 'specrails_missions', actions: { ...same('list', 'get', 'send', 'ask', 'abort'), active: 'list' } },
  specrails_settings: {
    tool: 'specrails_settings',
    actions: {
      ...same('get', 'set'),
      'runtime_providers.list': { tool: 'specrails_providers', action: 'runtime_list' },
      'runtime_providers.test': { tool: 'specrails_providers', action: 'runtime_test' },
      'runtime_providers.save': { tool: 'specrails_providers', action: 'runtime_save' },
    },
  },
  specrails_specs: {
    tool: 'specrails_specs',
    actions: {
      ...same('list', 'get', 'search'), board: { tool: 'specrails_overview', action: 'project' },
      list_addenda: 'get', spending_summary: 'get', files_touched: 'get', list_attachments: 'get', get_attachment: 'get',
      // v1 hidden aliases of specrails_specs_write.
      ...SPEC_WRITES,
    },
  },
  specrails_specs_write: { tool: 'specrails_specs', actions: SPEC_WRITES },
  specrails_rails: {
    tool: 'specrails_rails',
    actions: {
      list: 'list', create_rail: 'create', set_tickets: 'configure', set_profile: 'configure', set_engine: 'configure', set_name: 'rename',
      pr_candidates: { tool: 'specrails_deliveries', action: 'list' }, review_packet: { tool: 'specrails_deliveries', action: 'get' },
      ci_fix: { tool: 'specrails_deliveries', action: 'decide' },
      launch: { tool: 'specrails_runs', action: 'launch' }, launch_all: { tool: 'specrails_runs', action: 'launch_all' }, stop: { tool: 'specrails_runs', action: 'stop' },
    },
  },
  specrails_jobs: {
    tool: 'specrails_runs',
    actions: {
      ...same('list', 'get', 'cancel'), logs: 'get', diagnose_failure: 'diagnose', queue: 'queue', spawn: 'launch', interactive_turn: 'steer',
      finalize: 'settle', pause: 'queue', resume: 'queue', reorder: 'queue', priority: 'queue', purge: 'delete_history',
      compare: 'get', diagnostic: 'get', run_state: 'get', pipeline: 'get', activity: 'get', phase_breakdown: 'get', audit: 'get',
      stats: { tool: 'specrails_insights', action: 'analytics' }, metrics: { tool: 'specrails_insights', action: 'analytics' },
      export: { tool: 'specrails_insights', action: 'export' }, default_spec_model: { tool: 'specrails_settings', action: 'get' },
      // v1 hidden aliases of specrails_runs and specrails_background.
      runtime_runs: 'list', runtime_diagnose: 'diagnose', runtime_evidence: 'get', runtime_steer: 'steer', runtime_resume: 'resume',
      runtime_recover: 'resume', runtime_approve: 'approve', runtime_settle: 'settle', runtime_dismiss: 'dismiss', runtime_cancel: 'cancel',
      ...Object.fromEntries(['background_start', 'background_list', 'background_logs', 'background_kill'].map((name) => [name, { tool: 'specrails_system', action: 'background' }])),
    },
  },
  specrails_runs: { tool: 'specrails_runs', actions: { ...same('diagnose', 'steer', 'resume', 'settle', 'dismiss', 'cancel'), state: 'get', evidence: 'get' } },
  specrails_background: { tool: 'specrails_system', action: 'background' },
  specrails_recovery: {
    tool: 'specrails_runs',
    actions: { inspect: 'recovery_inspect', list_files: 'recovery_inspect', history: 'recovery_inspect', read_file: 'recovery_read', diff: 'recovery_diff', patch: 'recovery_patch', check: 'recovery_check' },
  },
  specrails_chat: {
    tool: 'specrails_missions',
    actions: {
      list_conversations: 'chat_list', get: 'chat_get', messages: 'chat_get', create: 'chat_create', update: 'chat_update', minimize: 'chat_update',
      restore: 'chat_update', send: 'chat_send', abort: 'chat_abort', delete: 'chat_delete', spec_draft: { tool: 'specrails_specs', action: 'create' },
    },
  },
  specrails_agents: {
    tool: 'specrails_providers',
    actions: {
      list: 'profiles_list', get: 'profiles_get', resolve: 'profiles_get', create: 'profiles_create', update: 'profiles_update', migrate: 'profiles_update',
      delete: 'profiles_delete', duplicate: 'profiles_duplicate', rename: 'profiles_rename',
      analytics: { tool: 'specrails_insights', action: 'analytics' }, core_version: { tool: 'specrails_system', action: 'updates' },
      catalog_list: 'catalog_list', catalog_get: 'catalog_get', versions: 'catalog_get', create_custom: 'catalog_create', update_custom: 'catalog_update',
      delete_custom: 'catalog_delete', generate: 'catalog_generate', test: 'catalog_test',
      refine_start: 'catalog_refine', refine_turn: 'catalog_refine', refine_list: 'catalog_refine', refine_get: 'catalog_refine',
      refine_patch: 'catalog_refine', refine_cancel: 'catalog_refine', refine_apply: 'catalog_refine',
    },
  },
  specrails_plugins: { tool: 'specrails_integrations', actions: prefixed('plugins_', 'list', 'preview', 'install', 'uninstall', 'activate', 'deactivate', 'update', 'health') },
  specrails_jira: {
    tool: 'specrails_integrations',
    actions: {
      ...prefixed('jira_', 'connection', 'test', 'connect', 'disconnect', 'sync', 'outbox', 'create_spec', 'links'),
      discover_projects: 'jira_discover', discover_statuses: 'jira_discover', statuses: 'jira_discover', update_connection: 'jira_connect',
      resume: 'jira_sync', retry_outbox: 'jira_retry', spec_details: 'jira_links', discard_spec: { tool: 'specrails_integrations', action: 'jira_transition', args: { options: { discard: true } } },
    },
  },
  specrails_loops: {
    tool: 'specrails_integrations',
    actions: {
      list: 'loops_list', get: 'loops_get', preview: 'loops_get', templates: 'loops_templates', factory: 'loops_templates', commands: 'loops_templates',
      constants_list: 'loops_constants', constant_create: 'loops_constants', constant_update: 'loops_constants', constant_delete: 'loops_constants',
      import: 'loops_import', create: 'loops_save', from_template: 'loops_save', fork: 'loops_save', update: 'loops_save', duplicate: 'loops_save',
      restore_builtin: 'loops_save', publish: 'loops_publish', unpublish: 'loops_publish', delete: 'loops_delete',
      run: { tool: 'specrails_runs', action: 'launch' }, run_get: { tool: 'specrails_runs', action: 'get' },
    },
  },
  specrails_code: {
    tool: 'specrails_integrations',
    actions: { ...prefixed('code_', 'tree', 'find', 'search', 'summary', 'provenance', 'diff'), read_file: 'code_read', regenerate_summary: 'code_summary' },
  },
  specrails_setup: {
    tool: 'specrails_projects',
    actions: {
      prerequisites: 'prerequisites', add_project: 'add', install_config: 'provision', install: 'provision', checkpoints: 'install_status',
      abort: 'abort_install', integration_contract: 'get', available_providers: { tool: 'specrails_providers', action: 'list' },
    },
  },
  specrails_analytics: {
    tool: 'specrails_insights',
    actions: {
      spending: 'spend', invocations: 'analytics', ticket_summary: 'analytics', decision_times: 'analytics', loop_economics: 'analytics',
      ...same('export', 'budget_get', 'budget_set'),
    },
  },
  specrails_git: {
    tool: 'specrails_integrations',
    actions: {
      info: 'git_info', remote: 'git_info', branch: 'git_info', pull_request: 'git_pr', status: 'git_status', log: 'git_log', diff: 'git_diff',
      gh_repo: 'git_gh', gh_auth: 'git_gh', gh_pr_list: 'git_gh', gh_pr_view: 'git_gh',
    },
  },
  specrails_env: {
    tool: 'specrails_settings',
    actions: { get: 'get', set: 'set', auto_configure: 'set', status: 'env_status', recheck: 'env_status', scan: 'env_scan' },
  },
  specrails_support: {
    tool: 'specrails_system',
    actions: { triage: 'triage', core_update_status: 'updates', core_update_check: 'updates', core_update_apply: 'updates', api_meta: 'health' },
  },
}

/** The v2 call a v1 tool action moved to; null for an unknown pair or an unaliased first-party tool. */
export function v2Equivalent(tool: string, action: string | null): V2Target | null {
  const mapping = V1_TO_V2[tool]
  if (!mapping) return null
  const target = action ? mapping.actions?.[action] : undefined
  if (typeof target === 'string') return { tool: mapping.tool, action: target }
  if (target) return target
  if (mapping.action) return { tool: mapping.tool, action: mapping.action }
  return null
}

/** `specrails_runs(get)`: the v2 call to use instead of a v1 one. */
export function deprecationTarget(tool: string, action: string | null): string | null {
  const target = v2Equivalent(tool, action)
  if (!target) return null
  const fixed = flatArgs(target.args ?? {})
  return `${target.tool}(${[target.action, ...fixed].join(', ')})`
}

/** `{ options: { discard: true } }` → `['options.discard:true']`. */
function flatArgs(args: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(args).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
    ? flatArgs(value as Record<string, unknown>, `${prefix}${key}.`)
    : [`${prefix}${key}:${JSON.stringify(value)}`])
}

/** A v1 call (`specrails_jobs(list)`) that serves what a stubbed v2 action will. */
export function v1EquivalentOf(tool: string, action: string): string | null {
  for (const [v1, mapping] of Object.entries(V1_TO_V2)) {
    if (V1_UNALIASED_TOOLS.has(v1)) continue
    for (const [v1Action, target] of Object.entries(mapping.actions ?? {})) {
      const resolved = typeof target === 'string' ? { tool: mapping.tool, action: target } : target
      if (resolved.tool === tool && resolved.action === action) return `${v1}(${v1Action})`
    }
    if (!mapping.actions && mapping.tool === tool && mapping.action === action) return v1
  }
  return null
}
