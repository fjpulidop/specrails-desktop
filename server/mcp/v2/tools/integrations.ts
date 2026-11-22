import { z } from 'zod'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { F, WRITE_FIELDS, optionsOf } from '../core/views'
import { V2ToolError, result, type ResultMeta } from '../core/envelope'
import { pageOf } from '../core/cursor'
import { formatRef, parseRef } from '../core/refs'
import { untrusted, neutralize } from '../core/untrusted'
import { shortHash } from '../core/canonical'
import { asRecord } from '../core/text'
import { apiCall, McpApiError } from '../../tools/types'
import { getProjectRepositories } from '../../../project-repositories'
import { GIT_DIAGNOSTIC_ACTIONS, isGitDiagnosticAction } from '../../../git-diagnostics'
import type { ProjectRow } from '../../../desktop-db'

/**
 * WP10. `specrails_integrations`: Jira, plugins (and the app-global Headroom
 * proxy), the app-wide loops library, Code Explorer reads, read-only git/GitHub,
 * webhooks and the mobile gateway status. Thin over the existing routes
 * (`jira-router.ts`, `plugins-router.ts`, `global-plugins-router.ts`,
 * `loops-router.ts`, `code-explorer-router.ts`, `project-router-git.ts`,
 * `desktop-router-webhooks.ts`, `mobile-admin-router.ts`): the server owns
 * validation, secrets, sync and every WebSocket event. Secrets (Jira token,
 * webhook secret) are write-only: accepted in `values`, never echoed.
 */

type Row = Record<string, unknown>
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const enc = encodeURIComponent
const SECRET_KEYS = new Set(['token', 'secret', 'password'])

const valuesOf = (args: Row): Row => asRecord(args.values)
const opOf = (args: Row, fallback: string): string => str(optionsOf(args).op) ?? fallback
/** Body fields from `values`, only the listed keys, never undefined. */
const pick = (source: Row, keys: readonly string[]): Row => Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
const hostOf = (url: unknown): string => { try { return new URL(String(url)).host } catch { return String(url ?? '') } }
/** A user-facing copy of `values` with secrets reduced to a flag (previews, summaries). */
const redacted = (values: Row): Row => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, SECRET_KEYS.has(key) ? Boolean(value) : value]))

const projectBase = (ctx: V2CallContext, args: Row): { row: ProjectRow; base: string } => {
  const row = ctx.v2.project(args)
  return { row, base: `/projects/${enc(row.id)}` }
}

/** `id` as a bare id or a ref of one of `kinds` (ref wins). */
function idOf(args: Row, kinds: readonly string[], field: 'id' | 'ref' = 'id'): string | undefined {
  for (const value of [args[field], args.ref, args.id]) {
    const parsed = parseRef(value)
    if (parsed && kinds.includes(parsed.kind)) return parsed.id
  }
  return str(args[field]) ?? str(args.id)
}

function writeMeta(summary: string, extra: ResultMeta = {}): ResultMeta {
  return { summary, ...extra }
}

// ── Jira ────────────────────────────────────────────────────────────────────

const JIRA_CREDENTIALS = ['baseUrl', 'accountEmail', 'token'] as const
const JIRA_CONNECT = [...JIRA_CREDENTIALS, 'jiraProjectKey', 'statusMap', 'discardStatus'] as const
const JIRA_UPDATE = ['enabled', 'statusMap', 'discardStatus'] as const

interface JiraState { connected: boolean; connection: Row; outbox: Row }

async function jiraState(ctx: V2CallContext, base: string): Promise<JiraState> {
  const out = asRecord(await apiCall(ctx, 'GET', `${base}/jira/connection`))
  return { connected: out.connected === true, connection: asRecord(out.connection), outbox: asRecord(out.outbox) }
}

const jiraVersion = (state: JiraState) => shortHash({ c: state.connected, k: state.connection.jiraProjectKey, e: state.connection.enabled, u: state.connection.updatedAt })

/** Spec id of a Jira-backed spec: `spec:<project>/<id>` ref or a bare local id. */
function specIdOf(args: Row): number {
  const raw = idOf(args, ['spec'])
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new V2ToolError('invalid_input', 'Pass the spec as ref (spec:<project>/<id>) or its local numeric id.')
  return id
}

function jiraConnectionView(state: JiraState): Row {
  const c = state.connection
  return state.connected
    ? { connected: true, host: hostOf(c.baseUrl), baseUrl: c.baseUrl, deployment: c.deployment, key: c.jiraProjectKey, enabled: c.enabled, hasToken: c.hasToken, accountEmail: c.accountEmail, statusMap: c.statusMap, discardStatus: c.discardStatus, lastSyncAt: c.highWaterMs ? new Date(Number(c.highWaterMs)).toISOString() : null, outbox: state.outbox }
    : { connected: false }
}

// ── Plugins and Headroom ────────────────────────────────────────────────────

const HEADROOM = 'headroom'
const isHeadroom = (id: unknown) => typeof id === 'string' && id.trim().toLowerCase() === HEADROOM
const pluginName = (args: Row) => idOf(args, ['plugin']) ?? ''
const providerQuery = (args: Row) => {
  const provider = str(optionsOf(args).provider)
  return { provider, query: provider ? `?provider=${enc(provider)}` : '', body: provider ? { provider } : undefined }
}
const headroomProvider = (ctx: V2CallContext, args: Row): string => {
  const provider = str(optionsOf(args).provider)
  if (provider !== 'claude' && provider !== 'codex') throw new V2ToolError('invalid_input', ctx.v2.t('integrations.error.headroom_provider'))
  return provider
}

function pluginItem(raw: unknown): Row {
  const p = asRecord(raw)
  return { ref: formatRef('plugin', String(p.name ?? p.id ?? '')), name: p.name ?? p.id, title: p.displayName ?? p.title ?? p.name, status: p.status ?? (p.installed ? 'installed' : 'available'), version: p.version ?? p.installedVersion ?? null, health: p.health ?? null, drift: p.drift ?? p.updateAvailable ?? null }
}

async function pluginRow(ctx: V2CallContext, args: Row): Promise<Row> {
  if (isHeadroom(pluginName(args))) return asRecord(await apiCall(ctx, 'GET', '/global-plugins/headroom'))
  const { base } = projectBase(ctx, args)
  const list = asArray(asRecord(await apiCall(ctx, 'GET', `${base}/plugins${providerQuery(args).query}`)).plugins)
  const found = list.map(asRecord).find((p) => p.name === pluginName(args))
  if (!found) throw new V2ToolError('not_found', `No plugin "${pluginName(args)}". List them with plugins_list.`)
  return found
}

