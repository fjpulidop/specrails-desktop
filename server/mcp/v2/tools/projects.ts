import { z } from 'zod'
import { defineTool, type V2CallContext } from '../core/registry'
import { WRITE_FIELDS, optionsOf } from '../core/views'
import { result, V2ToolError } from '../core/envelope'
import { formatRef, type Ref } from '../core/refs'
import { pageOf } from '../core/cursor'
import { shortHash } from '../core/canonical'
import { untrusted } from '../core/untrusted'
import { normalizeLang } from '../core/lang'
import { apiCall } from '../../tools/types'
import type { ProjectRow } from '../../../desktop-db'
import { getProjectRepositories, type ProjectRepository } from '../../../project-repositories'

/**
 * WP2 `specrails_projects` (app level): the registered projects, the session
 * default, adding / cloning / provisioning, repositories and the sample
 * project. Every write goes through the app's own route (loopback), so the
 * validation, broadcasts and background assembly are the GUI's.
 */

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : undefined

const PROJECTS = 'specrails_projects'
const CLONE_TIMEOUT_MS = 310_000

/** The project of a call; v1's `projectId` keeps working. */
function projectOf(ctx: V2CallContext, args: Row): ProjectRow {
  return ctx.v2.project({ ...args, project: args.project ?? args.projectId })
}

const base = (row: ProjectRow) => `/projects/${encodeURIComponent(row.id)}`
const projectRef = (row: Pick<ProjectRow, 'slug'>): Ref => formatRef('project', row.slug)

function available(ctx: V2CallContext, row: ProjectRow): boolean {
  // `getContext` may load a project on demand: only the registry's warm list is consulted here.
  try { return (ctx.registry.listContexts?.() ?? []).some((context) => context.project.id === row.id) } catch { return false }
}

function repositoryView(row: ProjectRow, repository: ProjectRepository): Row {
  return {
    ref: formatRef('repository', repository.id, row.slug),
    id: repository.id,
    name: repository.name,
    path: repository.path,
    kind: repository.kind,
    primary: repository.isPrimary,
    integrationBranch: repository.integrationBranch,
    ...(repository.workspacePaths?.length ? { workspacePaths: repository.workspacePaths } : repository.workspacePath ? { workspacePaths: [repository.workspacePath] } : {}),
    ...(repository.available === false ? { available: false } : {}),
  }
}

/** The lean project line of a list. */
function projectLine(ctx: V2CallContext, row: ProjectRow, defaultId: string | null, available: ReadonlySet<string>): Row {
  const repositories = getProjectRepositories(row)
  return {
    ref: projectRef(row), id: row.id, slug: row.slug, name: row.name, path: row.path,
    providers: row.providers,
    ...(repositories.length > 1 ? { repositories: repositories.length } : {}),
    ...(available.has(row.id) ? {} : { loaded: false }),
    ...(row.id === defaultId ? { default: true } : {}),
  }
}

function projectView(ctx: V2CallContext, row: ProjectRow): Row {
  return {
    ref: projectRef(row), id: row.id, slug: row.slug, name: row.name, path: row.path,
    provider: row.provider, providers: row.providers,
    repositories: getProjectRepositories(row).map((repository) => repositoryView(row, repository)),
    loaded: available(ctx, row),
    default: ctx.sessionState.activeProjectId === row.id,
    addedAt: row.added_at, lastSeenAt: row.last_seen_at,
  }
}

const SETTINGS_GLANCE = ['integrationBranch', 'orchestratorModel', 'allowSubagents', 'reviewWipLimit', 'pipelineTelemetryEnabled', 'worktreeEnvPassthrough'] as const

async function readOptional(ctx: V2CallContext, path: string): Promise<{ ok: true; value: Row } | { ok: false; error: string }> {
  try { return { ok: true, value: record(await apiCall(ctx, 'GET', path, undefined, { timeoutMs: 5_000 })) } } catch (err) {
    if (ctx.signal?.aborted) throw err
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }
  }
}

