import { z } from 'zod'
import { getDesktopSetting, type ProjectRow } from '../../../desktop-db'
import { scanWorktreeEnvRequirements } from '../../../worktree-env-discovery'
import { getProjectRepositories } from '../../../project-repositories'
import { isMcpEnabled, isTierEnabled, type McpTier } from '../../mcp-tiers'
import { apiCall } from '../../tools/types'
import { shortHash } from '../core/canonical'
import { CONFIRM_ABOVE_USD_KEY, CONFIRM_IN_CLIENT_KEY, readConfirmInClient, readConfirmThreshold } from '../core/confirm'
import { CHOICES_IN_CLIENT_KEY, readChoicesInClient } from '../core/choices'
import { MCP_V2_KEY, isMcpV2Enabled } from '../flag'
import { ATTENTION_CATEGORIES, defaultAttentionPrefs } from '../../../modules/inbox/attention-prefs'
import { TERMINAL_DEFAULTS, TERMINAL_SETTINGS_KEYS } from '../../../modules/terminals/runtime/terminal-settings'
import { defaultBootScope } from '../../../modules/conversations/runtime/context-scope'
import type { ConfirmClass } from '../core/decision-state'
import { V2ToolError, relay, result } from '../core/envelope'
import { formatRef } from '../core/refs'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { untrusted } from '../core/untrusted'
import { F, optionsOf } from '../core/views'

export const APP_SECTIONS = ['app', 'appearance', 'language', 'notifications', 'code', 'terminal', 'mobile', 'webhooks', 'external_mcp', 'mcp', 'connectors', 'role_prompts', 'agent_defaults', 'machine_installs'] as const
export const PROJECT_SECTIONS = ['general', 'runtime', 'subagents', 'branch', 'env', 'budget', 'telemetry', 'rules', 'retention', 'guardrails', 'loop_roles', 'verification', 'environment_plan', 'composer'] as const
type SectionId = (typeof APP_SECTIONS)[number] | (typeof PROJECT_SECTIONS)[number]

/**
 * WP9 `specrails_settings`: every app and project setting by section.
 *
 * - Reads and writes go through the same routes the Settings window uses
 *   (loopback `apiCall`), so validation, broadcasts and observers stay
 *   identical. Values are checked here first, strictly (a route that silently
 *   ignores a bad value would otherwise report success).
 * - `get` answers the effective values and, per key, where each comes from
 *   (`source`: default | app | project | env | os).
 * - `set` writes only known keys of a section and answers the changed keys.
 *   Changes that lower safety (a guardrail off, sub-agents on, env files into
 *   worktrees, an MCP server, the mobile listener) always confirm; raising or
 *   removing a spending cap confirms when the increase exceeds "Ask before
 *   spending"; a webhook URL confirms as external.
 * - Secrets are write-only: webhook secrets and external MCP env values never
 *   leave the server.
 * - What only the window can change is named, with the reason (`GUI_ONLY`:
 *   `get` without a section lists it; a `set` of it says why), never missing
 *   silently. The coverage table: docs/internals/mcp-v2-settings-coverage.md.
 * - `terminal` and `budget` exist at both scopes: an explicit `project` selects
 *   the project scope; without it they are app-wide (never the session default).
 */

type Source = 'default' | 'app' | 'project' | 'env' | 'os'
type Values = Record<string, unknown>

interface SectionRead {
  values: Values
  source?: Record<string, Source>
  /** Read-only facts next to the values (status, effective resolution). */
  info?: Values
  /** Added in `view: detail` only (catalogs, suggestions, long text). */
  detail?: Values
}

interface IO {
  ctx: V2CallContext
  project: ProjectRow | null
  /** `/projects/<id>` for project scope, '' for app scope. */
  base: string
  options: Values
}

type Check = (value: unknown) => unknown

interface SectionDef {
  scope: 'app' | 'project' | 'either'
  /** Writable keys and their checks; absent = read-only. `'*'` passes the object to the route's own validation. */
  keys?: Record<string, Check> | '*' | ((io: IO) => Promise<Record<string, Check>>)
  read(io: IO): Promise<SectionRead>
  write?(io: IO, values: Values, current: SectionRead): Promise<void>
  /** Safety-lowering change (always confirmed). */
  risks?(values: Values): string[]
  /** Sends data to a third party or opens an outside address (confirmed as external): the reason codes (`settings.risk.<code>`). */
  external?(values: Values): string[]
  /** Numeric keys (dot paths into values) whose increase lets more money be spent. */
  caps?: readonly string[]
  destructive?(values: Values): boolean
  /** JSON pointers below `/data` of model/person-authored text. */
  untrusted?: readonly string[]
}

class CheckError extends Error {}
const fail = (expected: string): never => { throw new CheckError(expected) }
const bool: Check = (v) => typeof v === 'boolean' ? v : fail('true or false')
const capUsd: Check = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : fail('a USD amount above 0, or null to remove it')
const usdAtLeast0: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail('a USD amount of 0 or more')
const intIn = (min: number, max: number, nullable = false): Check => (v) =>
  (nullable && v === null) || (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) ? v : fail(`an integer from ${min} to ${max}${nullable ? ', or null' : ''}`)
const oneOf = (...allowed: string[]): Check => (v) => typeof v === 'string' && allowed.includes(v) ? v : fail(`one of ${allowed.join(', ')}`)
const text = (max: number): Check => (v) => typeof v === 'string' && v.length <= max ? v : fail(`text up to ${max} characters`)
const obj: Check = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : fail('an object')
const objOrNull: Check = (v) => v === null ? null : obj(v)
const names: Check = (v) => Array.isArray(v) && v.every((n) => typeof n === 'string') ? v : fail('a list of variable names')
/** "Ask before spending": the GUI's range (PATCH /mcp-admin/preferences rounds to cents). */
const confirmUsd: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000 ? v : fail('a USD amount from 0 to 1000')
const boolsOf = (allowed: readonly string[]): Check => (v) => {
  const value = obj(v) as Values
  const bad = Object.keys(value).filter((key) => !allowed.includes(key) || typeof value[key] !== 'boolean')
  return bad.length ? fail(`an object of true/false for ${allowed.join(', ')}`) : value
}

const rec = (v: unknown): Values => v && typeof v === 'object' && !Array.isArray(v) ? v as Values : {}
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const get = (ctx: V2CallContext, path: string) => apiCall(ctx, 'GET', path) as Promise<Values>
const send = (ctx: V2CallContext, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => apiCall(ctx, method, path, body) as Promise<Values>
const stored = (ctx: V2CallContext, key: string) => { const raw = getDesktopSetting(ctx.desktopDb, key); return raw !== undefined && raw !== null && raw !== '' }
const bySame = (values: Values, defaults: Values, set: Source): Record<string, Source> =>
  Object.fromEntries(Object.keys(defaults).filter((key) => key in values).map((key) => [key, JSON.stringify(values[key]) === JSON.stringify(defaults[key]) ? 'default' : set]))
const pick = (from: Values, keys: readonly string[]): Values => Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]))
const SECRET_KEY = /secret|token|password|apikey|api_key/i
const mask = (key: string, value: unknown) => SECRET_KEY.test(key) && value !== null && value !== undefined && value !== '' ? '***' : value

// ── Project settings (one route, several sections) ──────────────────────────