async function pluginOp(ctx: V2CallContext, args: Row, op: 'install' | 'uninstall' | 'activate' | 'deactivate' | 'update'): Promise<unknown> {
  const id = pluginName(args)
  let out: unknown
  if (isHeadroom(id)) {
    if (op === 'activate' || op === 'deactivate') out = await apiCall(ctx, 'POST', `/global-plugins/headroom/${op}`, { provider: headroomProvider(ctx, args) })
    else if (op === 'update') {
      const port = num(optionsOf(args).port)
      if (port === undefined) throw new V2ToolError('invalid_input', 'Headroom update takes options.port (the relay port).')
      out = await apiCall(ctx, 'POST', '/global-plugins/headroom/port', { port })
    } else out = await apiCall(ctx, 'POST', `/global-plugins/headroom/${op}`, {})
  } else {
    const { base } = projectBase(ctx, args)
    const { query, body } = providerQuery(args)
    out = op === 'uninstall'
      ? await apiCall(ctx, 'DELETE', `${base}/plugins/${enc(id)}${query}`)
      : await apiCall(ctx, 'POST', `${base}/plugins/${enc(id)}/${op}`, body)
  }
  return result(out, writeMeta(ctx.v2.t('integrations.summary.plugins_done', { id, op }), { refs: { plugin: formatRef('plugin', id) } }))
}

// ── Loops library (app-global, /api/loops*) ─────────────────────────────────

const loopRef = (id: unknown) => formatRef('loop', String(id))
function loopItem(raw: unknown): Row {
  const l = asRecord(raw)
  return { ref: loopRef(l.id), id: l.id, name: l.name, status: l.status, builtin: l.builtin ?? l.isBuiltin ?? (typeof l.id === 'string' && l.id.startsWith('factory:')), description: l.description ?? null, updatedAt: l.updatedAt ?? l.updated_at ?? null }
}
const loopIdOf = (args: Row): string => {
  const id = idOf(args, ['loop'])
  if (!id) throw new V2ToolError('invalid_input', 'Pass the loop as id or ref (loop:<id>).')
  return id
}
async function readLoop(ctx: V2CallContext, id: string): Promise<Row> {
  const out = asRecord(await apiCall(ctx, 'GET', `/loops/${enc(id)}`))
  return asRecord(out.loop ?? out)
}

// ── Code Explorer ───────────────────────────────────────────────────────────

/** Repository members from the live project context (it carries the memberships), else the row. */
function repositoriesOf(ctx: V2CallContext, row: ProjectRow) {
  let project: unknown = row
  try { project = ctx.registry.getContext(row.id)?.project ?? row } catch { /* row */ }
  return getProjectRepositories(project as Parameters<typeof getProjectRepositories>[0])
}

interface CodeScope { row: ProjectRow; base: string; repositoryId?: string; multi: boolean }

function codeScope(ctx: V2CallContext, args: Row): CodeScope {
  const row = ctx.v2.project(args)
  const raw = args.repository
  const parsed = parseRef(raw)
  const repositoryId = parsed?.kind === 'repository' ? parsed.id : str(raw)
  const members = repositoriesOf(ctx, row)
  if (repositoryId && !members.some((m) => m.id === repositoryId)) {
    throw new V2ToolError('invalid_input', `Unknown repository "${repositoryId}".`, { choices: members.map((m) => ({ ref: formatRef('repository', m.id, row.slug), name: m.name })) })
  }
  const base = `/projects/${enc(row.id)}${repositoryId ? `/repositories/${enc(repositoryId)}` : ''}`
  return { row, base, ...(repositoryId ? { repositoryId } : {}), multi: members.length > 1 }
}

/** File reads in a multi-repository project need a repository; list the choices. */
function requireRepository(ctx: V2CallContext, scope: CodeScope): void {
  if (scope.multi && !scope.repositoryId) {
    const members = repositoriesOf(ctx, scope.row)
    throw new V2ToolError('ambiguous', 'This project has several repositories; pass repository.', { choices: members.map((m) => ({ ref: formatRef('repository', m.id, scope.row.slug), name: m.name })) })
  }
}

const qs = (entries: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function withFindHint<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof McpApiError && err.status === 404) {
      const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path
      throw new V2ToolError('not_found', `No file ${path} at the project root. Paths are project-relative; locate it first.`, {
        next: [{ tool: 'specrails_integrations', args: { action: 'code_find', query: name }, why: 'Find the project-relative path.' }],
      })
    }
    throw err
  }
}

// ── Git (read-only, fixed commands) ─────────────────────────────────────────

async function gitDiagnostic(ctx: V2CallContext, args: Row, op: string): Promise<Row> {
  if (!isGitDiagnosticAction(op)) throw new V2ToolError('invalid_input', `Unknown git op "${op}". Allowed: ${GIT_DIAGNOSTIC_ACTIONS.join(', ')}.`)
  const scope = codeScope(ctx, args)
  requireRepository(ctx, scope)
  return asRecord(await apiCall(ctx, 'GET', `${scope.base}/git/diagnostic${qs({ action: op })}`))
}

/** A fixed git/gh command's outcome; a non-zero exit is a normal answer (no remote, gh signed out). */
function commandView(out: Row): Row {
  const clip = (text: unknown) => typeof text === 'string' ? neutralize(text.length > 6000 ? `${text.slice(0, 6000)}…` : text) : text
  return { ok: out.ok !== false, exitCode: out.exitCode ?? out.code ?? null, stdout: clip(out.stdout), stderr: clip(out.stderr) }
}

async function gitCommand(ctx: V2CallContext, args: Row, op: string) {
  const view = commandView(await gitDiagnostic(ctx, args, op))
  return result(view, {
    summary: ctx.v2.t('integrations.summary.git_command', { op, outcome: view.ok ? ctx.v2.t('integrations.word.ok') : ctx.v2.t('integrations.word.failed') }),
    untrusted: untrusted('/data/stdout', '/data/stderr'),
  })
}

// ── Webhooks (app-global, /api/webhooks) ────────────────────────────────────

const WEBHOOK_FIELDS = ['url', 'secret', 'events', 'projectId', 'enabled'] as const
async function webhookRow(ctx: V2CallContext, id: string): Promise<Row> {
  const list = asArray(asRecord(await apiCall(ctx, 'GET', '/webhooks')).webhooks).map(asRecord)
  const found = list.find((hook) => String(hook.id) === id)
  if (!found) throw new V2ToolError('not_found', ctx.v2.t('integrations.error.webhook_not_found', { id }))
  return found
}
// A URL receives the app's events from then on: creating a webhook or changing its URL is external.
const WEBHOOK_MUTATING: Record<string, { tier: 'write' | 'destructive'; confirm: 'irreversible' | 'external' | null | ((args: Row) => 'external' | null) }> = {
  create: { tier: 'write', confirm: 'external' },
  update: { tier: 'write', confirm: (args) => typeof valuesOf(args).url === 'string' ? 'external' : null },
  delete: { tier: 'destructive', confirm: 'irreversible' },
  test: { tier: 'write', confirm: 'external' },
}

async function webhookPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const op = opOf(args, 'list')
  const id = str(args.id) ?? ''
  const url = str(valuesOf(args).url)
  if (op === 'create') return { effect: ctx.v2.t('integrations.confirm.webhooks_url', { url: hostOf(url) }), version: shortHash({ create: url }) }
  const hook = await webhookRow(ctx, id)
  return {
    effect: ctx.v2.t(op === 'delete' ? 'integrations.confirm.webhooks_delete' : op === 'update' ? 'integrations.confirm.webhooks_url' : 'integrations.confirm.webhooks_test', { url: hostOf(op === 'update' ? url : hook.url) }),
    version: shortHash({ id, url: hook.url, enabled: hook.enabled, events: hook.events }),
  }
}

