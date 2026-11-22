import { z } from 'zod'
import { apiRow } from '../core/loopback'
import type { ProjectRow } from '../../../desktop-db'
import { pageOf } from '../core/cursor'
import { shortHash } from '../core/canonical'
import { V2ToolError, result } from '../core/envelope'
import { defineTool, type V2CallContext } from '../core/registry'
import { formatRef, parseRef, type Ref, type Target } from '../core/refs'
import { F, WRITE_FIELDS } from '../core/views'
import { IMPLEMENT_LOOP, compatArgs, projectBase, railRunId, railsSnapshot } from './runs'

/**
 * WP3 `specrails_rails`: the rail slots of a project and their settings, over
 * `/rails` (rails-state/settings/preparation-http.ts) and the launch forecast.
 * Launching, stopping, pausing and resuming a rail are `specrails_runs` calls
 * that take a rail ref (`launch target:{rail}`, `stop|pause|resume ref:rail:…`).
 */

type Row = Record<string, unknown>
const rec = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

const label = (index: number) => `Rail ${index + 1}`

function railTarget(ctx: V2CallContext, args: Row): Target {
  const raw = typeof args.rail === 'number' ? String(args.rail) : args.rail
  const target = ctx.v2.target({ ...compatArgs(args), ref: raw }, 'rail')
  const index = Number(target.id)
  if (!Number.isSafeInteger(index) || index < 0) throw new V2ToolError('invalid_input', `rail must be a rail index or ref, not ${String(args.rail)}.`)
  return target
}
const indexOf = (target: Target) => Number(target.id)

const api = apiRow

function railItem(project: ProjectRow, snapshot: Row, rail: Row): Row {
  const index = Number(rail.railIndex)
  const runId = railRunId(snapshot, index)
  const loop = rec(rec(snapshot.activeLoopRuns)[String(index)])
  const delivery = rec(rec(snapshot.prDeliveries)[String(index)])
  return {
    ref: formatRef('rail', index, project.slug), index, label: str(rail.name) ? `${label(index)} ${rail.name}` : label(index),
    availability: rail.availability ?? null,
    specs: arr(rail.ticketIds).map((id) => formatRef('spec', Number(id), project.slug)),
    mode: rail.mode ?? null, engine: rail.aiEngine ?? null, profile: rail.profileName ?? null,
    ...(runId ? { run: formatRef('run', runId, project.slug), ...(loop.hold ? { hold: rec(loop.hold).kind } : {}), ...(str(loop.provider) ? { provider: loop.provider } : {}) } : {}),
    ...(str(delivery.id) ? { delivery: formatRef('delivery', String(delivery.id), project.slug), decision: delivery.decision ?? null } : {}),
  }
}

async function listRails(ctx: V2CallContext, project: ProjectRow): Promise<{ snapshot: Row; items: Row[] }> {
  const snapshot = await railsSnapshot(ctx, project)
  return { snapshot, items: arr(snapshot.rails).map(rec).map((rail) => railItem(project, snapshot, rail)) }
}

const RAIL_SETTINGS = new Set(['specIds', 'mode', 'engine', 'profile', 'name'])
const LAUNCH_OPTIONS = new Set(['model', 'effort', 'targetPr', 'workspace', 'workspaceSelection', 'repositoryIds', 'runtimeProviderOverride', 'loopId', 'baseBranch'])

async function configure(ctx: V2CallContext, project: ProjectRow, index: number, config: Row): Promise<string[]> {
  const keys = Object.keys(config)
  const launchOnly = keys.filter((key) => LAUNCH_OPTIONS.has(key))
  if (launchOnly.length) throw new V2ToolError('invalid_input', ctx.v2.t('rails.error.launch_option', { keys: launchOnly.join(', ') }))
  if (!keys.length || keys.some((key) => !RAIL_SETTINGS.has(key))) throw new V2ToolError('invalid_input', ctx.v2.t('rails.error.config'))
  const base = `${projectBase(project)}/rails/${index}`
  const changed: string[] = []
  if (config.specIds !== undefined || config.mode !== undefined) {
    const current = config.specIds === undefined ? arr(rec(arr((await railsSnapshot(ctx, project)).rails).map(rec).find((rail) => rail.railIndex === index)).ticketIds) : null
    const ids = (current ?? arr(config.specIds)).map((value) => Number(parseRef(value)?.id ?? value))
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new V2ToolError('invalid_input', 'config.specIds must be spec ids or refs.')
    await api(ctx, 'PUT', `${base}/tickets`, { ticketIds: ids, ...(config.mode !== undefined ? { mode: config.mode } : {}) })
    changed.push(...(config.specIds !== undefined ? ['specs'] : []), ...(config.mode !== undefined ? ['mode'] : []))
  }
  if (config.engine !== undefined) { await api(ctx, 'PUT', `${base}/engine`, { aiEngine: config.engine ?? null }); changed.push('engine') }
  if (config.profile !== undefined) { await api(ctx, 'PUT', `${base}/profile`, { profileName: config.profile ?? null }); changed.push('profile') }
  if (config.name !== undefined) { await api(ctx, 'PUT', `${base}/name`, { name: config.name ?? null }); changed.push('name') }
  return changed
}