const PROJECT_DEFAULTS: Values = {
  pipelineTelemetryEnabled: true, orchestratorModel: 'sonnet', prePrompt: '', freestylePrePrompt: '', integrationBranch: '', worktreeEnvPassthrough: [],
  allowSubagents: true, subagentRuntime: null, reviewerFamilySuggestionDismissed: false, reviewWipLimit: null, agentEnvMode: 'inherit',
  agentAuditRetentionDays: 30, jiraPostClarifications: false, baselineOnTouch: false, worktreeEnvFiles: false,
}

function projectSettingsSection(keys: Record<string, Check>, extra: Partial<SectionDef> & { info?: (io: IO, settings: Values) => Promise<Values> } = {}): SectionDef {
  const { info, ...rest } = extra
  return {
    scope: 'project',
    keys,
    async read(io) {
      const settings = await get(io.ctx, `${io.base}/settings`)
      const values = pick(settings, Object.keys(keys))
      const source = bySame(values, pick(PROJECT_DEFAULTS, Object.keys(keys)), 'project')
      if ('orchestratorModel' in values) source.orchestratorModel = settings.orchestratorModelExplicit === true ? 'project' : 'default'
      return { values, source, ...(info ? { info: await info(io, settings) } : {}) }
    },
    async write(io, values) { await send(io.ctx, 'PATCH', `${io.base}/settings`, values) },
    ...rest,
  }
}

// ── Agent runtime config (runtime, guardrails, verification) ────────────────

interface RuntimeRead { config: Values | null; info: Values }

async function readRuntime(io: IO): Promise<RuntimeRead> {
  const body = await get(io.ctx, `${io.base}/agent-runtime/config`)
  const config = body.config && typeof body.config === 'object' ? body.config as Values : null
  return { config, info: { configured: body.configured === true, runtimeAvailable: body.runtimeAvailable === true, efficiencyAvailable: body.efficiencyAvailable === true, openRolesAvailable: body.openRolesAvailable === true } }
}

/** The config a first save starts from: the project's provider on every role (the GUI's default). */
function baseRuntimeConfig(project: ProjectRow | null): Values {
  const provider = project?.provider ?? 'claude'
  return { schemaVersion: 1, enabled: true, providers: [], agents: { architect: { provider }, developer: { provider }, reviewer: { provider } }, verification: [] }
}

async function writeRuntime(io: IO, patch: (config: Values) => Values): Promise<void> {
  const { config } = await readRuntime(io)
  const next = patch(structuredClone(config ?? baseRuntimeConfig(io.project)))
  await send(io.ctx, 'PUT', `${io.base}/agent-runtime/config`, next)
}

const RUNTIME_KEYS = ['enabled', 'agents', 'fixer', 'roles', 'limits', 'review', 'architect', 'efficiency', 'approvalBeforeArchive', 'rolePrompts'] as const

function mergeRuntime(config: Values, values: Values): Values {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'agents' || key === 'roles') {
      const current = rec(config[key])
      for (const [role, entry] of Object.entries(rec(value))) {
        if (entry === null) delete current[role]
        else current[role] = { ...rec(current[role]), ...rec(entry) }
      }
      config[key] = current
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value) && key !== 'rolePrompts') {
      config[key] = { ...rec(config[key]), ...rec(value) }
    } else if (value === null) {
      delete config[key]
    } else {
      config[key] = value
    }
  }
  return config
}

function roleRoutes(config: Values | null): Values {
  const agents = rec(config?.agents)
  const routes: Values = {}
  for (const [role, entry] of Object.entries(agents)) {
    const e = rec(entry)
    routes[role] = { provider: e.provider ?? null, model: e.model ?? null, effort: e.effort ?? null, ...(e.escalation ? { escalation: e.escalation } : {}) }
  }
  if (config?.fixer) { const e = rec(config.fixer); routes.fixer = { provider: e.provider ?? null, model: e.model ?? null, effort: e.effort ?? null } }
  return routes
}

// ── Verification commands (the window's one-line editor) ────────────────────

/** The window's command line grammar (`parseVerificationCommand` in the client): words, "double quotes", \\ escapes in quotes. */
export function parseCommandLine(line: string): { command: string; args: string[] } | null {
  const words: string[] = []
  let current = '', quoted = false, hasWord = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '\\' && i + 1 < line.length) { current += line[++i]; continue }
      if (char === '"') { quoted = false; continue }
      current += char
      continue
    }
    if (char === '"') { quoted = true; hasWord = true; continue }
    if (/\s/.test(char)) { if (hasWord) { words.push(current); current = ''; hasWord = false } continue }
    current += char; hasWord = true
  }
  if (quoted) return null
  if (hasWord) words.push(current)
  return words.length && words[0] ? { command: words[0], args: words.slice(1) } : null
}

/**
 * A list of host commands as the window saves them: each item is a line ("npm run lint"), or an entry whose
 * `command` is a line when it has no `args` (`line` too); `repositoryId` defaults to the project's only repository.
 * The route then applies the runtime config's own validation.
 */
function hostCommands(project: ProjectRow | null): Check {
  const repositories = project ? getProjectRepositories(project) : []
  return (v) => {
    if (!Array.isArray(v)) return fail('a list of commands ("npm test", or {command, args, repositoryId, label})')
    return v.map((item) => {
      const entry: Values = typeof item === 'string' ? { line: item } : { ...rec(item) }
      const line = typeof entry.line === 'string' ? entry.line : typeof entry.command === 'string' && !Array.isArray(entry.args) ? entry.command : null
      if (line !== null) {
        const parsed = parseCommandLine(line)
        if (!parsed) return fail('a command line with closed quotes')
        delete entry.line
        Object.assign(entry, parsed)
      }
      if (typeof entry.command !== 'string' || !entry.command.trim() || !Array.isArray(entry.args)) return fail('a command with its arguments')
      if (entry.repositoryId === undefined) {
        if (repositories.length !== 1) return fail(`a command with repositoryId (one of ${repositories.map((r) => r.id).join(', ')})`)
        entry.repositoryId = repositories[0].id
      } else if (!repositories.some((r) => r.id === entry.repositoryId)) {
        return fail(`a repositoryId of this project (${repositories.map((r) => r.id).join(', ')})`)
      }
      return entry
    })
  }
}

// ── Sections ────────────────────────────────────────────────────────────────

const ENV_LIMIT_KEYS = ['SPECRAILS_MAX_ACTIVE_RUNS', 'SPECRAILS_MAX_RUNS_PER_PROJECT', 'SPECRAILS_MAX_RUNS_PER_PROVIDER', 'SPECRAILS_RUN_ADMISSION']

/**
 * Sections another tool owns: settings reads and writes them through that
 * tool (`ctx.v2.dispatch`), so there is one implementation and one
 * confirmation policy. specrails_integrations owns webhooks and the mobile gateway.
 */