/** The setup state of a project (checkpoints), compact. */
function setupView(value: Row): Row {
  const checkpoints = Array.isArray(value.checkpoints) ? value.checkpoints.map(record) : []
  const log = Array.isArray(value.logLines) ? value.logLines.filter((line): line is string => typeof line === 'string') : []
  return {
    installing: value.isInstalling === true,
    settingUp: value.isSettingUp === true,
    tier: value.tier ?? null,
    checkpoints: checkpoints.map((checkpoint) => ({ key: checkpoint.key ?? null, name: checkpoint.name ?? null, status: checkpoint.status ?? null })),
    done: checkpoints.filter((checkpoint) => checkpoint.status === 'done').length,
    total: checkpoints.length,
    ...(log.length ? { logTail: log.slice(-8) } : {}),
    ...(value.summary !== undefined && value.summary !== null ? { summary: value.summary } : {}),
  }
}

function setupState(ctx: V2CallContext, row: ProjectRow, setup: Row) {
  const ref = projectRef(row)
  const installing = setup.installing === true
  return ctx.v2.state({
    status: installing ? 'running' : setup.total && setup.done === setup.total ? 'succeeded' : 'waiting',
    offers: installing
      ? [{ id: 'abort_install', labelKey: 'projects.offer.abort_install', call: { tool: PROJECTS, args: { action: 'abort_install', project: ref } } }]
      : [
          { id: 'provision', labelKey: 'projects.offer.provision', call: { tool: PROJECTS, args: { action: 'provision', project: ref } } },
          { id: 'assemble', labelKey: 'projects.offer.assemble', call: { tool: PROJECTS, args: { action: 'provision', project: ref, options: { assemble: true } } } },
        ],
    versionFacts: { installing, done: setup.done, total: setup.total },
  })
}

function repositoryOf(ctx: V2CallContext, row: ProjectRow, args: Row): ProjectRepository {
  const wanted = str(args.repository) ?? str(args.repositoryId) ?? ''
  const repositories = getProjectRepositories(row)
  const id = wanted.includes('/') && wanted.startsWith('repository:') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted
  const repository = repositories.find((candidate) => candidate.id === id || candidate.name === id)
  if (!repository) throw new V2ToolError('not_found', `No repository "${wanted}" in ${row.slug}.`, { choices: repositories.map((candidate) => ({ ref: formatRef('repository', candidate.id, row.slug), name: candidate.name, path: candidate.path })) })
  return repository
}

function repositoryBody(args: Row): Row {
  const options = optionsOf(args)
  const body: Row = {}
  if (str(args.path)) body.path = str(args.path)
  if (str(args.name)) body.name = str(args.name)
  for (const key of ['integrationBranch', 'workspacePaths'] as const) {
    const value = options[key] !== undefined ? options[key] : args[key]
    if (value !== undefined) body[key] = value
  }
  return body
}

async function currentSample(ctx: V2CallContext): Promise<Row | null> {
  const sample = record(await apiCall(ctx, 'GET', '/onboarding/sample'))
  return sample.sample && typeof sample.sample === 'object' ? record(sample.sample) : null
}