async function railRow(ctx: V2CallContext, project: ProjectRow, index: number): Promise<Row> {
  const { items } = await listRails(ctx, project)
  const item = items.find((rail) => rail.index === index)
  if (!item) throw new V2ToolError('not_found', `${label(index)} does not exist.`)
  return item
}

/** WP3 (with runs). Rail configuration; launching is specrails_runs(launch). */
export const railsTool = defineTool({
  name: 'specrails_rails',
  title: 'Rails',
  description: 'Rails of a project: list, create, rename, configure (specs, mode, loop, engine, profile, model, target PR), worktrees, overlaps, forecast. Launching specs needs no setup here: specrails_runs(launch) assigns them (options.parallel: one rail each).',
  owner: 'WP3',
  fields: {
    ...WRITE_FIELDS,
    rail: z.union([z.number().int().min(0).max(999), z.string()]).describe('Index or rail ref'),
    name: z.string(),
    config: F.object().describe('specIds mode engine profile name'),
  },
  actions: {
    list: {
      tier: 'read',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const { snapshot, items } = await listRails(ctx, project)
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: 'rails', defaultLimit: 25 })
        const count = (availability: string) => items.filter((item) => item.availability === availability).length
        const wip = rec(snapshot.reviewWip)
        return result({ items: page.items, ...(Object.keys(wip).length ? { reviewWip: { limit: wip.limit ?? null, pending: arr(wip.pending).length, reached: wip.reached === true } } : {}) }, {
          summary: ctx.v2.t('rails.summary.list', { count: items.length, free: count('free'), busy: count('busy'), waiting: count('pending_decision') }),
          page: page.page, pageBase: page.base,
        })
      },
    },
    create: {
      tier: 'write', doc: 'name; config (specIds, mode, engine, profile) applied to the new rail',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const created = rec((await api(ctx, 'POST', `${projectBase(project)}/rails`, str(args.name) ? { name: args.name } : {})).rail)
        const index = Number(created.railIndex)
        const config = rec(args.config)
        if (Object.keys(config).length) await configure(ctx, project, index, config)
        const item = await railRow(ctx, project, index)
        return result(item, { summary: ctx.v2.t('rails.summary.created', { label: String(item.label) }), refs: { rail: String(item.ref) } })
      },
    },
    remove: {
      tier: 'destructive', confirm: 'irreversible', required: ['rail'],
      preview: async (ctx, args) => {
        const target = railTarget(ctx, args)
        const item = await railRow(ctx, target.project!, indexOf(target))
        return { effect: ctx.v2.t('rails.preview.remove', { label: String(item.label) }), refs: [target.ref], version: `r${shortHash(item)}` }
      },
      handler: async (ctx, args) => {
        const target = railTarget(ctx, args)
        await api(ctx, 'DELETE', `${projectBase(target.project!)}/rails/${indexOf(target)}`)
        return result({ ref: target.ref, removed: true }, { summary: ctx.v2.t('rails.summary.removed', { label: label(indexOf(target)) }) })
      },
    },
    rename: {
      tier: 'write', required: ['rail', 'name'], doc: 'configure config.name null restores "Rail N"',
      handler: async (ctx, args) => {
        const target = railTarget(ctx, args)
        await api(ctx, 'PUT', `${projectBase(target.project!)}/rails/${indexOf(target)}/name`, { name: str(args.name) })
        const item = await railRow(ctx, target.project!, indexOf(target))
        return result(item, { summary: ctx.v2.t('rails.summary.renamed', { label: String(item.label) }), refs: { rail: target.ref } })
      },
    },
    configure: {
      tier: 'write', required: ['rail', 'config'], doc: 'config: specIds (replaces), mode implement|loop, engine (provider, "roles" or null), profile (or null), name; model/effort/targetPr are launch options',
      handler: async (ctx, args) => {
        const target = railTarget(ctx, args)
        const changed = await configure(ctx, target.project!, indexOf(target), rec(args.config))
        const item = await railRow(ctx, target.project!, indexOf(target))
        return result(item, { summary: ctx.v2.t('rails.summary.configured', { label: String(item.label), changed: changed.join(', ') }), refs: { rail: target.ref } })
      },
    },
    prepare_worktrees: {
      tier: 'write', doc: 'options.count (default 1): pre-create checkouts so the next launches start faster',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const count = num(rec(args.options).count) ?? 1
        const response = await api(ctx, 'POST', `${projectBase(project)}/rails/worktree-preparation`, { count })
        return result(response, { summary: ctx.v2.t('rails.summary.prepared', { count: Number(response.preparing ?? 0) }) })
      },
    },
    release_worktrees: {
      // Prepared checkouts hold no work (unused, pristine): releasing them loses nothing.
      tier: 'write', doc: 'release the prepared (unused) checkouts',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const response = await api(ctx, 'POST', `${projectBase(project)}/rails/worktree-preparation/release`)
        return result(response, { summary: ctx.v2.t('rails.summary.released', { count: Number(response.released ?? 0) }) })
      },
    },
    overlaps: {
      tier: 'read', doc: 'rail: the other rails likely to touch the same files (every rail with specs when omitted)',
      handler: async (ctx, args) => {
        const project = args.rail !== undefined ? railTarget(ctx, args).project! : ctx.v2.project(compatArgs(args))
        const indexes = args.rail !== undefined ? [indexOf(railTarget(ctx, args))]
          : arr((await railsSnapshot(ctx, project)).rails).map(rec).filter((rail) => arr(rail.ticketIds).length).map((rail) => Number(rail.railIndex))
        const items = await Promise.all(indexes.map(async (index) => ({
          rail: formatRef('rail', index, project.slug),
          overlaps: arr((await api(ctx, 'GET', `${projectBase(project)}/rails/${index}/launch-overlaps`)).overlaps).slice(0, 10),
        })))
        const total = items.reduce((sum, item) => sum + item.overlaps.length, 0)
        return result({ items }, { summary: ctx.v2.t('rails.summary.overlaps', { count: total }) })
      },
    },
    forecast: {
      tier: 'read', required: ['rail'], doc: 'time and cost of runs like this rail\'s next launch (measured history only)',
      handler: async (ctx, args) => {
        const target = railTarget(ctx, args)
        const project = target.project!
        const item = await railRow(ctx, project, indexOf(target))
        const query = new URLSearchParams({ loopId: IMPLEMENT_LOOP, ...(str(item.engine) && item.engine !== 'roles' ? { provider: String(item.engine) } : {}) })
        const forecast = await api(ctx, 'GET', `${projectBase(project)}/launch-forecast?${query}`)
        const time = rec(forecast.time)
        const cost = rec(forecast.cost)
        const costText = num(cost.lowUsd) !== null ? ctx.v2.t('rails.summary.forecast_cost', { low: Number(cost.lowUsd).toFixed(2), high: Number(cost.highUsd).toFixed(2) }) : ctx.v2.t('rails.summary.forecast_cost_none')
        const text = num(time.p25Ms) !== null ? ctx.v2.t('rails.summary.forecast_range', { low: Math.round(Number(time.p25Ms) / 60_000), high: Math.round(Number(time.p75Ms) / 60_000), cost: costText }) : ctx.v2.t('rails.summary.forecast_none')
        const refs: Record<string, Ref> = { rail: target.ref }
        return result({ rail: target.ref, specs: item.specs, engine: item.engine, time: forecast.time ?? null, cost: forecast.cost ?? null, minSamples: forecast.minSamples ?? null, budget: forecast.budget ?? null },
          { summary: ctx.v2.t('rails.summary.forecast', { label: String(item.label), forecast: text }), refs })
      },
    },
  },
})