type DelegatedSection = 'webhooks' | 'mobile'
const DELEGATED: Record<DelegatedSection, { get: (args: Values) => Values; set: (values: Values) => Values }> = {
  webhooks: {
    get: () => ({ action: 'webhooks', options: { op: 'list' } }),
    set: (values) => {
      const { id, delete: remove, ...body } = values
      const op = remove === true ? 'delete' : typeof id === 'string' && id ? 'update' : 'create'
      return { action: 'webhooks', ...(typeof id === 'string' ? { id } : {}), ...(op === 'delete' ? {} : { values: body }), options: { op } }
    },
  },
  mobile: {
    get: () => ({ action: 'mobile' }),
    set: (values) => typeof values.revokeDevice === 'string'
      ? { action: 'mobile', id: values.revokeDevice, options: { op: 'revoke' } }
      : values.rotateCert === true ? { action: 'mobile', options: { op: 'rotate' } }
        : { action: 'mobile', options: { op: values.enabled === true ? 'enable' : values.enabled === false ? 'disable' : 'status' } },
  },
}
const isDelegated = (section: unknown): section is DelegatedSection => typeof section === 'string' && section in DELEGATED

/**
 * Settings only the Specrails window can change, by section and key, with the reason (`settings.gui_only.<reason>`).
 * `get` without a section lists them; a `set` of one answers why instead of "unknown key".
 */
export const GUI_ONLY: Record<string, Record<string, 'local_ui' | 'mcp_enabled' | 'mcp_connect' | 'mcp_token' | 'pairing'>> = {
  appearance: { density: 'local_ui', reduceMotion: 'local_ui', agentThinkingHalo: 'local_ui', windowLayout: 'local_ui' },
  code: { editor: 'local_ui' },
  mcp: { enabled: 'mcp_enabled', connect: 'mcp_connect', token: 'mcp_token' },
  mobile: { pair: 'pairing' },
}

function guiOnlyRefusal(ctx: V2CallContext, section: string, values: Values): V2ToolError | null {
  const hit = Object.keys(values).find((key) => GUI_ONLY[section]?.[key])
  return hit ? new V2ToolError('invalid_input', ctx.v2.t('settings.error.gui_only', { key: `${section}.${hit}`, reason: ctx.v2.t(`settings.gui_only.${GUI_ONLY[section][hit]}`) })) : null
}