// ── Mobile gateway (app-global, /api/mobile) ────────────────────────────────

const MOBILE_MUTATING: Record<string, { tier: 'write' | 'destructive'; confirm: 'irreversible' | 'risky' | null }> = {
  enable: { tier: 'write', confirm: 'risky' },
  disable: { tier: 'write', confirm: null },
  revoke: { tier: 'destructive', confirm: 'irreversible' },
}

async function mobileFacts(ctx: V2CallContext): Promise<{ status: Row; devices: unknown[] }> {
  const [status, devices] = await Promise.all([apiCall(ctx, 'GET', '/mobile/status'), apiCall(ctx, 'GET', '/mobile/devices').catch(() => ({ devices: [] }))])
  return { status: asRecord(status), devices: asArray(asRecord(devices).devices ?? devices) }
}

async function mobilePreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const op = opOf(args, 'status')
  const { status, devices } = await mobileFacts(ctx)
  const id = str(args.id) ?? ''
  const device = asRecord(devices.map(asRecord).find((d) => String(d.id) === id))
  return {
    effect: op === 'revoke' ? ctx.v2.t('integrations.confirm.mobile_revoke', { device: neutralize(String(device.name ?? id)).slice(0, 80) }) : ctx.v2.t('integrations.confirm.mobile_enable'),
    version: shortHash({ enabled: status.enabled === true, devices: devices.map((d) => asRecord(d).id) }),
  }
}

// ── The tool ────────────────────────────────────────────────────────────────

const constantsOp = (args: Row) => str(optionsOf(args).op) ?? 'list'

