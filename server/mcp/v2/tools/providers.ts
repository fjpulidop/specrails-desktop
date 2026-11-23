import { z } from 'zod'
import type { ProjectRow } from '../../../desktop-db'
import { apiCall } from '../../tools/types'
import { shortHash } from '../core/canonical'
import type { ConfirmClass } from '../core/decision-state'
import { V2ToolError, result } from '../core/envelope'
import { formatRef } from '../core/refs'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { untrusted } from '../core/untrusted'
import { F, WRITE_FIELDS, optionsOf } from '../core/views'

/**
 * WP9 `specrails_providers`: the AI providers of this machine (installed,
 * signed in, version floor, usage-limit state), their models and efforts, the
 * app-wide default model/effort per provider, the runtime connections (CLI and
 * OpenAI-compatible local engines), agent profiles and the agent studio
 * catalog. Everything goes through the routes the app uses.
 *
 * Switching a default is `specrails_settings(set, agent_defaults)` (app-wide
 * model/effort per provider) or `(set, runtime)` (a project's role routes);
 * `list` and `models` name the effective default and where it comes from.
 */

type Values = Record<string, unknown>
const rec = (v: unknown): Values => v && typeof v === 'object' && !Array.isArray(v) ? v as Values : {}
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined
const get = (ctx: V2CallContext, path: string) => apiCall(ctx, 'GET', path) as Promise<Values>
const send = (ctx: V2CallContext, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => apiCall(ctx, method, path, body) as Promise<Values>
const bad = (ctx: V2CallContext, key: string, params: Record<string, string | number> = {}) => new V2ToolError('invalid_input', ctx.v2.t(`providers.error.${key}`, params))

/** Project of a call when one resolves (explicit, pin or session default); null otherwise. */
function maybeProject(ctx: V2CallContext, args: Values): ProjectRow | null {
  try { return ctx.v2.project(args) } catch { return null }
}

interface Defaults { model: string | null; effort: string | null; source: 'app' | 'default' }

async function catalogAndDefaults(ctx: V2CallContext): Promise<{ catalog: Values[]; settings: Values }> {
  const body = await get(ctx, '/agent-defaults')
  return { catalog: Array.isArray(body.catalog) ? body.catalog as Values[] : [], settings: rec(rec(body.settings).providers) }
}

function defaultsFor(id: string, catalog: Values[], settings: Values): Defaults {
  const entry = rec(settings[id])
  const builtIn = catalog.find((c) => c.id === id)
  if (entry.custom === true && (entry.pipelineModel || entry.pipelineEffort)) {
    return { model: str(entry.pipelineModel) ?? str(builtIn?.defaultModel) ?? null, effort: str(entry.pipelineEffort) ?? null, source: 'app' }
  }
  return { model: str(builtIn?.defaultModel) ?? null, effort: null, source: 'default' }
}

function limitOf(view: Values | undefined): Values | null {
  if (!view) return null
  return { level: view.level ?? 'unknown', usedPercent: view.usedPercent ?? null, rejectedUntil: view.rejectedUntil ?? null, ...(view.rejectedIndefinitely === true ? { rejectedIndefinitely: true } : {}) }
}

const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i

/** Connections a save would add or change whose endpoint is off this machine. */
function remoteEndpoints(values: Values): string[] {
  const list = [...(Array.isArray(values.providers) ? values.providers : []), ...(values.upsert ? [values.upsert] : [])]
  return list.map((p) => str(rec(p).baseUrl)).filter((url): url is string => !!url && !LOOPBACK.test(url))
}

async function connections(ctx: V2CallContext): Promise<{ providers: Values[]; status: Values }> {
  const body = await get(ctx, '/runtime-providers')
  return { providers: Array.isArray(body.providers) ? body.providers as Values[] : [], status: rec(body.status) }
}

/** Profiles and the studio catalog are per project and per installed provider. */
function profileBase(ctx: V2CallContext, args: Values): { base: string; project: ProjectRow; qs: string } {
  const project = ctx.v2.project(args)
  const provider = str(args.provider)
  return { base: `/projects/${project.id}/profiles`, project, qs: provider ? `?provider=${encodeURIComponent(provider)}` : '' }
}
const withQs = (path: string, qs: string, extra = '') => `${path}${qs}${extra ? `${qs ? '&' : '?'}${extra}` : ''}`
const projectRefs = (project: ProjectRow) => ({ project: formatRef('project', project.slug) })
const profileRef = (name: string) => formatRef('profile', name)

async function profileVersion(ctx: V2CallContext, args: Values): Promise<PreviewInput> {
  const { base, qs } = profileBase(ctx, args)
  const id = String(args.id)
  const body = await get(ctx, withQs(`${base}/${encodeURIComponent(id)}`, qs))
  return { effect: ctx.v2.t('providers.effect.profile_delete', { name: id }), refs: [profileRef(id)], version: `p${shortHash(body.profile ?? null)}` }
}

async function catalogVersion(ctx: V2CallContext, args: Values, key: string): Promise<PreviewInput> {
  const { base, qs } = profileBase(ctx, args)
  const id = str(args.id)
  const body = id ? await get(ctx, withQs(`${base}/catalog/${encodeURIComponent(id)}`, qs)).catch(() => null) : null
  return {
    effect: ctx.v2.t(`providers.effect.${key}`, { id: id ?? str(rec(args.values).id) ?? str(args.name) ?? 'draft' }),
    version: `c${shortHash({ body: body?.body ?? null, args: { id: args.id ?? null, message: args.message ?? null, values: args.values ?? null } })}`,
    // AI generation cost is not forecast by the studio: unknown, so it always confirms.
    ...(key === 'catalog_delete' ? {} : { cost: { forecastUsd: null, runs: 1 } }),
  }
}

const REFINE_STEPS = ['start', 'turn', 'apply', 'cancel', 'list', 'get'] as const
const refineCosts = (args: Values): ConfirmClass | null => {
  const step = optionsOf(args).step ?? 'start'
  return step === 'start' || step === 'turn' ? 'costly' : null
}

/** WP9. AI providers, models, runtime providers, agent profiles and the agent studio catalog. */
export const providersTool = defineTool({
  name: 'specrails_providers',
  title: 'Providers',
  description: 'AI providers (sign-in, CLI versions), models, runtime providers, agent profiles (profiles_*) and studio agents (catalog_*).',
  owner: 'WP9',
  fields: {
    ...WRITE_FIELDS,
    provider: z.string(),
    id: z.string().describe('Profile or agent id'),
    name: z.string(),
    values: F.object(),
    message: z.string().describe('catalog_generate/refine'),
  },
  actions: {
    list: {
      tier: 'read',
      doc: 'Installed, signed-in, version, usage limit and default model/effort per provider. options.refresh: true re-detects.',
      handler: async (ctx, args) => {
        const refresh = optionsOf(args).refresh === true
        const [snapshot, quota, { catalog, settings }, runtime] = await Promise.all([
          get(ctx, `/providers/detected${refresh ? '?refresh=1' : ''}`),
          get(ctx, '/provider-quota').catch(() => ({ providers: [] }) as Values),
          catalogAndDefaults(ctx).catch(() => ({ catalog: [] as Values[], settings: {} as Values })),
          connections(ctx).catch(() => ({ providers: [] as Values[], status: {} as Values })),
        ])
        const quotaById = new Map((Array.isArray(quota.providers) ? quota.providers as Values[] : []).map((view) => [String(view.providerId), view]))
        const detected = rec(snapshot.providers)
        const project = maybeProject(ctx, args)
        const items = Object.values(detected).map((raw) => {
          const p = rec(raw)
          const id = String(p.id)
          return {
            id, name: p.displayName ?? id, kind: p.kind ?? 'cli', usable: p.usable === true, installed: p.installed === true,
            ...(p.version ? { version: p.version } : {}), ...(p.meetsMinimum === false ? { meetsMinimum: false } : {}),
            auth: p.authState ?? 'unknown', ...(p.error ? { issue: p.error } : {}), ...(p.vetoed ? { vetoed: true } : {}),
            limit: limitOf(quotaById.get(id)), defaults: defaultsFor(id, catalog, settings),
            ...(project && project.provider === id ? { projectDefault: true } : {}),
          }
        })
        const usable = items.filter((item) => item.usable).map((item) => item.id)
        const limited = items.filter((item) => item.limit?.level === 'rejected').map((item) => item.id)
        return result({
          items,
          connections: runtime.providers.map((c) => ({ id: c.id, kind: c.kind, ...(c.cli ? { cli: c.cli } : {}), ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}), reachable: rec(runtime.status[String(c.id)]).reachable === true })),
          ...(project ? { project: { slug: project.slug, provider: project.provider ?? 'claude' } } : {}),
        }, {
          summary: ctx.v2.t(limited.length ? 'providers.summary.list_limited' : 'providers.summary.list', { usable: usable.join(', ') || '-', count: usable.length, limited: limited.join(', ') }),
          ...(project ? { refs: projectRefs(project) } : {}),
          untrusted: untrusted('/data/items/*/issue'),
        })
      },
    },
    models: {
      tier: 'read',
      required: ['provider'],
      doc: 'Models with their efforts, the built-in default and the app default (switch it with specrails_settings set agent_defaults).',
      handler: async (ctx, args) => {
        const id = String(args.provider)
        const { catalog, settings } = await catalogAndDefaults(ctx)
        const entry = catalog.find((c) => c.id === id)
        if (!entry) throw new V2ToolError('not_found', ctx.v2.t('providers.error.unknown_provider', { provider: id, providers: catalog.map((c) => c.id).join(', ') }))
        const efforts = rec(entry.effortsByModel)
        const models = (Array.isArray(entry.models) ? entry.models as Values[] : []).map((m) => ({ value: m.value, label: m.label, ...(m.default ? { default: true } : {}), efforts: efforts[String(m.value)] ?? [] }))
        const detail = ctx.v2.view === 'detail'
        return result({
          provider: id, name: entry.displayName ?? id, defaultModel: entry.defaultModel ?? null, supportsEffort: entry.supportsEffort === true,
          perAgentModels: entry.perAgentModels === true, models, defaults: defaultsFor(id, catalog, settings),
          ...(detail ? { baselineAgents: entry.baselineAgents ?? [], agentModels: rec(rec(settings[id]).agentModels), customModelAliases: entry.customModelAliases === true } : {}),
        }, { summary: ctx.v2.t('providers.summary.models', { provider: id, count: models.length, model: String(defaultsFor(id, catalog, settings).model ?? '-') }) })
      },
    },
    test: {
      tier: 'write',
      required: ['provider'],
      doc: 'Re-detects a CLI provider (install, version, sign-in) or probes a local connection.',
      handler: async (ctx, args) => {
        const id = String(args.provider)
        const { providers } = await connections(ctx)
        const local = providers.find((c) => c.id === id && c.kind === 'openai-compatible')
        if (local) {
          const probe = await send(ctx, 'POST', '/runtime-providers/test', { baseUrl: local.baseUrl, ...(local.apiKeyEnv ? { apiKeyEnv: local.apiKeyEnv } : {}) })
          return result({ provider: id, kind: 'local', ok: probe.reachable === true, ...probe }, {
            summary: ctx.v2.t(probe.reachable === true ? 'providers.summary.test_ok' : 'providers.summary.test_failed', { provider: id, issue: String(probe.error ?? probe.authState ?? '') }),
            untrusted: untrusted('/data/error'),
          })
        }
        const snapshot = await get(ctx, '/providers/detected?refresh=1')
        const row = rec(rec(snapshot.providers)[id])
        if (!row.id) throw new V2ToolError('not_found', ctx.v2.t('providers.error.unknown_provider', { provider: id, providers: Object.keys(rec(snapshot.providers)).join(', ') }))
        const ok = row.usable === true && row.authState !== 'unauthenticated'
        const issue = row.error ?? (row.authState === 'unauthenticated' ? ctx.v2.t('providers.issue.signed_out') : !row.installed ? ctx.v2.t('providers.issue.not_installed') : '')
        return result({ provider: id, kind: 'cli', ok, installed: row.installed === true, usable: row.usable === true, auth: row.authState ?? 'unknown', ...(row.version ? { version: row.version } : {}), ...(issue ? { issue } : {}) }, {
          summary: ctx.v2.t(ok ? 'providers.summary.test_ok' : 'providers.summary.test_failed', { provider: id, issue: String(issue) }),
          untrusted: untrusted('/data/issue'),
        })
      },
    },
    runtime_list: {
      tier: 'read',
      handler: async (ctx) => {
        const body = await get(ctx, '/runtime-providers')
        const providers = Array.isArray(body.providers) ? body.providers as Values[] : []
        return result({ connections: providers, status: rec(body.status), localEnginesEnabled: body.localEnginesEnabled === true },
          { summary: ctx.v2.t('providers.summary.runtime_list', { count: providers.length }) })
      },
    },
    runtime_save: {
      tier: 'write',
      confirm: (args) => remoteEndpoints(rec(args.values)).length ? 'external' : null,
      required: ['values'],
      doc: 'values.providers replaces the list; values.upsert {id,…} or values.remove (id) edits one. A remote baseUrl confirms.',
      preview: async (ctx, args) => {
        const { providers } = await connections(ctx)
        return { effect: ctx.v2.t('providers.effect.runtime_save', { urls: remoteEndpoints(rec(args.values)).join(', ') }), version: `r${shortHash(providers)}` }
      },
      handler: async (ctx, args) => {
        const values = rec(args.values)
        const { providers: current } = await connections(ctx)
        let next: Values[]
        if (Array.isArray(values.providers)) next = values.providers as Values[]
        else if (values.upsert || values.remove) {
          const upsert = values.upsert ? rec(values.upsert) : null
          if (upsert && !str(upsert.id)) throw bad(ctx, 'connection_id')
          next = current.filter((c) => c.id !== values.remove && c.id !== upsert?.id)
          if (upsert) next.push({ ...(current.find((c) => c.id === upsert.id) ?? {}), ...upsert })
        } else throw bad(ctx, 'runtime_values')
        if (!next.length) throw bad(ctx, 'runtime_empty')
        const body = await send(ctx, 'PUT', '/runtime-providers', { providers: next })
        const saved = Array.isArray(body.providers) ? body.providers as Values[] : next
        return result({ connections: saved, status: rec(body.status) }, { summary: ctx.v2.t('providers.summary.runtime_save', { count: saved.length }) })
      },
    },
    runtime_test: {
      tier: 'write',
      required: ['id'],
      doc: 'Probes a saved connection by id (options.baseUrl/apiKeyEnv test an unsaved one; id is then a label).',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const id = String(args.id)
        let baseUrl = str(options.baseUrl), apiKeyEnv = str(options.apiKeyEnv)
        if (!baseUrl) {
          const { providers } = await connections(ctx)
          const saved = providers.find((c) => c.id === id)
          if (!saved) throw new V2ToolError('not_found', ctx.v2.t('providers.error.unknown_connection', { id, ids: providers.map((c) => c.id).join(', ') }))
          if (saved.kind !== 'openai-compatible') {
            throw bad(ctx, 'cli_connection', { id, cli: String(saved.cli ?? id) })
          }
          baseUrl = str(saved.baseUrl); apiKeyEnv = str(saved.apiKeyEnv)
        }
        const probe = await send(ctx, 'POST', '/runtime-providers/test', { baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) })
        return result({ id, ok: probe.reachable === true, ...probe }, {
          summary: ctx.v2.t(probe.reachable === true ? 'providers.summary.test_ok' : 'providers.summary.test_failed', { provider: id, issue: String(probe.error ?? '') }),
          untrusted: untrusted('/data/error'),
        })
      },
    },

    // ── Agent profiles ──────────────────────────────────────────────────────
    profiles_list: {
      tier: 'read',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const body = await get(ctx, withQs(base, qs))
        const profiles = (Array.isArray(body.profiles) ? body.profiles as Values[] : []).map((p) => ({ name: p.name, ...(p.description ? { description: p.description } : {}), provider: p.provider ?? null, ...(p.isDefault ? { isDefault: true } : {}), ...(p.protected ? { protected: true } : {}) }))
        return result({ items: profiles }, {
          summary: ctx.v2.t('providers.summary.profiles_list', { count: profiles.length, project: project.name }),
          refs: { ...projectRefs(project), ...Object.fromEntries(profiles.slice(0, 20).map((p) => [`profile.${p.name}`, profileRef(String(p.name))])) },
          untrusted: untrusted('/data/items/*/description'),
        })
      },
    },
    profiles_get: {
      tier: 'read',
      required: ['id'],
      doc: 'options.resolve: true previews which profile a rail would use (id = profile to try).',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const body = optionsOf(args).resolve === true
          ? await get(ctx, withQs(`${base}/resolve`, qs, `profile=${encodeURIComponent(id)}`))
          : await get(ctx, withQs(`${base}/${encodeURIComponent(id)}`, qs))
        return result(body, { summary: ctx.v2.t('providers.summary.profile', { name: id }), refs: { ...projectRefs(project), profile: profileRef(id) }, untrusted: untrusted('/data/profile/description', '/data/resolved/profile/description') })
      },
    },
    profiles_create: {
      tier: 'write',
      required: ['name'],
      doc: 'values: the profile body ({ orchestrator, agents, routing, … }); name wins.',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const name = String(args.name)
        const body = await send(ctx, 'POST', withQs(base, qs), { schemaVersion: 1, agents: [], routing: [], ...rec(args.values), name })
        return result(body, { summary: ctx.v2.t('providers.summary.profile_saved', { name }), refs: { ...projectRefs(project), profile: profileRef(name) } })
      },
    },
    profiles_update: {
      tier: 'write',
      required: ['id', 'values'],
      doc: 'values merge into the stored profile (top-level keys replace).',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const current = await get(ctx, withQs(`${base}/${encodeURIComponent(id)}`, qs))
        const body = await send(ctx, 'PATCH', withQs(`${base}/${encodeURIComponent(id)}`, qs), { ...rec(current.profile), ...rec(args.values), name: id })
        return result(body, { summary: ctx.v2.t('providers.summary.profile_saved', { name: id }), refs: { ...projectRefs(project), profile: profileRef(id) } })
      },
    },
    profiles_delete: {
      tier: 'destructive',
      confirm: 'irreversible',
      required: ['id'],
      preview: profileVersion,
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        await send(ctx, 'DELETE', withQs(`${base}/${encodeURIComponent(id)}`, qs))
        return result({ deleted: id }, { summary: ctx.v2.t('providers.summary.profile_deleted', { name: id }), refs: projectRefs(project) })
      },
    },
    profiles_duplicate: {
      tier: 'write',
      required: ['id'],
      doc: 'name: the copy (default <id>-copy).',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const name = str(args.name) ?? `${id}-copy`
        const body = await send(ctx, 'POST', withQs(`${base}/${encodeURIComponent(id)}/duplicate`, qs), { name })
        return result(body, { summary: ctx.v2.t('providers.summary.profile_saved', { name }), refs: { ...projectRefs(project), profile: profileRef(name) } })
      },
    },
    profiles_rename: {
      tier: 'write',
      required: ['id', 'name'],
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id), name = String(args.name)
        const body = await send(ctx, 'POST', withQs(`${base}/${encodeURIComponent(id)}/rename`, qs), { name })
        return result(body, { summary: ctx.v2.t('providers.summary.profile_renamed', { from: id, name }), refs: { ...projectRefs(project), profile: profileRef(name) } })
      },
    },

    // ── Agent studio catalog ────────────────────────────────────────────────
    catalog_list: {
      tier: 'read',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const { agents } = await get(ctx, withQs(`${base}/catalog`, qs))
        const items = (Array.isArray(agents) ? agents as Values[] : []).map((a) => ({ id: a.id, kind: a.kind, ...(a.model ? { model: a.model } : {}), ...(a.description ? { description: a.description } : {}) }))
        return result({ items }, { summary: ctx.v2.t('providers.summary.catalog_list', { count: items.length }), refs: projectRefs(project), untrusted: untrusted('/data/items/*/description') })
      },
    },
    catalog_get: {
      tier: 'read',
      required: ['id'],
      doc: 'options.versions: true adds the edit history of a custom agent.',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const body = await get(ctx, withQs(`${base}/catalog/${encodeURIComponent(id)}`, qs))
        const versions = optionsOf(args).versions === true ? (await get(ctx, withQs(`${base}/catalog/${encodeURIComponent(id)}/versions`, qs))).versions : undefined
        return result({ ...body, ...(versions ? { versions } : {}) }, { summary: ctx.v2.t('providers.summary.catalog_get', { id }), refs: projectRefs(project), untrusted: untrusted('/data/body', '/data/versions/*') })
      },
    },
    catalog_create: {
      tier: 'write',
      required: ['values'],
      doc: 'values: { id: custom-<name>, body }.',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const values = rec(args.values)
        const id = str(values.id) ?? str(args.id)
        if (!id || typeof values.body !== 'string') throw bad(ctx, 'catalog_values')
        const body = await send(ctx, 'POST', withQs(`${base}/catalog`, qs), { id, body: values.body })
        return result(pickId(body, id), { summary: ctx.v2.t('providers.summary.catalog_saved', { id }), refs: projectRefs(project) })
      },
    },
    catalog_update: {
      tier: 'write',
      required: ['id', 'values'],
      doc: 'values.body: the new agent definition.',
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const values = rec(args.values)
        if (typeof values.body !== 'string') throw bad(ctx, 'catalog_values')
        const body = await send(ctx, 'PATCH', withQs(`${base}/catalog/${encodeURIComponent(id)}`, qs), { body: values.body })
        return result(pickId(body, id), { summary: ctx.v2.t('providers.summary.catalog_saved', { id }), refs: projectRefs(project) })
      },
    },
    catalog_delete: {
      tier: 'destructive',
      confirm: 'irreversible',
      required: ['id'],
      preview: (ctx, args) => catalogVersion(ctx, args, 'catalog_delete'),
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        await send(ctx, 'DELETE', withQs(`${base}/catalog/${encodeURIComponent(id)}`, qs))
        return result({ deleted: id }, { summary: ctx.v2.t('providers.summary.catalog_deleted', { id }), refs: projectRefs(project) })
      },
    },
    catalog_generate: {
      tier: 'ai-spawn',
      confirm: 'costly',
      required: ['message'],
      doc: 'message: what the agent should do; name: custom-<name> id. Returns a draft; save it with catalog_create.',
      preview: (ctx, args) => catalogVersion(ctx, args, 'catalog_generate'),
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const name = str(args.name) ?? str(args.id)
        if (!name) throw bad(ctx, 'catalog_name')
        const body = await send(ctx, 'POST', withQs(`${base}/catalog/generate`, qs), { name, description: String(args.message) })
        return result(body, { summary: ctx.v2.t('providers.summary.catalog_draft', { id: name }), refs: projectRefs(project), untrusted: untrusted('/data/draft') })
      },
    },
    catalog_test: {
      tier: 'ai-spawn',
      confirm: 'costly',
      required: ['id'],
      doc: 'message: the sample task; values.draftBody tests an unsaved draft.',
      preview: (ctx, args) => catalogVersion(ctx, args, 'catalog_test'),
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const id = String(args.id)
        const sampleTask = str(args.message)
        if (!sampleTask) throw bad(ctx, 'catalog_sample')
        let draftBody = str(rec(args.values).draftBody)
        if (!draftBody) draftBody = String((await get(ctx, withQs(`${base}/catalog/${encodeURIComponent(id)}`, qs))).body ?? '')
        const body = await send(ctx, 'POST', withQs(`${base}/catalog/test`, qs), { agentId: id, draftBody, sampleTask })
        return result(body, { summary: ctx.v2.t('providers.summary.catalog_tested', { id }), refs: projectRefs(project), untrusted: untrusted('/data/*') })
      },
    },
    catalog_refine: {
      tier: (args) => refineCosts(args) ? 'ai-spawn' : (optionsOf(args).step === 'list' || optionsOf(args).step === 'get' ? 'read' : 'write'),
      confirm: refineCosts,
      required: ['id'],
      doc: 'options.step: start | turn | apply | cancel | list | get; options.refineId for turn/apply/cancel/get; options.autoTest, options.force.',
      preview: (ctx, args) => catalogVersion(ctx, args, 'catalog_refine'),
      handler: async (ctx, args) => {
        const { base, project, qs } = profileBase(ctx, args)
        const options = optionsOf(args)
        const step = String(options.step ?? 'start')
        if (!(REFINE_STEPS as readonly string[]).includes(step)) throw bad(ctx, 'refine_step', { steps: REFINE_STEPS.join(', ') })
        const id = encodeURIComponent(String(args.id))
        const refineId = str(options.refineId)
        if (['turn', 'apply', 'cancel', 'get'].includes(step) && !refineId) throw bad(ctx, 'refine_id', { step })
        if ((step === 'start' || step === 'turn') && !str(args.message)) throw bad(ctx, 'refine_message')
        const session = refineId ? `${base}/catalog/${id}/refine/${encodeURIComponent(refineId)}` : ''
        const body = step === 'start' ? await send(ctx, 'POST', withQs(`${base}/catalog/${id}/refine`, qs), { instruction: args.message, ...(typeof options.autoTest === 'boolean' ? { autoTest: options.autoTest } : {}) })
          : step === 'turn' ? await send(ctx, 'POST', withQs(`${session}/turn`, qs), { instruction: args.message })
          : step === 'apply' ? await send(ctx, 'POST', withQs(`${session}/apply`, qs), typeof options.force === 'boolean' ? { force: options.force } : {})
          : step === 'cancel' ? await send(ctx, 'DELETE', withQs(session, qs))
          : step === 'get' ? await get(ctx, withQs(session, qs))
          : await get(ctx, withQs(`${base}/catalog/${id}/refine`, qs))
        return result(body, { summary: ctx.v2.t(`providers.summary.refine_${step}`, { id: String(args.id) }), refs: projectRefs(project), untrusted: untrusted('/data/*') })
      },
    },
  },
})

function pickId(body: Values, id: string): Values {
  return { id, ...(body.version !== undefined ? { version: body.version } : {}) }
}