const TIER_KEYS = ['write', 'aiSpawn', 'destructive'] as const
const MCP_PREFERENCE_KEYS = ['confirmAboveUsd', 'v2', 'confirmInClient', 'choicesInClient'] as const
/** The delegated call, with this call's control fields (confirm, dryRun, lang, view) passed through. */
function delegate(ctx: V2CallContext, args: Values, call: Values) {
  const control = Object.fromEntries((['confirm', 'dryRun', 'lang', 'view'] as const).filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
  return ctx.v2.dispatch({ tool: 'specrails_integrations', args: { ...call, ...control } })
}

const TIER_FIELDS = [['write', 'write'], ['aiSpawn', 'ai-spawn'], ['destructive', 'destructive']] as const

const SECTIONS: Record<Exclude<SectionId, DelegatedSection>, SectionDef> = {
  /**
   * The MCP permission tiers of external clients (Settings ▸ MCP). Turning one
   * OFF is always allowed; turning one ON widens what MCP clients may do, so it
   * needs the person's yes in the client's own dialog (never a confirm token an
   * agent could resend by itself) and is never taken by an in-app agent turn.
   */
  mcp: {
    scope: 'app',
    keys: { write: bool, aiSpawn: bool, destructive: bool, confirmAboveUsd: confirmUsd, v2: bool, confirmInClient: bool, choicesInClient: bool },
    caps: ['confirmAboveUsd'],
    async read({ ctx }) {
      const db = ctx.desktopDb
      const tiers = Object.fromEntries(TIER_FIELDS.map(([key, tier]) => [key, isTierEnabled(db, tier)]))
      const values: Values = { ...tiers, confirmAboveUsd: readConfirmThreshold(db), v2: isMcpV2Enabled(db), confirmInClient: readConfirmInClient(db), choicesInClient: readChoicesInClient(db) }
      const envV2 = process.env.SPECRAILS_MCP_V2 === 'true' || process.env.SPECRAILS_MCP_V2 === 'false'
      return {
        values,
        source: {
          ...bySame(tiers, { write: true, aiSpawn: true, destructive: true }, 'app'),
          confirmAboveUsd: stored(ctx, CONFIRM_ABOVE_USD_KEY) ? 'app' : 'default',
          v2: envV2 ? 'env' : stored(ctx, MCP_V2_KEY) ? 'app' : 'default',
          confirmInClient: stored(ctx, CONFIRM_IN_CLIENT_KEY) ? 'app' : 'default',
          choicesInClient: stored(ctx, CHOICES_IN_CLIENT_KEY) ? 'app' : 'default',
        },
        info: { enabled: isMcpEnabled(db), read: true },
      }
    },
    async write({ ctx }, values, current) {
      const tiers = pick(values, TIER_KEYS)
      const raising = Object.keys(tiers).filter((key) => tiers[key] === true && current.values[key] === false)
      if (raising.length && (ctx.firstPartyAgent || !ctx.v2.confirmedInClient)) {
        throw new V2ToolError('unauthorized', ctx.v2.t('settings.error.tier_raise', { keys: raising.join(', ') }))
      }
      if (Object.keys(tiers).length) await send(ctx, 'PATCH', '/mcp-admin/tiers', tiers)
      const preferences = pick(values, MCP_PREFERENCE_KEYS)
      if (Object.keys(preferences).length) await send(ctx, 'PATCH', '/mcp-admin/preferences', preferences)
    },
    risks: (v) => [
      ...(TIER_KEYS.some((key) => v[key] === true) ? ['mcp_tier_on'] : []),
      // The agent must not loosen its own confirmations silently: only "ask always" (0) skips the question.
      ...(v.confirmAboveUsd !== undefined && v.confirmAboveUsd !== 0 ? ['threshold_change'] : []),
    ],
  },
  app: {
    scope: 'app',
    keys: { autoContinueRuns: bool, resumeOnDailyReset: bool, allowSubagents: bool, subagentRuntime: objOrNull, updateChannel: oneOf('latest', 'stable') },
    async read({ ctx }) {
      const [settings, capacity] = await Promise.all([get(ctx, '/settings'), get(ctx, '/capacity').catch(() => ({ enabled: false }) as Values)])
      const values = pick(settings, ['autoContinueRuns', 'resumeOnDailyReset', 'allowSubagents', 'subagentRuntime', 'updateChannel'])
      const fromEnv = ENV_LIMIT_KEYS.filter((key) => process.env[key] !== undefined && process.env[key] !== '')
      return {
        values,
        source: bySame(values, { autoContinueRuns: true, resumeOnDailyReset: true, allowSubagents: true, subagentRuntime: null, updateChannel: 'latest' }, 'app'),
        info: {
          version: settings.version ?? null,
          port: settings.runningPort ?? settings.port ?? null,
          mcp: { enabled: isMcpEnabled(ctx.desktopDb), write: isTierEnabled(ctx.desktopDb, 'write'), aiSpawn: isTierEnabled(ctx.desktopDb, 'ai-spawn'), destructive: isTierEnabled(ctx.desktopDb, 'destructive') },
          capacity: { enabled: capacity.enabled !== false, limits: capacity.limits ?? null, source: fromEnv.length ? 'env' : 'default', ...(fromEnv.length ? { env: fromEnv } : {}) },
        },
      }
    },
    async write({ ctx }, values) { await send(ctx, 'PUT', '/settings', values) },
    risks: (v) => v.allowSubagents === true ? ['subagents_on'] : [],
  },
  appearance: {
    scope: 'app',
    keys: { theme: text(64) },
    async read({ ctx }) {
      const { theme } = await get(ctx, '/theme')
      return { values: { theme }, source: { theme: theme === 'specrails' ? 'default' : 'app' } }
    },
    async write({ ctx }, values) { await send(ctx, 'PATCH', '/theme', values) },
  },
  language: {
    scope: 'app',
    keys: { language: text(8) },
    async read({ ctx }) {
      const { language } = await get(ctx, '/language')
      return { values: { language: language ?? null }, source: { language: language ? 'app' : 'os' } }
    },
    async write({ ctx }, values) { await send(ctx, 'PATCH', '/language', values) },
  },
  notifications: {
    scope: 'app',
    keys: '*',
    async read({ ctx }) {
      const values = await get(ctx, '/attention-prefs')
      const defaults = defaultAttentionPrefs() as unknown as Values
      const source: Record<string, Source> = {}
      for (const key of ['enabled', 'sound', 'dockBadge', 'mutedProjects']) if (key in values) source[key] = JSON.stringify(values[key]) === JSON.stringify(defaults[key]) ? 'default' : 'app'
      for (const category of ATTENTION_CATEGORIES) source[`categories.${category}`] = rec(values.categories)[category] === false ? 'app' : 'default'
      return { values, source }
    },
    async write({ ctx }, values) { await send(ctx, 'PATCH', '/attention-prefs', values) },
  },
  code: {
    scope: 'app',
    keys: { language: oneOf('en', 'es'), monthlyBudgetUsd: usdAtLeast0 },
    caps: ['monthlyBudgetUsd'],
    async read({ ctx }) {
      const values = await get(ctx, '/code-explorer-settings')
      return { values, source: { language: stored(ctx, 'summary_language') ? 'app' : 'default', monthlyBudgetUsd: stored(ctx, 'summary_monthly_budget_usd') ? 'app' : 'default' } }
    },
    async write({ ctx }, values) { await send(ctx, 'PATCH', '/code-explorer-settings', values) },
  },
  terminal: {
    scope: 'either',
    keys: '*',
    async read({ ctx, base }) {
      if (!base) {
        const values = await get(ctx, '/terminal-settings')
        return { values, source: Object.fromEntries(TERMINAL_SETTINGS_KEYS.filter((key) => key in values).map((key) => [key, stored(ctx, `terminal.${key}`) && JSON.stringify(values[key]) !== JSON.stringify(TERMINAL_DEFAULTS[key]) ? 'app' : 'default'])) }
      }
      const body = await get(ctx, `${base}/terminal-settings`)
      const override = rec(body.override)
      const values = rec(body.resolved)
      return { values, source: Object.fromEntries(Object.keys(values).map((key) => [key, key in override && override[key] !== null ? 'project' : 'app'])) }
    },
    async write({ ctx, base }, values) { await send(ctx, 'PATCH', base ? `${base}/terminal-settings` : '/terminal-settings', values) },
    // The browser shortcut opens this address: a link the person will follow.
    external: (v) => typeof v.browserShortcutUrl === 'string' && v.browserShortcutUrl ? ['browser_url'] : [],
  },
  external_mcp: {
    scope: 'app',
    keys: { servers: obj },
    async read({ ctx }) {
      const body = await get(ctx, '/external-mcp')
      const servers = rec(rec(body.settings).servers)
      // Env values of custom servers are secrets: names only.
      const safe = Object.fromEntries(Object.entries(servers).map(([id, entry]) => {
        const e = rec(entry)
        const transport = e.transport ? rec(e.transport) : null
        return [id, { ...e, ...(transport ? { transport: { ...transport, env: Object.fromEntries(Object.keys(rec(transport.env)).map((key) => [key, '***'])) } } : {}) }]
      }))
      return { values: { servers: safe }, info: { discovered: body.discovered ?? null } }
    },
    async write({ ctx }, values) {
      const body = await get(ctx, '/external-mcp')
      const servers = { ...rec(rec(body.settings).servers) }
      for (const [id, entry] of Object.entries(rec(values.servers))) {
        if (entry === null) delete servers[id]
        else servers[id] = { ...rec(servers[id]), ...rec(entry) }
      }
      await send(ctx, 'PATCH', '/external-mcp', { servers })
    },
    risks: (v) => JSON.stringify(v.servers ?? {}).match(/true|"transport"/) ? ['mcp_server'] : [],
  },
  connectors: {
    scope: 'app',
    keys: '*',
    async read({ ctx, options }) {
      const values = await get(ctx, `/mission-connectors${options.refresh === true ? '?refresh=1' : ''}`)
      // A connector is on unless the person turned it off (the app-wide deny-list).
      const source: Record<string, Source> = {}
      for (const provider of Array.isArray(values.providers) ? values.providers as Values[] : []) {
        for (const row of Array.isArray(provider.connectors) ? provider.connectors as Values[] : []) {
          if (typeof row.name === 'string' && Object.keys(source).length < 50) source[`${String(provider.provider)}/${row.name}`] = row.enabled === false ? 'app' : 'default'
        }
      }
      return { values, source }
    },
    async write({ ctx }, values) { await send(ctx, 'PATCH', '/mission-connectors', values) },
    risks: (v) => v.enabled === true ? ['connector_on'] : [],
  },
  role_prompts: {
    scope: 'app',
    keys: '*',
    untrusted: ['/data/values/*', '/data/defaults/*'],
    async read({ ctx }) {
      const body = await get(ctx, '/runtime-role-prompts')
      const overrides = rec(body.overrides)
      return { values: overrides, source: Object.fromEntries(Object.keys(rec(body.defaults)).map((role) => [role, role in overrides ? 'app' : 'default'])), detail: { defaults: body.defaults ?? {} } }
    },
    async write({ ctx }, values) {
      const { overrides } = await get(ctx, '/runtime-role-prompts')
      const next = { ...rec(overrides) }
      for (const [role, prompt] of Object.entries(values)) { if (prompt === null) delete next[role]; else next[role] = prompt }
      await send(ctx, 'PUT', '/runtime-role-prompts', { overrides: next })
    },
  },
  agent_defaults: {
    scope: 'app',
    keys: '*',
    async read({ ctx }) {
      const body = await get(ctx, '/agent-defaults')
      const providers = rec(rec(body.settings).providers)
      return { values: providers, source: Object.fromEntries(Object.entries(providers).map(([id, e]) => [id, rec(e).custom === true ? 'app' : 'default'])) }
    },
    async write({ ctx }, values) {
      const body = await get(ctx, '/agent-defaults')
      const current = rec(rec(body.settings).providers)
      const patch = rec(values.providers ?? values)
      const providers = Object.fromEntries(Object.entries(patch).map(([id, entry]) => [id, entry === null ? { custom: false } : { ...rec(current[id]), custom: true, ...rec(entry) }]))
      await send(ctx, 'PATCH', '/agent-defaults', { providers })
    },
  },
  machine_installs: {
    scope: 'app',
    keys: { revoke: text(300) },
    async read({ ctx }) { const { approvals } = await get(ctx, '/machine-installs'); return { values: { approvals: Array.isArray(approvals) ? approvals : [] } } },
    async write({ ctx }, values) { await send(ctx, 'DELETE', '/machine-installs', { command: values.revoke }) },
  },

  // Project scope ------------------------------------------------------------
  general: projectSettingsSection(
    { orchestratorModel: oneOf('sonnet', 'opus', 'haiku'), prePrompt: text(20_000), freestylePrePrompt: text(20_000), jiraPostClarifications: bool, baselineOnTouch: bool, reviewerFamilySuggestionDismissed: bool },
    { untrusted: ['/data/values/prePrompt', '/data/values/freestylePrePrompt'], external: (v) => v.jiraPostClarifications === true ? ['jira_post'] : [] },
  ),
  subagents: projectSettingsSection({ allowSubagents: bool, subagentRuntime: objOrNull }, { risks: (v) => v.allowSubagents === true ? ['subagents_on'] : [] }),
  branch: projectSettingsSection({ integrationBranch: text(250) }, {
    info: async (io) => {
      const resolved = await get(io.ctx, `${io.base}/integration-branch`).catch(() => null)
      return resolved ? { effectiveBranch: resolved.branch ?? null, resolvedFrom: resolved.source ?? null } : {}
    },
  }),
  env: {
    ...projectSettingsSection({ worktreeEnvPassthrough: names, agentEnvMode: oneOf('inherit', 'minimal'), worktreeEnvFiles: bool }, {
      info: async (io) => ({ statuses: envStatuses(await get(io.ctx, `${io.base}/env-passthrough/status`).catch(() => ({}))) }),
    }),
    keys: { worktreeEnvPassthrough: names, addNames: names, addScanned: bool, agentEnvMode: oneOf('inherit', 'minimal'), worktreeEnvFiles: bool },
    async write(io, values, current) {
      const { addNames, addScanned, ...rest } = values
      const patch: Values = { ...rest }
      if (addNames || addScanned === true) {
        const existing = Array.isArray(rest.worktreeEnvPassthrough) ? rest.worktreeEnvPassthrough as string[] : (current.values.worktreeEnvPassthrough as string[] | undefined) ?? []
        const scanned = addScanned === true && io.project ? scanWorktreeEnvRequirements(io.project.path).candidates.map((c) => c.name) : []
        patch.worktreeEnvPassthrough = [...new Set([...existing, ...((addNames as string[] | undefined) ?? []), ...scanned])]
      }
      await send(io.ctx, 'PATCH', `${io.base}/settings`, patch)
    },
    risks: (v) => [...(v.worktreeEnvFiles === true ? ['env_files_on'] : []), ...(v.agentEnvMode === 'inherit' ? ['env_inherit'] : [])],
  },
  telemetry: projectSettingsSection({ pipelineTelemetryEnabled: bool, agentAuditRetentionDays: intIn(1, 3650) }),
  budget: {
    scope: 'either',
    keys: async (io): Promise<Record<string, Check>> => io.base
      ? { dailyBudgetUsd: capUsd, weeklyBudgetUsd: capUsd, monthlyBudgetUsd: capUsd, runCapUsd: capUsd, jobCostThresholdUsd: capUsd, reviewWipLimit: intIn(1, 100, true) }
      : { dailyBudgetUsd: capUsd, weeklyBudgetUsd: capUsd, monthlyBudgetUsd: capUsd, runCapUsd: capUsd, costAlertThresholdUsd: capUsd, resumeOnDailyReset: bool, confirmAboveUsd: confirmUsd },
    caps: ['dailyBudgetUsd', 'weeklyBudgetUsd', 'monthlyBudgetUsd', 'runCapUsd', 'confirmAboveUsd'],
    // The agent must not loosen its own confirmations silently: only "ask always" (0) skips the question.
    risks: (v) => v.confirmAboveUsd !== undefined && v.confirmAboveUsd !== 0 ? ['threshold_change'] : [],
    read: readBudget,
    async write({ ctx, base }, values) {
      const { reviewWipLimit, resumeOnDailyReset, confirmAboveUsd, ...caps } = values
      if (base) {
        if (Object.keys(caps).length) await send(ctx, 'PATCH', `${base}/budget`, caps)
        if (reviewWipLimit !== undefined) await send(ctx, 'PATCH', `${base}/settings`, { reviewWipLimit })
        return
      }
      const renamed: Values = {}
      for (const [key, value] of Object.entries(caps)) renamed[APP_BUDGET_FIELD[key] ?? key] = value
      if (Object.keys(renamed).length) await send(ctx, 'PATCH', '/budget', renamed)
      if (resumeOnDailyReset !== undefined) await send(ctx, 'PUT', '/settings', { resumeOnDailyReset })
      // The MCP window's own route (Settings ▸ MCP ▸ Ask before spending): same range and rounding.
      if (confirmAboveUsd !== undefined) await send(ctx, 'PATCH', '/mcp-admin/preferences', { confirmAboveUsd })
    },
  },
  retention: {
    scope: 'project',
    keys: '*',
    async read({ ctx, base }) {
      const [settings, runtime] = await Promise.all([get(ctx, `${base}/settings`), get(ctx, `${base}/agent-runtime/retention`).catch(() => ({}) as Values)])
      const days = settings.agentAuditRetentionDays
      const policy = runtime.policy && typeof runtime.policy === 'object' ? runtime.policy as Values : null
      return {
        values: { runtimeArtifacts: policy, agentAuditRetentionDays: days },
        source: { agentAuditRetentionDays: days === 30 ? 'default' : 'project', runtimeArtifacts: policy && (policy.days ?? null) !== null ? 'project' : 'default' },
      }
    },
    async write({ ctx, base }, values) {
      const { agentAuditRetentionDays, runtimeArtifacts } = values
      if (agentAuditRetentionDays !== undefined) await send(ctx, 'PATCH', `${base}/settings`, { agentAuditRetentionDays: intIn(1, 3650)(agentAuditRetentionDays) })
      if (runtimeArtifacts !== undefined) {
        const current = await get(ctx, `${base}/agent-runtime/retention`)
        await send(ctx, 'PUT', `${base}/agent-runtime/retention`, { ...rec(current.policy), ...rec(obj(runtimeArtifacts)) })
      }
    },
  },
  runtime: {
    scope: 'project',
    keys: Object.fromEntries(RUNTIME_KEYS.map((key) => [key, key === 'enabled' || key === 'approvalBeforeArchive' ? bool : obj])),
    caps: ['limits.maxCostUsd'],
    untrusted: ['/data/rolePrompts/*'],
    async read(io) {
      const { config, info } = await readRuntime(io)
      const { fixer, ...agents } = roleRoutes(config)
      const values: Values = { enabled: config?.enabled ?? false, agents, ...(fixer ? { fixer } : {}), limits: config?.limits ?? {}, review: config?.review ?? {}, architect: config?.architect ?? {}, efficiency: config?.efficiency ?? {}, approvalBeforeArchive: config?.approvalBeforeArchive ?? false, customRoles: Object.keys(rec(config?.roles)) }
      const source: Record<string, Source> = {}
      for (const [role, route] of Object.entries({ ...agents, ...(fixer ? { fixer } : {}) })) source[`${role === 'fixer' ? 'fixer' : `agents.${role}`}.model`] = rec(route).model ? 'project' : 'default'
      return { values, source, info, detail: { roles: config?.roles ?? {}, rolePrompts: config?.rolePrompts ?? {} } }
    },
    async write(io, values) { await writeRuntime(io, (config) => mergeRuntime(config, values)) },
  },
  guardrails: {
    scope: 'project',
    keys: async (io) => {
      const catalog = await guardrailCatalog(io)
      return Object.fromEntries(catalog.map((item) => [item.id, bool]))
    },
    async read(io) {
      const [catalog, { config, info }] = await Promise.all([guardrailCatalog(io), readRuntime(io)])
      const current = rec(config?.guardrails)
      const values = Object.fromEntries(catalog.map((item) => [item.id, current[item.id] !== false]))
      return { values, source: Object.fromEntries(catalog.map((item) => [item.id, item.id in current ? 'project' : 'default'])), info: { ...info, phases: Object.fromEntries(catalog.map((item) => [item.id, item.phase])) } }
    },
    async write(io, values) { await writeRuntime(io, (config) => ({ ...config, guardrails: { ...rec(config.guardrails), ...values } })) },
    risks: (v) => Object.values(v).some((on) => on === false) ? ['guardrail_off'] : [],
  },
  verification: {
    scope: 'project',
    keys: async (io) => ({ verification: hostCommands(io.project), setup: hostCommands(io.project), useSuggestions: bool }),
    async read(io) {
      const { config, info } = await readRuntime(io)
      const values = { verification: Array.isArray(config?.verification) ? config.verification as unknown[] : [], setup: Array.isArray(config?.setup) ? config.setup as unknown[] : [] }
      const detail = io.ctx.v2.view === 'detail' ? { suggestions: (await get(io.ctx, `${io.base}/agent-runtime/verification-suggestions`).catch(() => ({ suggestions: [] }) as Values)).suggestions } : {}
      return { values, source: { verification: values.verification.length ? 'project' : 'default', setup: values.setup.length ? 'project' : 'default' }, info, detail }
    },
    async write(io, values) {
      const { useSuggestions, ...rest } = values
      if (useSuggestions === true) {
        const { suggestions } = await get(io.ctx, `${io.base}/agent-runtime/verification-suggestions`)
        rest.verification = (Array.isArray(suggestions) ? suggestions as Values[] : []).map(({ reason: _reason, ...command }) => command)
      }
      await writeRuntime(io, (config) => ({ ...config, ...rest }))
    },
    // These commands run on this machine at every verification (and setup before it).
    risks: () => ['commands_run'],
  },
  loop_roles: {
    scope: 'project',
    keys: '*',
    async read({ ctx, base }) {
      const { roles } = await get(ctx, `${base}/agent-runtime/loop-roles`)
      const values = rec(roles)
      // A role without its own engine inherits the loop's (the GUI's "inherit").
      return { values, source: Object.fromEntries(['verifier', 'decider', 'triage'].map((role) => [role, values[role] ? 'project' : 'default'])) }
    },
    async write({ ctx, base }, values) {
      const { roles } = await get(ctx, `${base}/agent-runtime/loop-roles`)
      await send(ctx, 'PUT', `${base}/agent-runtime/loop-roles`, { roles: { ...rec(roles), ...rec(values.roles ?? values) } })
    },
  },
  environment_plan: {
    scope: 'project',
    keys: { apply: text(200) },
    async read({ ctx, base }) { const { plans } = await get(ctx, `${base}/agent-runtime/environment-plan`); return { values: { plans: Array.isArray(plans) ? plans : [] } } },
    async write({ ctx, base }, values) { await send(ctx, 'POST', `${base}/agent-runtime/environment-plan/apply`, { repositoryId: values.apply }) },
  },
  /** The Add Spec composer's remembered choices (the next composer starts with them). */
  composer: {
    scope: 'project',
    keys: { contextScope: boolsOf(['specrails', 'openspec', 'full', 'mcp', 'contractRefine', 'userMcp']), quickContractRefine: bool },
    async read({ ctx, base }) {
      const [scope, quick] = await Promise.all([get(ctx, `${base}/context-scope-last`), get(ctx, `${base}/add-spec-quick-contract-refine-last`)])
      const contextScope = rec(scope.scope)
      const boot = defaultBootScope('explore') as unknown as Values
      return {
        values: { contextScope, quickContractRefine: quick.enabled === true },
        source: {
          ...Object.fromEntries(Object.keys(contextScope).map((key) => [`contextScope.${key}`, contextScope[key] === boot[key] ? 'default' : 'project'])),
          quickContractRefine: quick.configured === true ? 'project' : 'default',
        },
      }
    },
    async write({ ctx, base }, values) {
      if (values.contextScope !== undefined) await send(ctx, 'PATCH', `${base}/context-scope-last`, values.contextScope)
      if (values.quickContractRefine !== undefined) await send(ctx, 'PATCH', `${base}/add-spec-quick-contract-refine-last`, { enabled: values.quickContractRefine })
    },
    // Explore turns would start with the person's own MCP servers (their unrestricted access).
    risks: (v) => rec(v.contextScope).userMcp === true ? ['user_mcp_on'] : [],
  },
  rules: {
    scope: 'project',
    untrusted: ['/data/values/inventory', '/data/values/message'],
    async read({ ctx, base }) {
      const body = await get(ctx, `${base}/rules`)
      return { values: pick(body, ['supported', 'running', 'state', 'file', 'modifiedAt', 'inventory', 'message', 'lastRun']) }
    },
  },
}

const APP_BUDGET_FIELD: Record<string, string> = { dailyBudgetUsd: 'desktopDailyBudgetUsd', weeklyBudgetUsd: 'desktopWeeklyBudgetUsd', monthlyBudgetUsd: 'desktopMonthlyBudgetUsd' }

async function readBudget({ ctx, base }: IO): Promise<SectionRead> {
  const app = await get(ctx, '/budget')
  const appCaps: Values = { dailyBudgetUsd: num(app.desktopDailyBudgetUsd), weeklyBudgetUsd: num(app.desktopWeeklyBudgetUsd), monthlyBudgetUsd: num(app.desktopMonthlyBudgetUsd), runCapUsd: num(app.runCapUsd) }
  if (!base) {
    const settings = await get(ctx, '/settings').catch(() => ({}) as Values)
    const values: Values = { ...appCaps, costAlertThresholdUsd: num(app.costAlertThresholdUsd), resumeOnDailyReset: settings.resumeOnDailyReset !== false, confirmAboveUsd: readConfirmThreshold(ctx.desktopDb) }
    const source: Record<string, Source> = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? 'default' : 'app']))
    source.resumeOnDailyReset = values.resumeOnDailyReset === true ? 'default' : 'app'
    source.confirmAboveUsd = stored(ctx, CONFIRM_ABOVE_USD_KEY) ? 'app' : 'default'
    return { values, source, info: { spentTodayUsd: num(app.costToday), dailyUsedPct: num(app.budgetUtilizationPct), unpricedRunsToday: num(app.unpricedRuns) ?? 0 } }
  }
  const [project, settings] = await Promise.all([get(ctx, `${base}/budget`), get(ctx, `${base}/settings`)])
  const values: Values = { dailyBudgetUsd: num(project.dailyBudgetUsd), weeklyBudgetUsd: num(project.weeklyBudgetUsd), monthlyBudgetUsd: num(project.monthlyBudgetUsd), runCapUsd: num(project.runCapUsd), jobCostThresholdUsd: num(project.jobCostThresholdUsd), reviewWipLimit: settings.reviewWipLimit ?? null }
  const source: Record<string, Source> = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? 'default' : 'project']))
  // The gate applies every cap: the tighter of the project's and the app-wide one wins.
  const effective = Object.fromEntries(Object.keys(appCaps).map((key) => {
    const own = values[key] as number | null, wide = appCaps[key] as number | null
    const usd = own === null ? wide : wide === null ? own : Math.min(own, wide)
    return [key, { usd, from: usd === null ? 'none' : usd === own ? 'project' : 'app' }]
  }))
  return { values, source, info: { effective, spentTodayUsd: num(project.costToday), dailyUsedPct: num(project.budgetUtilizationPct) } }
}