/** WP10. Jira, plugins (and global Headroom), the loops library, code exploration, read-only git, webhooks and the mobile gateway. */
export const integrationsTool = defineTool({
  name: 'specrails_integrations',
  title: 'Integrations',
  description: 'jira_* sync, plugins_* (incl. Headroom), loops_* library, code_* exploration, git_* read-only info, webhooks, mobile.',
  owner: 'WP10',
  fields: {
    ...WRITE_FIELDS,
    repository: z.string().describe('Repository id (multi-repo projects)'),
    query: z.string(),
    path: z.string(),
    id: z.string().describe('Plugin, loop or Jira issue id'),
    values: F.object(),
  },
  actions: {
    // ── Jira (per project) ──
    jira_connection: {
      tier: 'read',
      doc: 'The project\'s Jira connection (token never returned), sync state and outbox counts. view:detail adds the connected project\'s statuses.',
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const state = await jiraState(ctx, base)
        const data = jiraConnectionView(state)
        if (state.connected && ctx.v2.view === 'detail') data.statuses = asRecord(await apiCall(ctx, 'GET', `${base}/jira/statuses`).catch(() => ({}))).statuses ?? null
        const mode = state.connection.enabled === false ? ctx.v2.t('integrations.word.paused') : ctx.v2.t('integrations.word.enabled')
        return result(data, {
          summary: state.connected
            ? ctx.v2.t('integrations.summary.jira_connected', { project: row.name, key: String(state.connection.jiraProjectKey), host: hostOf(state.connection.baseUrl), mode })
            : ctx.v2.t('integrations.summary.jira_disconnected', { project: row.name }),
          refs: { project: formatRef('project', row.slug) },
        })
      },
    },
    jira_test: {
      tier: 'read', required: ['values'],
      doc: 'Checks credentials without saving. values: baseUrl, accountEmail (Cloud), token (secret; never returned).',
      handler: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const values = valuesOf(args)
        const host = hostOf(values.baseUrl)
        try {
          const out = asRecord(await apiCall(ctx, 'POST', `${base}/jira/test`, pick(values, JIRA_CREDENTIALS)))
          return result({ ok: true, ...pick(out, ['deployment', 'apiVersion', 'authScheme', 'user', 'displayName', 'serverTitle']) }, { summary: ctx.v2.t('integrations.summary.jira_test_ok', { host }) })
        } catch (err) {
          if (err instanceof McpApiError && (err.status === 400 || err.status === 401)) {
            const reason = String(asRecord(err.data).error ?? err.status)
            return result({ ok: false, status: err.status, reason }, { summary: ctx.v2.t('integrations.summary.jira_test_failed', { host, reason }) })
          }
          throw err
        }
      },
    },
    jira_discover: {
      tier: 'read',
      doc: 'options.kind: projects (default; values: credentials, query) or statuses (values: credentials + projectKey; without values, the connected project\'s statuses).',
      handler: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const values = valuesOf(args)
        const kind = str(optionsOf(args).kind) === 'statuses' ? 'statuses' : 'projects'
        const out = asRecord(kind === 'statuses' && !values.token
          ? await apiCall(ctx, 'GET', `${base}/jira/statuses`)
          : await apiCall(ctx, 'POST', `${base}/jira/${kind === 'statuses' ? 'discover-statuses' : 'discover-projects'}`, {
            ...pick(values, JIRA_CREDENTIALS),
            ...(kind === 'projects' ? { query: str(args.query) ?? values.query } : { projectKey: values.projectKey }),
          }))
        const items = asArray(out[kind] ?? out.items ?? out.results)
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: `jira:${kind}`, defaultLimit: 50 })
        return result({ kind, items: page.items }, { summary: ctx.v2.t('integrations.summary.jira_discover', { count: items.length, kind }), page: page.page, untrusted: untrusted('/data/items/*/name', '/data/items/*/description') })
      },
    },
    jira_connect: {
      tier: 'write', confirm: 'external', required: ['values'],
      doc: 'With values.token: connect (baseUrl, accountEmail, token, jiraProjectKey, statusMap?, discardStatus?) and start the first sync. Without a token: update the saved connection (enabled, statusMap, discardStatus; enabled:false hands the backlog back to Specrails).',
      preview: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const state = await jiraState(ctx, base)
        const values = valuesOf(args)
        const effect = values.token
          ? ctx.v2.t('integrations.confirm.jira_connect', { project: row.name, key: String(values.jiraProjectKey ?? '?'), host: hostOf(values.baseUrl) })
          : ctx.v2.t('integrations.confirm.jira_update', { project: row.name, changes: Object.keys(pick(values, JIRA_UPDATE)).join(', ') || '—' })
        return { effect, version: jiraVersion(state) }
      },
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const values = valuesOf(args)
        if (values.token) {
          const out = await apiCall(ctx, 'POST', `${base}/jira/connect`, pick(values, JIRA_CONNECT))
          return result(redacted(asRecord(out)), writeMeta(ctx.v2.t('integrations.summary.jira_connect', { project: row.name })))
        }
        const state = await jiraState(ctx, base)
        if (!state.connected) throw new V2ToolError('invalid_input', ctx.v2.t('integrations.error.not_connected', { project: row.name }))
        const out = await apiCall(ctx, 'PATCH', `${base}/jira/connection`, pick(values, JIRA_UPDATE))
        return result(out, writeMeta(ctx.v2.t('integrations.summary.jira_update', { project: row.name })))
      },
    },
    jira_disconnect: {
      tier: 'destructive', confirm: 'irreversible',
      doc: 'Removes the connection and its token; the local backlog becomes writable again.',
      preview: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const state = await jiraState(ctx, base)
        if (!state.connected) throw new V2ToolError('invalid_input', ctx.v2.t('integrations.error.not_connected', { project: row.name }))
        return { effect: ctx.v2.t('integrations.confirm.jira_disconnect', { project: row.name, key: String(state.connection.jiraProjectKey) }), version: jiraVersion(state) }
      },
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const out = await apiCall(ctx, 'DELETE', `${base}/jira/connection`)
        return result(out, writeMeta(ctx.v2.t('integrations.summary.jira_disconnect_done', { project: row.name })))
      },
    },
    jira_sync: {
      tier: 'write',
      doc: 'Full re-fetch of the board (imports every issue as a spec). options.resume:true instead drains the outbox parked after a 401 (after jira_connect with a fresh token).',
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const resume = optionsOf(args).resume === true
        const out = await apiCall(ctx, 'POST', `${base}/jira/${resume ? 'resume' : 'sync'}`)
        return result(out ?? { ok: true }, writeMeta(ctx.v2.t(resume ? 'integrations.summary.jira_resume' : 'integrations.summary.jira_sync', { project: row.name })))
      },
    },
    jira_outbox: {
      tier: 'read',
      doc: 'Write-back operations to Jira. options.state: pending|inflight|done|dead (default all).',
      handler: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const state = str(optionsOf(args).state)
        const out = asRecord(await apiCall(ctx, 'GET', `${base}/jira/outbox${qs({ state })}`))
        const ops = asArray(out.ops).map(asRecord).map((op) => ({ id: op.id, kind: op.opType, state: op.state, attempts: op.attempts ?? null, lastError: op.lastError ?? null, updatedAt: op.updatedAt ?? null }))
        const page = pageOf(ops, { cursor: args.cursor, limit: args.limit, key: `jira:outbox:${state ?? ''}` })
        const counts = asRecord(out.counts)
        return result({ items: page.items, counts }, {
          summary: ctx.v2.t('integrations.summary.jira_outbox', { count: ops.length, dead: Number(counts.dead ?? 0) }), page: page.page, untrusted: untrusted('/data/items/*/lastError'),
        })
      },
    },
    jira_retry: {
      tier: 'write', confirm: 'external', required: ['id'],
      doc: 'Re-queues a failed (dead) outbox operation by its id from jira_outbox.',
      preview: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const ops = asArray(asRecord(await apiCall(ctx, 'GET', `${base}/jira/outbox`)).ops).map(asRecord)
        const op = ops.find((row) => String(row.id) === String(args.id))
        if (!op) throw new V2ToolError('not_found', `No outbox operation ${String(args.id)}.`)
        return { effect: ctx.v2.t('integrations.confirm.jira_retry', { id: String(op.id), kind: String(op.opType) }), version: shortHash({ id: op.id, state: op.state, attempts: op.attempts }) }
      },
      handler: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const out = await apiCall(ctx, 'POST', `${base}/jira/outbox/${enc(String(args.id))}/retry`)
        return result(out, writeMeta(ctx.v2.t('integrations.summary.jira_retry', { id: String(args.id) })))
      },
    },
    jira_create_spec: {
      tier: 'write', confirm: 'external', required: ['values'],
      doc: 'Creates a real Jira issue and its local spec. values: title, description, labels, priority, issueType (default Task).',
      preview: async (ctx, args) => {
        if (!str(valuesOf(args).title)) throw new V2ToolError('invalid_input', 'jira_create_spec needs values.title.')
        const { row, base } = projectBase(ctx, args)
        const state = await jiraState(ctx, base)
        if (!state.connected) throw new V2ToolError('invalid_input', ctx.v2.t('integrations.error.not_connected', { project: row.name }))
        return { effect: ctx.v2.t('integrations.confirm.jira_create_spec', { title: neutralize(String(valuesOf(args).title)), key: String(state.connection.jiraProjectKey) }), version: jiraVersion(state) }
      },
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        if (!str(valuesOf(args).title)) throw new V2ToolError('invalid_input', 'jira_create_spec needs values.title.')
        const out = asRecord(await apiCall(ctx, 'POST', `${base}/jira/specs`, pick(valuesOf(args), ['title', 'description', 'labels', 'priority', 'issueType'])))
        const ref = formatRef('spec', Number(out.localId), row.slug)
        return result({ ref, jiraKey: out.jiraKey }, writeMeta(ctx.v2.t('integrations.summary.jira_create_spec', { key: String(out.jiraKey), ref }), { refs: { spec: ref } }))
      },
    },
    jira_transition: {
      tier: 'write', confirm: 'external',
      doc: 'Moves a Jira-backed spec\'s issue: options.status (a raw Jira status name), or options.discard:true (the configured discard status; options.comment adds a reason).',
      preview: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const id = specIdOf(args)
        const state = await jiraState(ctx, base)
        const status = optionsOf(args).discard === true ? String(state.connection.discardStatus ?? 'discard') : String(optionsOf(args).status ?? '?')
        return { effect: ctx.v2.t('integrations.confirm.jira_transition', { ref: formatRef('spec', id, row.slug), status }), refs: [formatRef('spec', id, row.slug)], version: jiraVersion(state) }
      },
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        const id = specIdOf(args)
        const options = optionsOf(args)
        const out = options.discard === true
          ? await apiCall(ctx, 'POST', `${base}/jira/specs/${id}/discard`, { comment: str(options.comment) })
          : await (async () => {
            const status = str(options.status)
            if (!status) throw new V2ToolError('invalid_input', 'Pass options.status (a Jira status name) or options.discard:true.')
            return apiCall(ctx, 'POST', `${base}/jira/specs/${id}/move-to-status`, { status })
          })()
        const ref = formatRef('spec', id, row.slug)
        return result(out ?? { ok: true }, writeMeta(ctx.v2.t('integrations.summary.jira_transition', { ref }), { refs: { spec: ref } }))
      },
    },
    jira_links: {
      tier: 'read',
      doc: 'The spec↔issue map. With ref/id (a spec): that issue\'s Jira fields and development panel.',
      handler: async (ctx, args) => {
        const { row, base } = projectBase(ctx, args)
        if (args.ref !== undefined || args.id !== undefined) {
          const id = specIdOf(args)
          const ref = formatRef('spec', id, row.slug)
          const details = asRecord(await apiCall(ctx, 'GET', `${base}/jira/specs/${id}/details`))
          return result({ ref, ...details }, {
            summary: ctx.v2.t('integrations.summary.jira_details', { ref, key: String(details.key ?? details.jiraKey ?? '?') }), refs: { spec: ref },
            untrusted: untrusted('/data/summary', '/data/description', '/data/comments', '/data/fields', '/data/development'),
          })
        }
        const links = asArray(asRecord(await apiCall(ctx, 'GET', `${base}/jira/links`)).links).map(asRecord)
          .map((link) => ({ spec: formatRef('spec', Number(link.localId), row.slug), jiraKey: link.jiraKey, state: link.state, status: link.statusName ?? link.status ?? null, tombstoned: link.tombstoned === true }))
        const page = pageOf(links, { cursor: args.cursor, limit: args.limit, key: 'jira:links' })
        return result({ items: page.items }, { summary: ctx.v2.t('integrations.summary.jira_links', { count: links.length }), page: page.page })
      },
    },
    // ── Plugins (per project) + Headroom (app-global, id "headroom") ──
    plugins_list: {
      tier: 'read',
      doc: 'Project plugins (status, version, drift) plus the app-global Headroom proxy. options.provider picks the AI provider registry.',
      handler: async (ctx, args) => {
        const global = asArray(asRecord(await apiCall(ctx, 'GET', '/global-plugins').catch(() => ({}))).plugins).map(pluginItem)
        let project: Row[] = []
        try {
          const { base } = projectBase(ctx, args)
          project = asArray(asRecord(await apiCall(ctx, 'GET', `${base}/plugins${providerQuery(args).query}`)).plugins).map(pluginItem)
        } catch (err) {
          if (!(err instanceof V2ToolError && err.code === 'ambiguous') || args.project !== undefined) throw err
        }
        const items: Row[] = [...global.map((item) => ({ ...item, scope: 'app' })), ...project.map((item) => ({ ...item, scope: 'project' }))]
        const installed = items.filter((item) => !['available', 'not_installed', 'uninstalled'].includes(String(item.status))).length
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: 'plugins' })
        return result({ items: page.items }, { summary: ctx.v2.t('integrations.summary.plugins_list', { installed, count: items.length }), page: page.page })
      },
    },
    plugins_preview: {
      tier: 'read', required: ['id'],
      doc: 'Dry-run install: the config diff and requirements (Headroom: its status).',
      handler: async (ctx, args) => {
        const id = pluginName(args)
        const out = isHeadroom(id) ? await apiCall(ctx, 'GET', '/global-plugins/headroom')
          : await apiCall(ctx, 'GET', `${projectBase(ctx, args).base}/plugins/${enc(id)}/preview-install${providerQuery(args).query}`)
        return result(out, { summary: ctx.v2.t('integrations.summary.plugins_preview', { id }), refs: { plugin: formatRef('plugin', id) } })
      },
    },
    plugins_install: { tier: 'write', required: ['id'], doc: 'Runs the installer + verify (long; plugin.install_progress events). Headroom downloads the proxy.', handler: (ctx, args) => pluginOp(ctx, args, 'install') },
    plugins_uninstall: {
      tier: 'destructive', confirm: 'irreversible', required: ['id'],
      doc: 'Reverts contributors and removes owned MCP servers, installed files and state.',
      preview: async (ctx, args) => {
        const plugin = await pluginRow(ctx, args)
        return { effect: ctx.v2.t('integrations.confirm.plugins_uninstall', { id: pluginName(args) }), refs: [formatRef('plugin', pluginName(args))], version: shortHash({ s: plugin.status ?? plugin.installed, v: plugin.version ?? plugin.installedVersion }) }
      },
      handler: (ctx, args) => pluginOp(ctx, args, 'uninstall'),
    },
    plugins_activate: { tier: 'write', required: ['id'], doc: 'Turns an installed plugin back on (Headroom: options.provider claude|codex).', handler: (ctx, args) => pluginOp(ctx, args, 'activate') },
    plugins_deactivate: { tier: 'write', required: ['id'], doc: 'Turns a plugin off without uninstalling (Headroom: options.provider).', handler: (ctx, args) => pluginOp(ctx, args, 'deactivate') },
    plugins_update: { tier: 'write', required: ['id'], doc: 'Applies manifest drift (Headroom: options.port changes the relay port).', handler: (ctx, args) => pluginOp(ctx, args, 'update') },
    plugins_health: {
      tier: 'read',
      doc: 'On-demand verify of one installed plugin (id), or Headroom diagnostics (id: headroom).',
      handler: async (ctx, args) => {
        const id = pluginName(args) || HEADROOM
        const out = asRecord(isHeadroom(id) ? await apiCall(ctx, 'GET', '/global-plugins/headroom/diagnostics')
          : await apiCall(ctx, 'GET', `${projectBase(ctx, args).base}/plugins/${enc(id)}/health${providerQuery(args).query}`))
        const status = String(out.status ?? out.health ?? (out.ok === false ? 'failing' : 'ok'))
        return result(out, { summary: ctx.v2.t('integrations.summary.plugins_health', { id, status }), refs: { plugin: formatRef('plugin', id) }, untrusted: untrusted('/data/stderr', '/data/stdout', '/data/log') })
      },
    },
    // ── Loops library (app-global) ──
    loops_list: {
      tier: 'read',
      doc: 'The app-wide loop library (built-ins included). Run a published loop with specrails_runs(launch, target:{loopId}).',
      handler: async (ctx, args) => {
        const loops = asArray(asRecord(await apiCall(ctx, 'GET', '/loops')).loops).map(loopItem)
        const query = str(args.query)?.toLowerCase()
        const filtered = query ? loops.filter((loop) => `${String(loop.name)} ${String(loop.description ?? '')}`.toLowerCase().includes(query)) : loops
        const page = pageOf(filtered, { cursor: args.cursor, limit: args.limit, key: `loops:${query ?? ''}` })
        return result({ items: page.items }, {
          summary: ctx.v2.t('integrations.summary.loops_list', { count: filtered.length, published: filtered.filter((loop) => loop.status === 'published').length }),
          page: page.page, untrusted: untrusted('/data/items/*/description'),
        })
      },
    },
    loops_get: {
      tier: 'read', required: ['id'],
      doc: 'One loop; view:detail adds its graph. options.preview:true resolves tokens of its graph (or values.graph) without spawning (options.provider).',
      handler: async (ctx, args) => {
        const id = loopIdOf(args)
        const loop = await readLoop(ctx, id)
        const data: Row = { ...loopItem(loop), turnLimits: loop.turnLimits ?? null }
        if (ctx.v2.view === 'detail') data.graph = loop.graph
        if (optionsOf(args).preview === true) {
          data.preview = await apiCall(ctx, 'POST', '/loops/preview', { graph: valuesOf(args).graph ?? loop.graph, ...(str(optionsOf(args).provider) ? { provider: optionsOf(args).provider } : {}) })
        }
        return result(data, { summary: ctx.v2.t('integrations.summary.loops_get', { name: String(loop.name ?? id), status: String(loop.status ?? '') }), refs: { loop: loopRef(id) }, untrusted: untrusted('/data/description', '/data/graph', '/data/preview') })
      },
    },
    loops_save: {
      tier: 'write',
      doc: 'Saves a draft. No id: create (values: name, description?, graph?). id: update (values; reverts to Draft, 409 while running). options.from: template (id = template id) | factory (fork a built-in) | duplicate | restore (reset a built-in); values.name optional.',
      handler: async (ctx, args) => {
        const values = valuesOf(args)
        const from = str(optionsOf(args).from)
        const id = idOf(args, ['loop'])
        const body = pick(values, ['name', 'description', 'graph'])
        let out: unknown
        if (from) {
          if (!id) throw new V2ToolError('invalid_input', `options.from:${from} needs id.`)
          const route: Record<string, string> = { template: `/loops/from-template/${enc(id)}`, factory: `/loops/factory/${enc(id)}/fork`, duplicate: `/loops/${enc(id)}/duplicate`, restore: `/loops/${enc(id)}/restore-builtin` }
          if (!route[from]) throw new V2ToolError('invalid_input', 'options.from: template, factory, duplicate or restore.')
          out = await apiCall(ctx, 'POST', route[from], from === 'restore' ? undefined : pick(values, ['name']))
        } else if (id) {
          out = await apiCall(ctx, 'PUT', `/loops/${enc(id)}`, body)
        } else {
          if (!str(values.name)) throw new V2ToolError('invalid_input', 'Creating a loop needs values.name.')
          out = await apiCall(ctx, 'POST', '/loops', body)
        }
        const loop = asRecord(asRecord(out).loop ?? out)
        return result(loopItem(loop), writeMeta(ctx.v2.t('integrations.summary.loops_saved', { name: String(loop.name ?? id ?? '') }), { refs: { loop: loopRef(loop.id ?? id) } }))
      },
    },
    loops_delete: {
      tier: 'destructive', confirm: 'irreversible', required: ['id'],
      doc: 'Deletes a loop (built-ins: use loops_save options.from:restore).',
      preview: async (ctx, args) => {
        const id = loopIdOf(args)
        const loop = await readLoop(ctx, id)
        return { effect: ctx.v2.t('integrations.confirm.loops_delete', { name: String(loop.name ?? id) }), refs: [loopRef(id)], version: shortHash({ id, s: loop.status, u: loop.updatedAt ?? loop.updated_at }) }
      },
      handler: async (ctx, args) => {
        const id = loopIdOf(args)
        await apiCall(ctx, 'DELETE', `/loops/${enc(id)}`)
        return result({ ref: loopRef(id), deleted: true }, writeMeta(ctx.v2.t('integrations.summary.loops_deleted', { id })))
      },
    },
    loops_publish: {
      tier: 'write', required: ['id'],
      doc: 'Publishes (graph-validated) so rails and runs can use it. options.unpublish:true reverts to Draft (built-ins cannot).',
      handler: async (ctx, args) => {
        const id = loopIdOf(args)
        const unpublish = optionsOf(args).unpublish === true
        const out = asRecord(await apiCall(ctx, 'POST', `/loops/${enc(id)}/${unpublish ? 'unpublish' : 'publish'}`))
        const loop = asRecord(out.loop ?? out)
        return result(loopItem({ id, ...loop }), writeMeta(ctx.v2.t('integrations.summary.loops_published', { name: String(loop.name ?? id), status: String(loop.status ?? (unpublish ? 'draft' : 'published')) }), { refs: { loop: loopRef(id) } }))
      },
    },
    loops_templates: {
      tier: 'read',
      doc: 'options.kind: templates (default; use with loops_save from:template), factory (built-in loops), commands (AI step magic commands).',
      handler: async (ctx, args) => {
        const kind = str(optionsOf(args).kind) ?? 'templates'
        const path: Record<string, [string, string]> = { templates: ['/loop-templates', 'templates'], factory: ['/loops/factory', 'loops'], commands: ['/loops/commands', 'commands'] }
        if (!path[kind]) throw new V2ToolError('invalid_input', 'options.kind: templates, factory or commands.')
        const out = asRecord(await apiCall(ctx, 'GET', path[kind][0]))
        const items = asArray(out[path[kind][1]] ?? out.items ?? out).map(asRecord).map((item) => kind === 'commands' ? item : { id: item.id, name: item.name, description: item.description ?? null, ...(item.status ? { status: item.status } : {}) })
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: `loops:${kind}`, defaultLimit: 50 })
        return result({ kind, items: page.items }, { summary: ctx.v2.t('integrations.summary.loops_templates', { count: items.length, kind }), page: page.page })
      },
    },
    loops_constants: {
      tier: (args) => constantsOp(args) === 'delete' ? 'destructive' : constantsOp(args) === 'list' ? 'read' : 'write',
      confirm: (args) => constantsOp(args) === 'delete' ? 'irreversible' : null,
      doc: 'Loop constants (tokens usable in loop prompts). options.op: list (default) | create (values: name, value) | update (id, values.value) | delete (id).',
      preview: (ctx, args) => ({ effect: ctx.v2.t('integrations.confirm.loops_constant_delete', { id: String(args.id ?? '') }), version: shortHash({ id: args.id }) }),
      handler: async (ctx, args) => {
        const op = constantsOp(args)
        const values = valuesOf(args)
        const id = str(args.id)
        if (op === 'list') {
          const items = asArray(asRecord(await apiCall(ctx, 'GET', '/loops/constants')).constants)
          const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: 'loops:constants', defaultLimit: 50 })
          return result({ items: page.items }, { summary: ctx.v2.t('integrations.summary.loops_constants', { count: items.length }), page: page.page })
        }
        if (op !== 'create' && !id) throw new V2ToolError('invalid_input', `options.op:${op} needs id.`)
        const out = op === 'create' ? await apiCall(ctx, 'POST', '/loops/constants', { name: values.name, value: values.value ?? '' })
          : op === 'update' ? await apiCall(ctx, 'PUT', `/loops/constants/${enc(id!)}`, { value: values.value ?? '' })
            : op === 'delete' ? await apiCall(ctx, 'DELETE', `/loops/constants/${enc(id!)}`)
              : (() => { throw new V2ToolError('invalid_input', 'options.op: list, create, update or delete.') })()
        return result(out ?? { ok: true }, writeMeta(ctx.v2.t('integrations.summary.loops_constant_done', { op })))
      },
    },
    loops_import: {
      tier: 'write', required: ['values'],
      doc: 'Imports loop export envelopes: values.loops (array).',
      handler: async (ctx, args) => {
        const loops = valuesOf(args).loops
        if (!Array.isArray(loops)) throw new V2ToolError('invalid_input', 'values.loops must be an array of loop export envelopes.')
        const out = asRecord(await apiCall(ctx, 'POST', '/loops/import', { loops }))
        const imported = asArray(out.imported ?? out.loops)
        return result({ imported: imported.map(loopItem), ...pick(out, ['skipped', 'errors']) }, writeMeta(ctx.v2.t('integrations.summary.loops_import', { count: imported.length })))
      },
    },
    // ── Code Explorer (read; summary regeneration is costly) ──
    code_tree: {
      tier: 'read',
      doc: 'The file tree, AI-touched files by default. options: filter (touched-by-ai|all), withProvenance, ticketId, jobId. Pages with cursor.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        const options = optionsOf(args)
        const out = asRecord(await apiCall(ctx, 'GET', `${scope.base}/code/tree${qs({
          filter: str(options.filter), withProvenance: options.withProvenance === true ? '1' : undefined, cursor: str(args.cursor),
          limit: typeof args.limit === 'number' ? args.limit : 100, ticketId: num(options.ticketId), jobId: str(options.jobId),
        })}`))
        const entries = asArray(out.entries).map(asRecord).map((entry) => options.withProvenance === true ? entry : { path: entry.path, kind: entry.kind, ...(entry.repositoryId ? { repositoryId: entry.repositoryId } : {}) })
        const cursor = str(out.nextCursor) ?? null
        return result({ items: entries }, {
          summary: ctx.v2.t('integrations.summary.code_tree', { count: entries.length, more: cursor ? '+' : '' }),
          page: { cursor, truncated: Boolean(cursor) },
        })
      },
    },
    code_find: {
      tier: 'read', required: ['query'],
      doc: 'Locates files by name, path suffix or fragment (ranked project-relative paths). Searches every repository when repository is omitted.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        const query = String(args.query).trim()
        const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50)
        const out = asRecord(scope.multi && !scope.repositoryId
          ? await apiCall(ctx, 'GET', `${scope.base}/code/discover${qs({ kind: 'find', q: query, limit })}`)
          : await apiCall(ctx, 'GET', `${scope.base}/code/find${qs({ q: query, limit })}`))
        const items = asArray(out.matches ?? out.items ?? out.results)
        return result({ items, truncated: out.truncated === true }, { summary: ctx.v2.t('integrations.summary.code_find', { count: items.length, query: neutralize(query) }) })
      },
    },
    code_search: {
      tier: 'read', required: ['query'],
      doc: 'Literal source search (not regex). path narrows to a folder; options.caseSensitive. Searches every repository when repository is omitted.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        const query = String(args.query)
        const limit = Math.min(typeof args.limit === 'number' ? args.limit : 30, 100)
        const params = { q: query, limit, path: str(args.path), caseSensitive: optionsOf(args).caseSensitive === true ? 'true' : undefined }
        const out = asRecord(scope.multi && !scope.repositoryId
          ? await apiCall(ctx, 'GET', `${scope.base}/code/discover${qs({ kind: 'search', ...params })}`)
          : await apiCall(ctx, 'GET', `${scope.base}/code/search${qs(params)}`))
        const items = asArray(out.matches ?? out.results ?? out.items)
        return result({ items, truncated: out.truncated === true, ...pick(out, ['scanned', 'budget']) }, {
          summary: ctx.v2.t('integrations.summary.code_search', { count: items.length, query: neutralize(query) }),
          untrusted: untrusted('/data/items/*/text', '/data/items/*/line', '/data/items/*/preview'),
        })
      },
    },
    code_read: {
      tier: 'read', required: ['path'], maxTokens: 4000,
      doc: 'A bounded page of a file with its content hash. options: startLine (default 1), endLine (default start+199, ≤ 500 lines), startColumn (resume a split line), expectedHash (refuse a changed file). Next page: nextLine.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const path = String(args.path)
        const options = optionsOf(args)
        const start = num(options.startLine) ?? 1
        const end = num(options.endLine) ?? start + 199
        if (end < start) throw new V2ToolError('invalid_input', 'options.endLine must be ≥ startLine.')
        const out = asRecord(await withFindHint(path, () => apiCall(ctx, 'GET', `${scope.base}/code/file${qs({ path, startLine: start, endLine: end, startColumn: num(options.startColumn), expectedHash: str(options.expectedHash) })}`)))
        const total = out.totalLines ?? out.lineCount ?? '?'
        const data = pick(out, ['path', 'content', 'startLine', 'endLine', 'totalLines', 'nextLine', 'nextColumn', 'hash', 'truncated', 'language', 'repositoryId'])
        if (ctx.v2.view === 'detail') Object.assign(data, pick(out, ['summary', 'provenance']))
        return result(data, {
          summary: ctx.v2.t('integrations.summary.code_read', { path, start: Number(out.startLine ?? start), end: Number(out.endLine ?? end), total: String(total) }),
          untrusted: untrusted('/data/content', '/data/summary'),
        })
      },
    },
    code_summary: {
      tier: (args) => optionsOf(args).regenerate === true ? 'ai-spawn' : 'read',
      confirm: (args) => optionsOf(args).regenerate === true ? 'costly' : null,
      required: ['path'],
      doc: 'The stored plain-language summary of a file. options.regenerate:true asks the AI for a new one (async; budget-gated; options.overrideBudget).',
      preview: (ctx, args) => ({ effect: ctx.v2.t('integrations.confirm.code_summary', { path: String(args.path) }), version: shortHash({ path: args.path }), cost: { forecastUsd: null, runs: 1 } }),
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const path = String(args.path)
        if (optionsOf(args).regenerate === true) {
          const out = await apiCall(ctx, 'POST', `${scope.base}/code/file/regenerate-summary${qs({ path })}`, { overrideBudget: optionsOf(args).overrideBudget === true })
          return result(out, writeMeta(ctx.v2.t('integrations.summary.code_summary_queued', { path })))
        }
        const out = await withFindHint(path, () => apiCall(ctx, 'GET', `${scope.base}/code/summary${qs({ path })}`))
        return result(out, { summary: ctx.v2.t('integrations.summary.code_summary', { path }), untrusted: untrusted('/data/summary', '/data/text') })
      },
    },
    code_story: {
      tier: 'read', required: ['path'],
      doc: 'The construction story of a file: the specs and runs that built it, oldest first.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const path = String(args.path)
        const out = asRecord(await withFindHint(path, () => apiCall(ctx, 'GET', `${scope.base}/code/file/story${qs({ path })}`)))
        const items = asArray(out.interventions ?? out.items ?? out.story)
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: `story:${path}` })
        return result({ path, items: page.items }, { summary: ctx.v2.t('integrations.summary.code_story', { count: items.length, path }), page: page.page, untrusted: untrusted('/data/items/*/contribution', '/data/items/*/title', '/data/items/*/summary') })
      },
    },
    code_activity: {
      tier: 'read',
      doc: 'Recent code changes made by runs in the project.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        const out = asRecord(await apiCall(ctx, 'GET', `${scope.base}/code/activity${qs({ limit: typeof args.limit === 'number' ? args.limit : 25 })}`))
        const items = asArray(out.activity ?? out.items ?? out.entries)
        return result({ items }, { summary: ctx.v2.t('integrations.summary.code_activity', { count: items.length }), untrusted: untrusted('/data/items/*/title') })
      },
    },
    code_provenance: {
      tier: 'read', required: ['path'],
      doc: 'Which specs and runs touched a file (options.ticketId / options.jobId narrow).',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const options = optionsOf(args)
        const out = asRecord(await apiCall(ctx, 'GET', `${scope.base}/code/provenance${qs({ path: String(args.path), ticketId: num(options.ticketId), jobId: str(options.jobId) })}`))
        const items = asArray(out.rows ?? out.provenance ?? out.items)
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: `prov:${String(args.path)}` })
        return result({ items: page.items }, { summary: ctx.v2.t('integrations.summary.code_provenance', { count: items.length }), page: page.page })
      },
    },
    code_diff: {
      tier: 'read', required: ['path'], maxTokens: 4000,
      doc: 'The stored unified diff a run (options.jobId) applied to path.',
      handler: async (ctx, args) => {
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const path = String(args.path)
        const jobId = str(optionsOf(args).jobId)
        if (!jobId) throw new V2ToolError('invalid_input', 'code_diff needs options.jobId (the run that changed the file).')
        const out = await apiCall(ctx, 'GET', `${scope.base}/code/diff${qs({ jobId: jobId, path })}`)
        return result(out, { summary: ctx.v2.t('integrations.summary.code_diff', { path }), untrusted: untrusted('/data/diff', '/data/patch') })
      },
    },
    // ── Git and GitHub (read-only, fixed commands) ──
    git_info: {
      tier: 'read',
      doc: 'Branch, commit and local branches. options.op: remote | branch runs that fixed git command instead.',
      handler: async (ctx, args) => {
        const op = str(optionsOf(args).op)
        if (op) return gitCommand(ctx, args, op)
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const out = asRecord(await apiCall(ctx, 'GET', `${scope.base}/git`))
        return result(out, { summary: ctx.v2.t('integrations.summary.git_info', { project: scope.row.name, branch: String(out.branch ?? out.currentBranch ?? '?') }) })
      },
    },
    git_status: { tier: 'read', doc: 'git status --short --branch.', handler: (ctx, args) => gitCommand(ctx, args, 'status') },
    git_log: { tier: 'read', doc: 'The last 20 commits.', handler: (ctx, args) => gitCommand(ctx, args, 'log') },
    git_diff: { tier: 'read', doc: 'Uncommitted change summary (diffstat).', handler: (ctx, args) => gitCommand(ctx, args, 'diff') },
    git_pr: {
      tier: 'read',
      doc: 'options.number: that PR\'s verified URL. Without it: gh pr view of the current branch (state, checks, review).',
      handler: async (ctx, args) => {
        const number = num(optionsOf(args).number) ?? (Number.isSafeInteger(Number(args.id)) && Number(args.id) > 0 ? Number(args.id) : undefined)
        if (number === undefined) return gitCommand(ctx, args, 'gh_pr_view')
        const scope = codeScope(ctx, args)
        requireRepository(ctx, scope)
        const out = asRecord(await apiCall(ctx, 'GET', `${scope.base}/git/pull-requests/${number}`))
        return result(out, { summary: ctx.v2.t('integrations.summary.git_pr', { number, state: String(out.url ?? '?') }) })
      },
    },
    git_gh: {
      tier: 'read',
      doc: 'GitHub connectivity: the linked repository and gh sign-in. options.op: gh_repo | gh_auth | gh_pr_list runs just that.',
      handler: async (ctx, args) => {
        const op = str(optionsOf(args).op)
        if (op) return gitCommand(ctx, args, op)
        const [repo, auth] = await Promise.all([gitDiagnostic(ctx, args, 'gh_repo'), gitDiagnostic(ctx, args, 'gh_auth')])
        const repoView = commandView(repo)
        const authView = commandView(auth)
        const repoName = repoView.ok ? (String(repoView.stdout ?? '').match(/^name:\s*(\S+)/m)?.[1] ?? 'linked') : ctx.v2.t('integrations.word.no_repo')
        return result({ connected: repoView.ok && authView.ok, repo: repoView, auth: authView }, {
          summary: ctx.v2.t('integrations.summary.git_gh', { repo: repoName, auth: authView.ok ? ctx.v2.t('integrations.word.authenticated') : ctx.v2.t('integrations.word.not_authenticated') }),
          untrusted: untrusted('/data/repo/stdout', '/data/repo/stderr', '/data/auth/stdout', '/data/auth/stderr'),
        })
      },
    },
    // ── Webhooks (app-global) ──
    webhooks: {
      tier: (args) => WEBHOOK_MUTATING[opOf(args, 'list')]?.tier ?? 'read',
      confirm: (args) => { const c = WEBHOOK_MUTATING[opOf(args, 'list')]?.confirm ?? null; return typeof c === 'function' ? c(args) : c },
      doc: 'Outgoing webhooks. options.op: list (default) | create (values: url https, events, secret?, projectId?) | update (id, values: url, events, secret, enabled) | delete (id) | test (id; sends a ping).',
      preview: webhookPreview,
      handler: async (ctx, args) => {
        const op = opOf(args, 'list')
        const id = str(args.id)
        if (op === 'list') {
          const hooks = asArray(asRecord(await apiCall(ctx, 'GET', '/webhooks')).webhooks)
          const page = pageOf(hooks, { cursor: args.cursor, limit: args.limit, key: 'webhooks' })
          return result({ items: page.items }, { summary: ctx.v2.t('integrations.summary.webhooks_list', { count: hooks.length }), page: page.page })
        }
        if (!WEBHOOK_MUTATING[op]) throw new V2ToolError('invalid_input', 'options.op: list, create, update, delete or test.')
        if (op !== 'create' && !id) throw new V2ToolError('invalid_input', `options.op:${op} needs id.`)
        const body = pick(valuesOf(args), WEBHOOK_FIELDS)
        const out = op === 'create' ? await apiCall(ctx, 'POST', '/webhooks', body)
          : op === 'update' ? await apiCall(ctx, 'PATCH', `/webhooks/${enc(id!)}`, body)
            : op === 'delete' ? await apiCall(ctx, 'DELETE', `/webhooks/${enc(id!)}`)
              : await apiCall(ctx, 'POST', `/webhooks/${enc(id!)}/test`)
        return result(out, writeMeta(op === 'test' ? ctx.v2.t('integrations.summary.webhooks_test', { id: id! }) : ctx.v2.t('integrations.summary.webhooks_done', { op })))
      },
    },
    // ── Mobile gateway (canonical; specrails_settings(mobile) delegates here) ──
    mobile: {
      tier: (args) => MOBILE_MUTATING[opOf(args, 'status')]?.tier ?? 'read',
      confirm: (args) => MOBILE_MUTATING[opOf(args, 'status')]?.confirm ?? null,
      doc: 'Mobile gateway status and paired devices. options.op: status (default) | enable (opens a LAN listener; confirmed) | disable | revoke (id = device; it must pair again).',
      preview: mobilePreview,
      handler: async (ctx, args) => {
        const op = opOf(args, 'status')
        if (op !== 'status') {
          if (!MOBILE_MUTATING[op]) throw new V2ToolError('invalid_input', 'options.op: status, enable, disable or revoke.')
          const id = str(args.id)
          if (op === 'revoke' && !id) throw new V2ToolError('invalid_input', 'options.op:revoke needs id (the device).')
          if (op === 'revoke') await apiCall(ctx, 'DELETE', `/mobile/devices/${enc(id!)}`)
          else await apiCall(ctx, 'POST', op === 'enable' ? '/mobile/enable' : '/mobile/disable')
        }
        const { status: s, devices: list } = await mobileFacts(ctx)
        const enabled = s.enabled === true || s.running === true || s.listening === true
        const summary = ctx.v2.t('integrations.summary.mobile', { state: enabled ? ctx.v2.t('integrations.word.enabled') : ctx.v2.t('integrations.word.disabled'), devices: list.length })
        return result({ ...s, devices: list }, { ...(op === 'status' ? { summary } : writeMeta(summary)), untrusted: untrusted('/data/devices/*/name') })
      },
    },
  },
})