export const projectsTool = defineTool({
  name: 'specrails_projects',
  title: 'Projects',
  description: 'Projects and setup: list, select the session default, add or clone, provision, repositories, sample project.',
  owner: 'WP2',
  fields: {
    ...WRITE_FIELDS,
    path: z.string().describe('add: local folder'),
    url: z.string().describe('clone: git URL'),
    name: z.string(),
    repository: z.string().describe('Repository id'),
  },
  actions: {
    list: {
      tier: 'read',
      doc: 'project (or options.query): fuzzy search by slug, name or path. Default limit 25.',
      handler: (ctx, args) => {
        const rows = ctx.v2.projects()
        const query = (str(args.project) ?? str(optionsOf(args).query) ?? '').toLowerCase()
        const matching = query ? rows.filter((row) => [row.slug, row.name, row.path, row.id].some((value) => value.toLowerCase().includes(query))) : rows
        const defaultId = ctx.sessionState.activeProjectId
        // Default first, then most recently seen.
        const ordered = [...matching].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || (a.last_seen_at < b.last_seen_at ? 1 : a.last_seen_at > b.last_seen_at ? -1 : a.slug.localeCompare(b.slug)))
        const page = pageOf(ordered, { cursor: args.cursor, limit: args.limit, key: `p:${query}`, defaultLimit: 25 })
        let loaded = new Set<string>()
        try { loaded = new Set((ctx.registry.listContexts?.() ?? []).map((context) => context.project.id)) } catch { /* unknown: every row reads as loaded:false */ }
        const items = page.items.map((row) => ctx.v2.view === 'detail' ? { ...projectView(ctx, row), loaded: loaded.has(row.id) } : projectLine(ctx, row, defaultId, loaded))
        const current = rows.find((row) => row.id === defaultId)
        const t = ctx.v2.t
        const queryText = query ? ` matching "${query}"` : ''
        return result({ items, total: matching.length }, {
          summary: matching.length ? t('projects.summary.list', { count: matching.length, query: queryText, default: current ? current.slug : t('projects.summary.none') }) : t('projects.summary.list_empty', { query: queryText }),
          page: page.page,
          ...(current ? { refs: { default: projectRef(current) } } : {}),
        })
      },
    },
    get: {
      tier: 'read',
      doc: 'project defaults to the session default. view detail adds settings, setup and integration branch.',
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const data: Row = projectView(ctx, row)
        const warnings: string[] = []
        let state
        if (ctx.v2.view === 'detail') {
          const [settings, setup] = await Promise.all([readOptional(ctx, `${base(row)}/settings`), readOptional(ctx, `${base(row)}/setup/checkpoints`)])
          if (settings.ok) data.settings = Object.fromEntries(SETTINGS_GLANCE.filter((key) => settings.value[key] !== undefined).map((key) => [key, settings.value[key]]))
          else warnings.push(`settings unavailable: ${settings.error}`)
          if (setup.ok) { data.setup = setupView(setup.value); state = setupState(ctx, row, data.setup as Row) } else warnings.push(`setup unavailable: ${setup.error}`)
        }
        const t = ctx.v2.t
        return result(data, {
          summary: t('projects.summary.get', { name: row.name, slug: row.slug, providers: row.providers.join(', '), repositories: getProjectRepositories(row).length, default: data.default ? t('projects.summary.is_default') : '' }),
          refs: { project: projectRef(row) },
          ...(state ? { state } : {}),
          ...(warnings.length ? { warnings } : {}),
          untrusted: untrusted('/data/setup/logTail', '/data/setup/summary'),
        })
      },
    },
    select: {
      tier: 'read',
      doc: 'Sets the session default project (and the session language with lang). options.clear removes the default.',
      handler: (ctx, args) => {
        const lang = normalizeLang(args.lang)
        if (lang) ctx.sessionState.lang = lang
        if (optionsOf(args).clear === true) {
          ctx.sessionState.activeProjectId = null
          return result({ default: null }, { summary: ctx.v2.t('projects.summary.cleared') })
        }
        const row = ctx.v2.project({ project: args.project ?? args.projectId })
        ctx.sessionState.activeProjectId = row.id
        return result({ ...projectView(ctx, row), default: true, ...(lang ? { lang } : {}) }, { summary: ctx.v2.t('projects.summary.selected', { name: row.name }), refs: { project: projectRef(row) } })
      },
    },
    add: {
      tier: 'write',
      required: ['path'],
      doc: 'name; options: providers[], workspacePaths[], repositories[{path,name?,workspacePaths?,integrationBranch?}], select (make it the session default).',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const body: Row = { path: str(args.path) }
        if (str(args.name)) body.name = str(args.name)
        const providers = strings(options.providers) ?? strings(args.providers)
        if (providers?.length) body.providers = providers
        else if (str(args.provider)) body.provider = str(args.provider)
        for (const key of ['workspacePaths', 'repositories'] as const) {
          const value = options[key] ?? args[key]
          if (value !== undefined) body[key] = value
        }
        const response = record(await apiCall(ctx, 'POST', '/projects', body))
        const project = record(response.project)
        const slug = String(project.slug ?? '')
        if (options.select === true && typeof project.id === 'string') ctx.sessionState.activeProjectId = project.id
        return result({ project: { ref: formatRef('project', slug), id: project.id, slug, name: project.name, path: project.path, providers: project.providers }, hasSpecrails: response.has_specrails === true }, {
          summary: ctx.v2.t('projects.summary.added', { name: String(project.name ?? slug), slug }),
          refs: { project: formatRef('project', slug) },
        })
      },
    },
    clone: {
      tier: 'write',
      required: ['url'],
      doc: 'path (or options.destination): new absolute folder; then registers it (options.register: false to skip), name and options of add apply.',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const destination = str(options.destination) ?? str(args.path)
        if (!destination) throw new V2ToolError('invalid_input', ctx.v2.t('projects.error.no_destination'))
        const cloned = record(await apiCall(ctx, 'POST', '/repositories/clone', { url: args.url, destination }, { timeoutMs: CLONE_TIMEOUT_MS }))
        const path = String(cloned.path ?? destination)
        if (options.register === false) return result({ path }, { summary: ctx.v2.t('projects.summary.cloned', { path }) })
        const body: Row = { path }
        if (str(args.name)) body.name = str(args.name)
        const providers = strings(options.providers)
        if (providers?.length) body.providers = providers
        const project = record(record(await apiCall(ctx, 'POST', '/projects', body)).project)
        const slug = String(project.slug ?? '')
        if (options.select === true && typeof project.id === 'string') ctx.sessionState.activeProjectId = project.id
        return result({ path, project: { ref: formatRef('project', slug), id: project.id, slug, name: project.name } }, {
          summary: ctx.v2.t('projects.summary.cloned_added', { path, slug }), refs: { project: formatRef('project', slug) },
        })
      },
    },
    provision: {
      tier: 'ai-spawn',
      confirm: 'costly',
      doc: 'Quick (offline) setup of every registered provider; options.providers narrows it, options.config writes install-config first (tier forced quick), options.assemble retries the background workspace assembly instead.',
      preview: (ctx, args) => {
        const row = projectOf(ctx, args)
        const providers = strings(optionsOf(args).providers) ?? row.providers
        // The quick tier is offline: no provider is spawned, so it costs nothing.
        return { effect: ctx.v2.t('projects.effect.provision', { providers: providers.join(', '), name: row.name }), refs: [projectRef(row)], version: `p${shortHash({ id: row.id, providers })}`, cost: { forecastUsd: [0, 0], runs: 1 } }
      },
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const options = optionsOf(args)
        if (options.assemble === true) {
          const response = record(await apiCall(ctx, 'POST', `${base(row)}/assemble-retry`, {}))
          return result({ project: projectRef(row), assembling: response.retrying ?? null, alreadyRunning: response.alreadyRunning === true }, { summary: ctx.v2.t('projects.summary.assembling', { name: row.name }), refs: { project: projectRef(row) } })
        }
        const providers = strings(options.providers)
        const config = record(options.config)
        if (Object.keys(config).length) {
          for (const provider of providers ?? row.providers) await apiCall(ctx, 'POST', `${base(row)}/setup/install-config`, { ...config, provider, tier: 'quick' })
        }
        await apiCall(ctx, 'POST', `${base(row)}/setup/install`, providers?.length ? { providers } : { all: true })
        return result({ project: projectRef(row), installing: true, providers: providers ?? row.providers }, {
          summary: ctx.v2.t('projects.summary.provisioning', { name: row.name, providers: (providers ?? row.providers).join(', ') }),
          refs: { project: projectRef(row) },
        })
      },
    },
    install_status: {
      tier: 'read',
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const setup = setupView(record(await apiCall(ctx, 'GET', `${base(row)}/setup/checkpoints`)))
        const state = setupState(ctx, row, setup)
        if (ctx.v2.view !== 'detail') delete setup.logTail
        return result(setup, {
          summary: setup.installing ? ctx.v2.t('projects.summary.install_running', { name: row.name }) : ctx.v2.t('projects.summary.install_idle', { name: row.name, done: Number(setup.done), total: Number(setup.total) }),
          state, refs: { project: projectRef(row) },
          untrusted: untrusted('/data/logTail', '/data/summary'),
        })
      },
    },
    abort_install: {
      tier: 'write',
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        await apiCall(ctx, 'POST', `${base(row)}/setup/abort`, {})
        return result({ project: projectRef(row), aborted: true }, { summary: ctx.v2.t('projects.summary.aborted', { name: row.name }), refs: { project: projectRef(row) } })
      },
    },
    repositories: {
      tier: 'read',
      handler: (ctx, args) => {
        const row = projectOf(ctx, args)
        const items = getProjectRepositories(row).map((repository) => repositoryView(row, repository))
        return result({ items, total: items.length }, { summary: ctx.v2.t('projects.summary.repositories', { name: row.name, count: items.length }), refs: { project: projectRef(row) } })
      },
    },
    repository_add: {
      tier: 'write',
      required: ['path'],
      doc: 'path, name; options: integrationBranch, workspacePaths[] (inside the repository; null resets).',
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const response = record(await apiCall(ctx, 'POST', `${base(row)}/repositories`, repositoryBody(args)))
        const repository = record(response.repository)
        const id = String(repository.id ?? '')
        return result({ repository: id ? formatRef('repository', id, row.slug) : null, ...response }, {
          summary: ctx.v2.t('projects.summary.repository_added', { repository: String(repository.name ?? args.path), name: row.name }),
          refs: { project: projectRef(row), ...(id ? { repository: formatRef('repository', id, row.slug) } : {}) },
        })
      },
    },
    repository_update: {
      tier: 'write',
      required: ['repository'],
      doc: 'path, name; options: integrationBranch (null clears), workspacePaths[].',
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const repository = repositoryOf(ctx, row, args)
        const body = repositoryBody(args)
        if (!Object.keys(body).length) throw new V2ToolError('invalid_input', ctx.v2.t('projects.error.repository_update_empty'))
        const response = record(await apiCall(ctx, 'PATCH', `${base(row)}/repositories/${encodeURIComponent(repository.id)}`, body))
        const ref = formatRef('repository', repository.id, row.slug)
        return result({ repository: ref, ...response }, { summary: ctx.v2.t('projects.summary.repository_updated', { repository: repository.name, name: row.name }), refs: { project: projectRef(row), repository: ref } })
      },
    },
    repository_remove: {
      tier: 'destructive',
      confirm: 'irreversible',
      required: ['repository'],
      preview: (ctx, args) => {
        const row = projectOf(ctx, args)
        const repository = repositoryOf(ctx, row, args)
        return { effect: ctx.v2.t('projects.effect.repository_remove', { repository: repository.name, path: repository.path, name: row.name }), refs: [formatRef('repository', repository.id, row.slug)], version: `r${shortHash(repository)}` }
      },
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        const repository = repositoryOf(ctx, row, args)
        await apiCall(ctx, 'DELETE', `${base(row)}/repositories/${encodeURIComponent(repository.id)}`)
        return result({ removed: formatRef('repository', repository.id, row.slug) }, { summary: ctx.v2.t('projects.summary.repository_removed', { repository: repository.name, name: row.name }), refs: { project: projectRef(row) } })
      },
    },
    unregister: {
      tier: 'destructive',
      confirm: 'irreversible',
      required: ['project'],
      preview: (ctx, args) => {
        const row = projectOf(ctx, args)
        return { effect: ctx.v2.t('projects.effect.unregister', { name: row.name, path: row.path }), refs: [projectRef(row)], version: `u${shortHash({ id: row.id, path: row.path, repositories: getProjectRepositories(row).map((repository) => repository.id) })}` }
      },
      handler: async (ctx, args) => {
        const row = projectOf(ctx, args)
        await apiCall(ctx, 'DELETE', `/projects/${encodeURIComponent(row.id)}`)
        if (ctx.sessionState.activeProjectId === row.id) ctx.sessionState.activeProjectId = null
        return result({ unregistered: projectRef(row), id: row.id }, { summary: ctx.v2.t('projects.summary.unregistered', { name: row.name }) })
      },
    },
    sample_create: {
      tier: 'write',
      doc: 'path (exact folder) or options.parentDir; options.sampleId; the spec language follows lang. Creates no AI work.',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const body: Row = { locale: ctx.v2.lang }
        if (str(args.path)) body.path = str(args.path)
        if (str(options.parentDir)) body.parentDir = str(options.parentDir)
        if (str(options.sampleId)) body.sampleId = str(options.sampleId)
        const response = record(await apiCall(ctx, 'POST', '/onboarding/sample', body))
        const project = record(response.project)
        const sample = record(response.sample)
        const row = ctx.v2.projects().find((candidate) => candidate.id === project.id)
        const slug = row?.slug ?? String(project.id ?? '')
        const specs = (Array.isArray(sample.specIds) ? sample.specIds : []).filter((id): id is number => typeof id === 'number').map((id) => formatRef('spec', id, slug))
        if (options.select === true && typeof project.id === 'string') ctx.sessionState.activeProjectId = project.id
        return result({ project: formatRef('project', slug), path: project.path, specs, reused: response.reused === true }, {
          summary: ctx.v2.t(response.reused === true ? 'projects.summary.sample_reused' : 'projects.summary.sample_created', { name: String(project.name ?? slug), count: specs.length }),
          refs: { project: formatRef('project', slug) },
        })
      },
    },
    sample_remove: {
      tier: 'destructive',
      confirm: 'irreversible',
      doc: 'options.deleteFolder also deletes the sample folder.',
      preview: async (ctx, args) => {
        const sample = await currentSample(ctx)
        if (!sample) throw new V2ToolError('not_found', ctx.v2.t('projects.error.no_sample'))
        const folder = optionsOf(args).deleteFolder === true ? ctx.v2.t('projects.effect.sample_remove_folder', { path: String(sample.path ?? '') }) : ''
        return { effect: ctx.v2.t('projects.effect.sample_remove', { folder }), version: `s${shortHash(sample)}` }
      },
      handler: async (ctx, args) => {
        const deleteFolder = optionsOf(args).deleteFolder === true
        const sample = await currentSample(ctx)
        if (!sample) throw new V2ToolError('not_found', ctx.v2.t('projects.error.no_sample'))
        const response = record(await apiCall(ctx, 'DELETE', `/onboarding/sample${deleteFolder ? '?deleteFolder=1' : ''}`))
        if (ctx.sessionState.activeProjectId === sample.projectId) ctx.sessionState.activeProjectId = null
        return result({ removed: true, ...response }, { summary: ctx.v2.t('projects.summary.sample_removed', { folder: deleteFolder ? ctx.v2.t('projects.summary.sample_folder') : '' }) })
      },
    },
    prerequisites: {
      tier: 'read',
      doc: 'Machine tools (node, npm, git, gh) and provider CLIs; options.diagnostic adds PATH details.',
      handler: async (ctx, args) => {
        const diagnostic = optionsOf(args).diagnostic === true
        const status = record(await apiCall(ctx, 'GET', `/setup-prerequisites${diagnostic ? '?diagnostic=1' : ''}`))
        const items = (Array.isArray(status.prerequisites) ? status.prerequisites : []).map(record).map((item) => ({
          key: item.key, kind: item.kind, label: item.label, required: item.required === true, installed: item.installed === true,
          ...(item.installed === true && item.executable === false ? { executable: false } : {}),
          ...(item.version ? { version: item.version } : {}), ...(item.minVersion ? { minVersion: item.minVersion } : {}),
          ...(item.meetsMinimum === false ? { meetsMinimum: false } : {}),
          ...(typeof item.authenticated === 'boolean' ? { authenticated: item.authenticated } : {}),
          ...(ctx.v2.view === 'detail' && item.executionError ? { error: item.executionError } : {}),
        }))
        const missing = items.filter((item) => item.required && (!item.installed || item.executable === false || item.meetsMinimum === false)).map((item) => String(item.label ?? item.key))
        const providers = items.filter((item) => item.kind === 'provider' && item.installed).map((item) => String(item.key))
        return result({ ok: status.ok === true, platform: status.platform ?? null, items, ...(diagnostic && status.diagnostic ? { diagnostic: status.diagnostic } : {}) }, {
          summary: missing.length ? ctx.v2.t('projects.summary.prerequisites_missing', { missing: missing.join(', ') }) : ctx.v2.t('projects.summary.prerequisites_ok', { providers: providers.join(', ') || '—' }),
          untrusted: untrusted('/data/items/*/error', '/data/diagnostic'),
        })
      },
    },
  },
})