async function guardrailCatalog(io: IO): Promise<Array<{ id: string; phase: string }>> {
  const body = await get(io.ctx, `${io.base}/agent-runtime/guardrails`)
  if (body.supported !== true) throw new V2ToolError('conflict', io.ctx.v2.t('settings.error.guardrails_unsupported'))
  return (Array.isArray(body.catalog) ? body.catalog as Values[] : []).map((item) => ({ id: String(item.id), phase: String(item.phase) }))
}

/** Names and states only, rebuilt field by field (values never reach a client). */
function envStatuses(raw: unknown): Values[] {
  const entries = Array.isArray(rec(raw).names) ? rec(raw).names as Values[] : []
  return entries.filter((e) => typeof e?.name === 'string' && typeof e?.status === 'string').map((e) => ({ name: e.name, status: e.status, ...(typeof e.checkedAt === 'string' ? { checkedAt: e.checkedAt } : {}) }))
}

// ── Call plumbing ───────────────────────────────────────────────────────────

function sectionOf(ctx: V2CallContext, args: Values): { id: SectionId; def: SectionDef } {
  const id = args.section as SectionId
  const def = isDelegated(id) ? undefined : SECTIONS[id]
  if (!def) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.unknown_section', { section: String(args.section), sections: [...APP_SECTIONS, ...PROJECT_SECTIONS].join(', ') }))
  return { id, def }
}

function ioFor(ctx: V2CallContext, args: Values, def: SectionDef): IO {
  const a = args
  // Dual-scope sections use the project scope only when the call names a project.
  const project = def.scope === 'project' || (def.scope === 'either' && typeof a.project === 'string' && a.project.trim()) ? ctx.v2.project(a) : null
  return { ctx, project, base: project ? `/projects/${project.id}` : '', options: optionsOf(args) }
}

function refsOf(project: ProjectRow | null): Record<string, string> {
  return project ? { project: formatRef('project', project.slug) } : {}
}

async function keysOf(def: SectionDef, io: IO): Promise<Record<string, Check> | '*' | null> {
  if (!def.keys) return null
  return typeof def.keys === 'function' ? def.keys(io) : def.keys
}

/** The values of a `set`, checked against the section (unknown keys and bad values fail, like the GUI). */
async function checkedValues(ctx: V2CallContext, id: SectionId, def: SectionDef, io: IO, raw: unknown): Promise<Values> {
  const keys = await keysOf(def, io)
  if (!keys) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.read_only', { section: id }))
  const values = rec(raw)
  if (!Object.keys(values).length) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.no_values', { section: id }))
  const guiOnly = guiOnlyRefusal(ctx, id, values)
  if (guiOnly) throw guiOnly
  if (keys === '*') return values
  const unknown = Object.keys(values).filter((key) => !(key in keys))
  if (unknown.length) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.unknown_keys', { section: id, keys: unknown.join(', '), allowed: Object.keys(keys).join(', ') }))
  const out: Values = {}
  for (const [key, value] of Object.entries(values)) {
    try { out[key] = keys[key](value) } catch (err) {
      if (err instanceof CheckError) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.invalid_value', { key, expected: err.message }))
      throw err
    }
  }
  return out
}

const at = (values: Values, path: string): unknown => path.split('.').reduce<unknown>((v, key) => rec(v)[key], values)

/** How much more money a change allows (USD); null when a cap is removed (unbounded); 0 when it only tightens. */
function capIncrease(def: SectionDef, current: Values, values: Values): number | null {
  let increase = 0
  for (const path of def.caps ?? []) {
    const next = at(values, path)
    if (next === undefined) continue
    const before = num(at(current, path))
    if (next === null) { if (before !== null) return null; continue }
    if (typeof next !== 'number') continue
    if (before === null) continue // a first cap only tightens
    increase = Math.max(increase, next - before)
  }
  return increase
}

function riskCodes(def: SectionDef, values: Values): string[] {
  return def.risks?.(values) ?? []
}

function confirmFor(args: Values): ConfirmClass | null {
  const def = isDelegated(args.section) ? undefined : SECTIONS[args.section as Exclude<SectionId, DelegatedSection>]
  if (!def) return null
  const values = rec(args.values)
  if (def.destructive?.(values)) return 'irreversible'
  // Lowering a safeguard can be set back, so it is risky (always confirmed), not "cannot be undone".
  if (riskCodes(def, values).length) return 'risky'
  if (def.external?.(values).length) return 'external'
  if ((def.caps ?? []).some((path) => at(values, path) !== undefined)) return 'costly'
  return null
}

function tierFor(args: Values): McpTier {
  const def = isDelegated(args.section) ? undefined : SECTIONS[args.section as Exclude<SectionId, DelegatedSection>]
  // The tiers themselves: reachable while a tier is off (turning one on asks the person in the client's dialog).
  if (args.section === 'mcp') return Object.keys(rec(args.values)).every((key) => (TIER_KEYS as readonly string[]).includes(key)) ? 'read' : 'write'
  return def?.destructive?.(rec(args.values)) ? 'destructive' : 'write'
}

const showValue = (key: string, value: unknown): string => {
  const shown = mask(key, value)
  const textValue = typeof shown === 'string' ? shown : JSON.stringify(shown)
  return textValue === undefined ? 'unset' : textValue.length > 60 ? `${textValue.slice(0, 57)}…` : textValue
}

async function setPreview(ctx: V2CallContext, args: Values): Promise<PreviewInput> {
  const { id, def } = sectionOf(ctx, args)
  const io = ioFor(ctx, args, def)
  const values = await checkedValues(ctx, id, def, io, args.values)
  const current = await def.read(io)
  const changes = Object.entries(values).map(([key, value]) => `${key}: ${showValue(key, at(current.values, key))} → ${showValue(key, value)}`).join('; ')
  const sentences = [ctx.v2.t('settings.effect.change', { section: id, project: io.project?.name ?? ctx.v2.t('settings.scope.app'), changes })]
  for (const code of [...riskCodes(def, values), ...(def.external?.(values) ?? [])]) sentences.push(ctx.v2.t(`settings.risk.${code}`))
  if (def.destructive?.(values)) sentences.push(ctx.v2.t('settings.risk.delete'))
  const increase = (def.caps ?? []).some((path) => at(values, path) !== undefined) ? capIncrease(def, current.values, values) : undefined
  if (increase === null) sentences.push(ctx.v2.t('settings.risk.cap_removed'))
  else if (increase !== undefined && increase > 0) sentences.push(ctx.v2.t('settings.risk.cap_raise', { usd: increase.toFixed(2) }))
  return {
    effect: sentences.join(' '),
    refs: Object.values(refsOf(io.project)),
    version: `s${shortHash({ section: id, values: current.values })}`,
    ...(increase !== undefined ? { cost: { forecastUsd: increase === null ? null : [0, increase] as [number, number], runs: 1 } } : {}),
  }
}

function envelopeOf(ctx: V2CallContext, id: SectionId, def: SectionDef, io: IO, read: SectionRead, only?: readonly string[]) {
  const detail = ctx.v2.view === 'detail'
  const values = only ? Object.fromEntries(only.map((key) => [key, at(read.values, key)])) : read.values
  const source = read.source ? (only ? Object.fromEntries(Object.entries(read.source).filter(([key]) => only.some((k) => key === k || key.startsWith(`${k}.`)))) : read.source) : undefined
  return {
    section: id,
    scope: io.project ? 'project' : 'app',
    ...(io.project ? { project: io.project.slug } : {}),
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, mask(key, value)])),
    ...(source && Object.keys(source).length ? { source } : {}),
    ...(!only && read.info ? read.info : {}),
    ...(!only && detail && read.detail ? read.detail : {}),
    ...(!only && def.keys && def.keys !== '*' && typeof def.keys !== 'function' ? { writable: Object.keys(def.keys) } : {}),
  }
}

/** `get` with no section: where every setting lives (cheap; no route calls). */
function sectionIndex(ctx: V2CallContext) {
  return result({
    app: APP_SECTIONS,
    project: PROJECT_SECTIONS,
    both: ['terminal', 'budget'],
    mcp: { enabled: isMcpEnabled(ctx.desktopDb), write: isTierEnabled(ctx.desktopDb, 'write'), aiSpawn: isTierEnabled(ctx.desktopDb, 'ai-spawn'), destructive: isTierEnabled(ctx.desktopDb, 'destructive'), confirmAboveUsd: ctx.v2.confirmAboveUsd },
    // Only the Specrails window changes these, and why.
    guiOnly: Object.fromEntries(Object.entries(GUI_ONLY).flatMap(([section, keys]) => Object.entries(keys).map(([key, reason]) => [`${section}.${key}`, ctx.v2.t(`settings.gui_only.${reason}`)]))),
  }, { summary: ctx.v2.t('settings.summary.index', { count: APP_SECTIONS.length + PROJECT_SECTIONS.length }) })
}

/** WP9. App and project settings by section; env scan; webhook test. Secrets are write-only. */
export const settingsTool = defineTool({
  name: 'specrails_settings',
  title: 'Settings',
  description: 'App and project settings by section (get/set; secrets write-only), env scan and status, webhook test.',
  owner: 'WP9',
  fields: {
    project: F.project,
    section: z.enum([...APP_SECTIONS, ...PROJECT_SECTIONS]),
    values: F.object().describe('set: fields to change'),
    view: F.view,
    lang: F.lang,
    confirm: F.confirm,
    dryRun: F.dryRun,
    options: F.options,
  },
  actions: {
    get: {
      tier: 'read',
      doc: 'No section: the section index and guiOnly (what only the window changes, and why). Effective values plus source per key. terminal/budget: app-wide unless project is given.',
      handler: async (ctx, args) => {
        if (args.section === undefined || args.section === null || args.section === '') return sectionIndex(ctx)
        if (isDelegated(args.section)) return relay(await delegate(ctx, args, DELEGATED[args.section].get(args)))
        const { id, def } = sectionOf(ctx, args)
        const io = ioFor(ctx, args, def)
        const read = await def.read(io)
        const data = envelopeOf(ctx, id, def, io, read)
        return result(data, {
          summary: ctx.v2.t('settings.summary.get', { section: id, scope: io.project?.name ?? ctx.v2.t('settings.scope.app'), count: Object.keys(read.values).length }),
          refs: refsOf(io.project),
          ...(def.untrusted?.length ? { untrusted: untrusted(...def.untrusted) } : {}),
        })
      },
    },
    set: {
      tier: tierFor,
      confirm: confirmFor,
      required: ['section', 'values'],
      doc: 'Writes only the given keys; unknown keys fail, window-only keys say why. Lowering safety or adding verification commands always confirms; raising a cap confirms above "Ask before spending"; an outside address confirms as external.',
      preview: setPreview,
      handler: async (ctx, args) => {
        if (isDelegated(args.section)) {
          const guiOnly = guiOnlyRefusal(ctx, args.section, rec(args.values))
          if (guiOnly) throw guiOnly
          return relay(await delegate(ctx, args, DELEGATED[args.section].set(rec(args.values))))
        }
        const { id, def } = sectionOf(ctx, args)
        const io = ioFor(ctx, args, def)
        const values = await checkedValues(ctx, id, def, io, args.values)
        const current = await def.read(io)
        try { await def.write!(io, values, current) } catch (err) {
          if (err instanceof CheckError) throw new V2ToolError('invalid_input', ctx.v2.t('settings.error.invalid_value', { key: Object.keys(values).join(', '), expected: err.message }))
          throw err
        }
        const after = await def.read(io)
        const changed = Object.keys(values).filter((key) => key in after.values)
        return result(envelopeOf(ctx, id, def, io, after, changed.length ? changed : Object.keys(after.values).slice(0, 10)), {
          summary: ctx.v2.t('settings.summary.set', { section: id, scope: io.project?.name ?? ctx.v2.t('settings.scope.app'), keys: Object.keys(values).join(', ') }),
          refs: refsOf(io.project),
          ...(def.untrusted?.length ? { untrusted: untrusted(...def.untrusted) } : {}),
        })
      },
    },
    env_scan: {
      tier: 'read',
      required: ['project'],
      doc: 'Finds env var names the repo references. Add them with set(env, values.addScanned).',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(args)
        const scan = scanWorktreeEnvRequirements(project.path)
        const settings = await get(ctx, `/projects/${project.id}/settings`)
        const configured = new Set(Array.isArray(settings.worktreeEnvPassthrough) ? settings.worktreeEnvPassthrough as string[] : [])
        const items = scan.candidates.slice(0, 50).map((c) => ({ name: c.name, confidence: c.confidence, configured: configured.has(c.name), files: c.files.slice(0, 3) }))
        const missing = items.filter((item) => !item.configured).length
        return result({ items, scannedFiles: scan.scannedFiles.length, skipped: scan.skipped.length, ...(scan.candidates.length > items.length ? { more: scan.candidates.length - items.length } : {}) }, {
          summary: ctx.v2.t('settings.summary.env_scan', { count: scan.candidates.length, missing }),
          refs: refsOf(project),
        })
      },
    },
    env_status: {
      tier: 'read',
      required: ['project'],
      doc: 'options.recheck: true probes the login shell now.',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(args)
        const base = `/projects/${project.id}`
        const raw = optionsOf(args).recheck === true ? await send(ctx, 'POST', `${base}/env-passthrough/recheck`) : await get(ctx, `${base}/env-passthrough/status`)
        const statuses = envStatuses(raw)
        const notReady = statuses.filter((s) => s.status !== 'inherited' && s.status !== 'recovered').length
        return result({ statuses, checking: rec(raw).checking === true, loginShellRecovery: rec(raw).loginShellRecovery !== false }, {
          summary: ctx.v2.t('settings.summary.env_status', { count: statuses.length, notReady }),
          refs: refsOf(project),
        })
      },
    },
    webhook_test: {
      tier: 'write',
      required: ['options.webhookId'],
      doc: 'Runs specrails_integrations(webhooks, op test): its preview and confirmation apply.',
      handler: async (ctx, args) => relay(await delegate(ctx, args, { action: 'webhooks', id: String(optionsOf(args).webhookId), options: { op: 'test' } })),
    },
  },
})
