import fs from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import { defineTool, fieldValue, type PreviewInput, type V2CallContext, type V2ToolDef } from '../core/registry'
import { asRecord, present } from '../core/text'
import type { McpTier } from '../../mcp-tiers'
import type { ConfirmClass } from '../core/decision-state'
import { WRITE_FIELDS, optionsOf } from '../core/views'
import { V2ToolError, relay, result } from '../core/envelope'
import { decodeCursor, encodeCursor, pageOf } from '../core/cursor'
import { formatRef } from '../core/refs'
import { neutralize, untrusted } from '../core/untrusted'
import { shortHash } from '../core/canonical'
import { apiCall } from '../../tools/types'
import { supportTools } from '../../tools/support'
import { GUIDE_TOPICS, findGuideTopic } from '../../guide'
import { buildZip } from '../../../util/zip'
import { getTerminalManager } from '../../../modules/terminals/runtime/terminal-manager'
import type { ProjectRow } from '../../../desktop-db'

/**
 * WP11. `specrails_system`: health and diagnostics (crash notices, stall probe,
 * the problem-report ZIP), help over the v2 catalog and the guide, Desktop and
 * Core updates, restart continuity, worktree storage, machine installs,
 * background processes, terminals, the built-in browser and the docs portal.
 * Thin over the existing routes (`modules/diagnostics`, `modules/continuity`,
 * `retained-worktrees-http.ts`, `desktop-router-core-update.ts`,
 * `desktop-router-updates.ts`, `project-router-terminals.ts`, `docs-router.ts`…).
 * Most actions take a sub-operation in `op`; every op not listed in `MUTATING`
 * reads.
 */

type Row = Record<string, unknown>
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const enc = encodeURIComponent

const op = (args: Record<string, unknown>) => typeof args.op === 'string' ? args.op : 'list'
/** Sub-operations that change something, per action (`op`); every other op reads. */
const MUTATING: Record<string, Record<string, { tier: McpTier; confirm: ConfirmClass | null }>> = {
  updates: { apply: { tier: 'destructive', confirm: 'irreversible' }, check: { tier: 'write', confirm: null } },
  worktrees: { remove: { tier: 'destructive', confirm: 'irreversible' }, quarantine_remove: { tier: 'destructive', confirm: 'irreversible' } },
  background: { kill: { tier: 'destructive', confirm: 'irreversible' } },
  continuity: { settle: { tier: 'write', confirm: null }, resume: { tier: 'ai-spawn', confirm: 'costly' } },
  terminals: { run: { tier: 'destructive', confirm: 'irreversible' }, kill: { tier: 'destructive', confirm: 'irreversible' } },
  machine_installs: { revoke: { tier: 'write', confirm: null } },
  browser: { capture: { tier: 'write', confirm: null } },
}
/** Every op an action accepts (the first one is its default). */
const OPS: Record<string, readonly string[]> = {
  updates: ['status', 'check', 'apply'],
  continuity: ['list', 'resume', 'settle'],
  worktrees: ['list', 'sizes', 'remove', 'quarantine_inspect', 'quarantine_remove'],
  machine_installs: ['list', 'revoke'],
  background: ['list', 'logs', 'kill'],
  terminals: ['list', 'read', 'run', 'kill'],
  browser: ['list', 'capture'],
}
const byOp = (action: string) => ({
  tier: (args: Record<string, unknown>) => MUTATING[action]?.[op(args)]?.tier ?? 'read',
  confirm: (args: Record<string, unknown>) => MUTATING[action]?.[op(args)]?.confirm ?? null,
})
/** The call's op (the action's default when omitted); an unknown op fails with the list. */
function opFor(ctx: V2CallContext, action: string, args: Row): string {
  const ops = OPS[action] ?? ['list']
  const value = typeof args.op === 'string' ? args.op : ops[0]
  if (value === 'list' && !ops.includes('list')) return ops[0]
  if (!ops.includes(value)) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.unknown_op', { action, op: value, ops: ops.join(', ') }))
  return value
}

const projectBase = (ctx: V2CallContext, args: Row): { row: ProjectRow; base: string } => {
  const row = ctx.v2.project(args)
  return { row, base: `/projects/${enc(row.id)}` }
}

/** A read that never fails the composite answer: `{ ok, data | error }`. */
async function probe<T = unknown>(run: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try { return { ok: true, data: await run() } } catch (err) { return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) } }
}

// ── Text paging (help topics, docs pages, terminal output) ─────────────────

const PAGE_CHARS = 12_000
function pageText(text: string, cursor: unknown, key: string, size = PAGE_CHARS): { text: string; page?: { cursor: string | null; total: number; truncated: boolean } } {
  const state = decodeCursor(cursor, key)
  const offset = state?.offset ?? 0
  if (offset === 0 && text.length <= size) return { text }
  let end = Math.min(text.length, offset + size)
  // Cut at a line break when one is near, so a page never splits a word.
  const nl = text.lastIndexOf('\n', end)
  if (end < text.length && nl > offset + size / 2) end = nl + 1
  const more = end < text.length
  return { text: text.slice(offset, end), page: { cursor: more ? encodeCursor({ offset: end, path: '/data/text', key }) : null, total: text.length, truncated: more } }
}

// ── Help over the v2 catalog ────────────────────────────────────────────────

/** The v2 tools of the catalog this call runs in (no import of `./index`, which imports this file). */
const catalogTools = (ctx: V2CallContext): readonly V2ToolDef[] => ctx.v2.catalog.tools

function findAction(ctx: V2CallContext, target: string): { tool: V2ToolDef; action: string } | null {
  const match = target.trim().match(/^(specrails_[a-z]+)?[.(\s:]*([a-z][a-z0-9_]*)?\)?$/)
  if (!match) return null
  const tool = catalogTools(ctx).find((def) => def.name === match[1])
  if (!tool) return null
  const action = match[2] ?? ''
  return { tool, action }
}

function fieldDocs(tool: V2ToolDef): Array<{ name: string; description: string | null }> {
  return Object.entries(tool.fields as Record<string, z.ZodTypeAny>).map(([name, field]) => ({ name, description: field.description ?? null }))
}

function describeAction(ctx: V2CallContext, target: string, sample: Row = {}): Row {
  const found = findAction(ctx, target)
  const tools = catalogTools(ctx)
  if (!found) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.unknown_tool', { target, tools: tools.map((tool) => tool.name).join(', ') }))
  const { tool, action } = found
  if (!action) {
    return { tool: tool.name, description: tool.description, actions: Object.entries(tool.actions).map(([name, spec]) => ({ action: name, doc: spec.doc ?? null, implemented: Boolean(spec.handler) })), fields: fieldDocs(tool) }
  }
  const spec = tool.actions[action]
  if (!spec) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.unknown_tool', { target, tools: Object.keys(tool.actions).join(', ') }))
  const args = { ...sample, action }
  const tier = typeof spec.tier === 'function' ? spec.tier(args) : spec.tier
  const confirm = typeof spec.confirm === 'function' ? spec.confirm(args) : spec.confirm ?? null
  return {
    tool: tool.name, action, tier, confirm, implemented: Boolean(spec.handler),
    required: spec.required ?? [], oneOf: spec.oneOf ?? [], doc: spec.doc ?? null,
    ...(tool.name === 'specrails_system' && OPS[action] ? { ops: OPS[action] } : {}),
    fields: fieldDocs(tool),
  }
}

function validateCall(ctx: V2CallContext, input: Row): Row {
  const target = `${String(input.tool ?? '')}.${String(input.action ?? asRecord(input.args).action ?? '')}`
  const found = findAction(ctx, target)
  if (!found?.action || !found.tool.actions[found.action]) return { valid: false, problems: [ctx.v2.t('system.error.unknown_tool', { target, tools: catalogTools(ctx).map((tool) => tool.name).join(', ') })] }
  const { tool, action } = found
  const spec = tool.actions[action]
  const args = { ...asRecord(input.args), action }
  const missing = (spec.required ?? []).filter((field) => !present(fieldValue(args, field)))
  const needsOne = spec.oneOf?.length && !spec.oneOf.some((field) => present(fieldValue(args, field))) ? spec.oneOf : []
  const unknown = Object.keys(args).filter((name) => name !== 'action' && !(name in tool.fields))
  const tier = typeof spec.tier === 'function' ? spec.tier(args) : spec.tier
  const confirm = typeof spec.confirm === 'function' ? spec.confirm(args) : spec.confirm ?? null
  const problems = [
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(needsOne.length ? [`needs one of ${needsOne.join(', ')}`] : []),
    ...(unknown.length ? [`unknown fields ${unknown.join(', ')} (rare fields go in options)`] : []),
    ...(spec.handler ? [] : ['not implemented yet']),
  ]
  return { tool: tool.name, action, valid: problems.length === 0, problems, tier, confirm, ...(confirm ? { note: 'Confirmable: the first call returns a preview and confirmToken.' } : {}) }
}

function searchHelp(ctx: V2CallContext, query: string): Array<Row> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const score = (text: string) => words.filter((word) => text.toLowerCase().includes(word)).length
  const hits: Array<Row & { score: number }> = []
  for (const tool of catalogTools(ctx)) {
    for (const [action, spec] of Object.entries(tool.actions)) {
      const s = score(`${tool.name} ${action} ${spec.doc ?? ''}`)
      if (s) hits.push({ kind: 'action', describe: `${tool.name}.${action}`, doc: spec.doc ?? null, score: s })
    }
  }
  for (const topic of GUIDE_TOPICS) {
    const s = score(`${topic.id} ${topic.title} ${topic.when}`)
    if (s) hits.push({ kind: 'topic', topic: topic.id, title: topic.title, when: topic.when, score: s + 0.5 })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20).map(({ score: _score, ...rest }) => rest)
}

// ── Updates ─────────────────────────────────────────────────────────────────

interface UpdateFacts { core: Row; desktop: Row }
async function updateFacts(ctx: V2CallContext): Promise<UpdateFacts> {
  const [core, desktop] = await Promise.all([
    probe(() => apiCall(ctx, 'GET', '/core-update/status')),
    probe(() => apiCall(ctx, 'GET', '/desktop-updates/status')),
  ])
  return { core: core.ok ? asRecord(core.data) : { error: core.error }, desktop: desktop.ok ? asRecord(desktop.data) : { error: desktop.error } }
}

function updateWord(ctx: V2CallContext, current: unknown, latest: unknown, available: boolean, checked: boolean): string {
  if (available) return ctx.v2.t('system.summary.update_available', { current: String(current ?? '?'), version: String(latest) })
  return ctx.v2.t(checked ? 'system.summary.update_current' : 'system.summary.update_unknown', { version: String(current ?? '?') })
}

function updatesView(ctx: V2CallContext, facts: UpdateFacts) {
  const { core, desktop } = facts
  const latestDesktop = asRecord(desktop.latest)
  const data = {
    desktop: { current: desktop.currentVersion ?? null, latest: latestDesktop.version ?? null, available: desktop.available === true, channel: desktop.channel ?? null, checkedAt: desktop.checkedAt ?? null, checkError: desktop.checkError ?? desktop.error ?? null, window: desktop.window ?? null, ...(ctx.v2.view === 'detail' ? { notes: latestDesktop.notes ?? null } : {}) },
    core: { current: core.currentVersion ?? null, latest: core.latestVersion ?? null, available: core.updateAvailable === true, updating: core.updating === true, bundled: core.bundledVersion ?? null, checkedAt: typeof core.lastCheckedAt === 'number' ? new Date(core.lastCheckedAt).toISOString() : null, error: core.error ?? core.lastError ?? null },
  }
  return result(data, {
    summary: ctx.v2.t('system.summary.updates', {
      desktop: updateWord(ctx, data.desktop.current, data.desktop.latest, data.desktop.available, Boolean(data.desktop.checkedAt)),
      core: updateWord(ctx, data.core.current, data.core.latest, data.core.available, Boolean(data.core.checkedAt)),
    }),
    untrusted: untrusted('/data/desktop/notes'),
  })
}

const updateTarget = (ctx: V2CallContext, args: Row): 'core' | 'desktop' => {
  const target = str(optionsOf(args).target)
  if (target !== 'core' && target !== 'desktop') throw new V2ToolError('invalid_input', ctx.v2.t('system.error.update_target'))
  return target
}
const restartOf = (args: Row): string => { const value = str(optionsOf(args).restart); return value === 'now' || value === 'never' ? value : 'when_idle' }

// ── Worktrees ───────────────────────────────────────────────────────────────

interface WorktreeChoice { projectId: string; id: string; deleteBranch: boolean }
/** `id` (with project) or `options.items: [{ project?, id, deleteBranch? }]`. */
function worktreeChoices(ctx: V2CallContext, args: Row): WorktreeChoice[] {
  const items = asArray(optionsOf(args).items)
  const raw = items.length ? items.map(asRecord) : args.id !== undefined ? [{ id: args.id, deleteBranch: optionsOf(args).deleteBranch }] : []
  if (!raw.length) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.nothing_selected'))
  return raw.map((item) => {
    const projectId = ctx.v2.project({ project: item.project ?? args.project }).id
    return { projectId, id: String(item.id ?? ''), deleteBranch: item.deleteBranch === true }
  })
}

async function retained(ctx: V2CallContext): Promise<Row[]> {
  return asArray(asRecord(await apiCall(ctx, 'GET', '/worktrees/retained')).items).map(asRecord)
}

function worktreeItem(ctx: V2CallContext, item: Row): Row {
  const project = ctx.v2.projects().find((row) => row.id === item.projectId)
  return {
    id: item.id, project: project ? formatRef('project', project.slug) : item.projectId, kind: item.kind, branch: item.branch, path: item.worktreePath,
    ...(item.runId && project ? { run: formatRef('run', String(item.runId), project.slug) } : {}),
    ...(item.ticketId && project ? { spec: formatRef('spec', Number(item.ticketId), project.slug) } : {}),
    state: item.state, idleDays: item.idleDays, head: item.head, trackedChanges: item.trackedChanges, untrackedFiles: item.untrackedFiles, unpushedCommits: item.unpushedCommits,
    pr: item.pr ?? null, evaluation: item.evaluation ?? null,
  }
}

async function worktreesRemovePreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const choices = worktreeChoices(ctx, args)
  const items = await retained(ctx)
  const matched = choices.map((choice) => ({ choice, item: items.find((item) => item.projectId === choice.projectId && item.id === choice.id) }))
  const missing = matched.filter((entry) => !entry.item).map((entry) => entry.choice.id)
  if (missing.length) throw new V2ToolError('not_found', `No retained worktree ${missing.join(', ')}. List them with op: list.`)
  const anyBranch = choices.some((choice) => choice.deleteBranch)
  return {
    effect: ctx.v2.t('system.confirm.worktrees_remove', { count: choices.length, names: matched.map((entry) => String(entry.item!.branch ?? entry.item!.id)).slice(0, 5).join(', '), branches: anyBranch ? ctx.v2.t('system.confirm.worktrees_branches') : '' }),
    version: shortHash(matched.map((entry) => ({ id: entry.choice.id, head: entry.item!.head, changes: entry.item!.trackedChanges, untracked: entry.item!.untrackedFiles, unpushed: entry.item!.unpushedCommits }))),
  }
}

interface QuarantineChoice { projectId: string; path: string }
function quarantineChoices(ctx: V2CallContext, args: Row): QuarantineChoice[] {
  const items = asArray(optionsOf(args).items).map(asRecord)
  const raw = items.length ? items : str(optionsOf(args).path) ? [{ path: optionsOf(args).path }] : []
  if (!raw.length) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.nothing_selected'))
  return raw.map((item) => ({ projectId: ctx.v2.project({ project: item.project ?? args.project }).id, path: String(item.path ?? '') }))
}

// ── Background processes ────────────────────────────────────────────────────

async function processRow(ctx: V2CallContext, base: string, pid: number): Promise<Row> {
  const list = asArray(asRecord(await apiCall(ctx, 'GET', `${base}/background-processes?includeFinished=true`)).processes).map(asRecord)
  const found = list.find((row) => Number(row.pid) === pid)
  if (!found) throw new V2ToolError('not_found', ctx.v2.t('system.error.process_not_found', { pid }))
  return found
}
const pidOf = (args: Row): number => {
  const pid = num(optionsOf(args).pid) ?? Number(args.id)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new V2ToolError('invalid_input', 'Pass the process pid as id (or options.pid).')
  return pid
}

// ── Terminals ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g
/** Terminal bytes → readable text: escape sequences, bare carriage returns and controls removed. */
export function terminalText(buffer: Buffer): string {
  return neutralize(buffer.toString('utf8').replace(ANSI, '')).replace(/\r\n/g, '\n')
}

function terminalSession(ctx: V2CallContext, row: ProjectRow, id: string) {
  const session = getTerminalManager().get(row.id, id)
  if (!session) throw new V2ToolError('not_found', ctx.v2.t('system.error.terminal_not_found', { id }))
  return session
}
const terminalsEnabled = () => process.env.SPECRAILS_TERMINAL_PANEL !== 'false'
const commandOf = (args: Row): string => {
  const command = str(optionsOf(args).command) ?? str(args.query)
  if (!command) throw new V2ToolError('invalid_input', 'Pass the command in options.command.')
  if (command.length > 4000 || /[\r\n]/.test(command)) throw new V2ToolError('invalid_input', 'options.command must be one line of at most 4000 characters.')
  return command
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** Where report ZIPs go: options.dir when absolute, else the OS temp dir. */
function reportDir(args: Row): string {
  const dir = str(optionsOf(args).dir)
  return dir && path.isAbsolute(dir) ? dir : path.join(os.tmpdir(), 'specrails-reports')
}

// ── Issues for health ───────────────────────────────────────────────────────

function healthIssues(ctx: V2CallContext, facts: Record<string, { ok: boolean; data?: unknown; error?: string }>): string[] {
  const issues: string[] = []
  const t = ctx.v2.t
  for (const [name, value] of Object.entries(facts)) if (!value.ok) issues.push(t('system.issue.probe_failed', { probe: name }))
  const crashes = asArray(asRecord(facts.crashes?.data).notices).length
  if (crashes) issues.push(t('system.issue.crashes', { count: crashes }))
  const stalls = asRecord(facts.stalls?.data)
  if (Number(stalls.total) > 0 && Number(stalls.longestMs) >= 2000) issues.push(t('system.issue.stalls', { count: Number(stalls.total), ms: Math.round(Number(stalls.longestMs)) }))
  const core = asRecord(facts.core?.data)
  if (core.updateAvailable === true) issues.push(t('system.issue.core_update', { version: String(core.latestVersion) }))
  const desktop = asRecord(facts.desktop?.data)
  if (desktop.available === true) issues.push(t('system.issue.desktop_update', { version: String(asRecord(desktop.latest).version) }))
  const continuity = asRecord(facts.continuity?.data)
  const offers = asArray(continuity.offers).length
  if (offers) issues.push(t('system.issue.resume_offers', { count: offers }))
  const runs = asArray(continuity.runs).length
  if (runs) issues.push(t('system.issue.interrupted_runs', { count: runs }))
  return issues
}

/** WP11. Health, help, diagnostics, updates, continuity, housekeeping, background processes, terminals, browser and docs. */
export const systemTool = defineTool({
  name: 'specrails_system',
  title: 'System',
  description: 'health, help (topics, describe an action, validate args), triage, problem report, crashes, stalls, updates, continuity, worktrees, background, terminals, browser, docs.',
  owner: 'WP11',
  fields: {
    ...WRITE_FIELDS,
    op: z.string().describe('Sub-operation, e.g. updates: status|check|apply'),
    topic: z.string().describe('help/docs topic'),
    query: z.string(),
    id: z.string(),
  },
  actions: {
    health: {
      tier: 'read',
      doc: 'One-call health: versions, unexplained restarts, event-loop stalls, pending updates, interrupted work and running work. view:detail adds every probe.',
      handler: async (ctx) => {
        const [meta, crashes, stalls, core, desktop, continuity, active] = await Promise.all([
          probe(() => apiCall(ctx, 'GET', '/meta')), probe(() => apiCall(ctx, 'GET', '/diagnostics/crashes')), probe(() => apiCall(ctx, 'GET', '/diagnostics/stalls')),
          probe(() => apiCall(ctx, 'GET', '/core-update/status')), probe(() => apiCall(ctx, 'GET', '/desktop-updates/status')),
          probe(() => apiCall(ctx, 'GET', '/continuity/resume-offers')), probe(() => apiCall(ctx, 'GET', '/continuity/active-work')),
        ])
        const facts = { meta, crashes, stalls, core, desktop, continuity, active }
        const issues = healthIssues(ctx, facts)
        const m = asRecord(meta.ok ? meta.data : {})
        const version = String(m.appVersion ?? '?')
        const data: Row = {
          healthy: issues.length === 0, issues,
          versions: { app: m.appVersion ?? null, core: m.coreVersion ?? null, api: m.apiVersion ?? null, channel: m.channel ?? null },
          activeWork: active.ok ? active.data : null,
        }
        if (ctx.v2.view === 'detail') data.probes = facts
        const next = issues.length ? [
          ...(asArray(asRecord(crashes.ok ? crashes.data : {}).notices).length ? [{ tool: 'specrails_system', args: { action: 'crashes' }, why: 'What restarted.' }] : []),
          ...(asArray(asRecord(continuity.ok ? continuity.data : {}).offers).length ? [{ tool: 'specrails_system', args: { action: 'continuity' }, why: 'Interrupted turns to resume.' }] : []),
          ...(asRecord(core.ok ? core.data : {}).updateAvailable === true || asRecord(desktop.ok ? desktop.data : {}).available === true ? [{ tool: 'specrails_system', args: { action: 'updates' }, why: 'Updates waiting.' }] : []),
        ] : []
        if (next.length) data.next = next
        return result(data, { summary: issues.length ? ctx.v2.t('system.summary.health_issues', { version, count: issues.length, issues: issues.join('; ') }) : ctx.v2.t('system.summary.health_ok', { version }) })
      },
    },
    help: {
      tier: 'read', maxTokens: 6000,
      doc: 'No args: the tool index and guide topics. topic: a guide topic (paged). query: search actions and topics. options.describe: "specrails_runs.get" (or a tool) → tier, confirmation, required fields and options doc. options.validate: { tool, action, args } → what is missing before you call.',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        if (str(options.describe)) {
          const described = describeAction(ctx, String(options.describe), asRecord(options.args))
          const label = described.action ? `${String(described.tool)}(${String(described.action)})` : String(described.tool)
          return result(described, { summary: ctx.v2.t('system.summary.help_describe', { label, tier: String(described.tier ?? `${asArray(described.actions).length} actions`), confirm: described.confirm ? `, ${String(described.confirm)}` : '' }) })
        }
        if (options.validate && typeof options.validate === 'object') {
          const checked = validateCall(ctx, asRecord(options.validate))
          const label = `${String(checked.tool ?? '?')}(${String(checked.action ?? '?')})`
          return result(checked, { summary: checked.valid ? ctx.v2.t('system.summary.help_validate_ok', { label }) : ctx.v2.t('system.summary.help_validate_bad', { label, problems: asArray(checked.problems).join('; ') }) })
        }
        if (str(args.topic)) {
          const topic = findGuideTopic(String(args.topic))
          if (!topic) throw new V2ToolError('not_found', `No guide topic "${String(args.topic)}". Topics: ${GUIDE_TOPICS.map((entry) => entry.id).join(', ')}.`)
          const paged = pageText(topic.body(), args.cursor, `topic:${topic.id}`)
          return result({ topic: topic.id, title: topic.title, text: paged.text }, { summary: ctx.v2.t('system.summary.help_topic', { topic: topic.id, more: paged.page?.truncated ? ' (more: cursor)' : '' }), ...(paged.page ? { page: paged.page } : {}) })
        }
        if (str(args.query)) {
          const hits = searchHelp(ctx, String(args.query))
          return result({ items: hits }, { summary: ctx.v2.t('system.summary.help_search', { count: hits.length, query: neutralize(String(args.query)) }) })
        }
        const tools = catalogTools(ctx).map((tool) => ({ tool: tool.name, actions: Object.keys(tool.actions).length }))
        return result({ tools, topics: GUIDE_TOPICS.map((topic) => ({ topic: topic.id, when: topic.when })), how: 'options.describe:"<tool>.<action>" for arguments; topic:"<id>" for a guide topic.' }, {
          summary: ctx.v2.t('system.summary.help_index', { tools: tools.length, topics: GUIDE_TOPICS.length }),
        })
      },
    },
    triage: {
      tier: 'read',
      doc: 'Support triage for a setup or usage problem: query (the person\'s words), topic optional, project optional. Returns diagnostics, next steps and repair actions; never creates a spec.',
      handler: async (ctx, args) => {
        let projectId: string | undefined
        try { projectId = ctx.v2.project(args).id } catch (err) { if (args.project !== undefined) throw err }
        const handler = supportTools()[0].handler
        const out = asRecord(await handler(ctx, { action: 'triage', question: str(args.query), topic: str(args.topic), projectId, includeDiagnostics: optionsOf(args).diagnostics !== false }))
        const steps = asArray(out.recommendedNextSteps)
        const data: Row = { topic: out.topic, question: out.question, recommendedNextSteps: steps, availableRepairActions: out.availableRepairActions, supportPrompt: out.supportPrompt }
        if (ctx.v2.view === 'detail') data.localDiagnostics = out.localDiagnostics
        else {
          const diagnostics = asRecord(out.localDiagnostics)
          data.diagnostics = Object.fromEntries(Object.entries(diagnostics).filter(([key]) => key !== 'projects').map(([key, value]) => [key, asRecord(value).ok === false ? { ok: false, error: asRecord(value).error } : value]))
        }
        return result(data, { summary: ctx.v2.t('system.summary.triage', { topic: String(out.topic), steps: steps.length }), untrusted: untrusted('/data/question', '/data/localDiagnostics', '/data/diagnostics') })
      },
    },
    report: {
      tier: 'write',
      doc: 'Builds the redacted "Report a problem" ZIP (logs, versions, settings without secrets) and saves it locally; returns its path. options.dir: an absolute folder (default: the OS temp folder). Nothing is uploaded.',
      handler: async (ctx, args) => {
        const preview = asRecord(await apiCall(ctx, 'POST', '/diagnostics/report'))
        const files = asArray(preview.files).map(asRecord)
        const zip = buildZip(files.map((file) => ({ name: String(file.name), data: Buffer.from(String(file.content ?? ''), 'utf8') })))
        const dir = reportDir(args)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        const fileName = path.basename(String(preview.fileName ?? `specrails-report-${Date.now()}.zip`))
        const filePath = path.join(dir, fileName)
        fs.writeFileSync(filePath, zip, { mode: 0o600 })
        return result({ path: filePath, bytes: zip.length, files: files.map((file) => ({ name: file.name, bytes: file.bytes })) }, { summary: ctx.v2.t('system.summary.report', { path: filePath, files: files.length }) })
      },
    },
    crashes: {
      tier: 'read',
      doc: 'Server restarts not explained to the person yet (outcome, exit code, uptime). Acknowledge with crashes_ack.',
      handler: async (ctx) => {
        const out = asRecord(await apiCall(ctx, 'GET', '/diagnostics/crashes'))
        const notices = asArray(out.notices).map(asRecord).map((notice) => ({ ...notice, at: typeof notice.atMs === 'number' ? new Date(notice.atMs).toISOString() : null }))
        return result({ available: out.available !== false, acknowledgedThroughMs: out.acknowledgedThroughMs ?? 0, items: notices }, { summary: notices.length ? ctx.v2.t('system.summary.crashes', { count: notices.length }) : ctx.v2.t('system.summary.crashes_none') })
      },
    },
    crashes_ack: {
      tier: 'write',
      doc: 'Marks every listed restart as explained. options.throughMs (default: the newest notice).',
      handler: async (ctx, args) => {
        let through = num(optionsOf(args).throughMs)
        if (through === undefined) {
          const notices = asArray(asRecord(await apiCall(ctx, 'GET', '/diagnostics/crashes')).notices).map(asRecord)
          through = notices.reduce((max, notice) => Math.max(max, Number(notice.atMs) || 0), 0)
        }
        const out = await apiCall(ctx, 'POST', '/diagnostics/crashes/ack', { throughMs: through })
        return result(out, { summary: ctx.v2.t('system.summary.crashes_ack') })
      },
    },
    stalls: {
      tier: 'read',
      doc: 'The event-loop stall probe: how often and how long the server was unresponsive (newest first).',
      handler: async (ctx, args) => {
        const out = asRecord(await apiCall(ctx, 'GET', '/diagnostics/stalls'))
        const page = pageOf(asArray(out.recent), { cursor: args.cursor, limit: args.limit, key: 'stalls', defaultLimit: 10 })
        return result({ thresholdMs: out.thresholdMs, sampling: out.sampling, total: out.total, longestMs: out.longestMs, since: typeof out.sinceMs === 'number' ? new Date(out.sinceMs).toISOString() : null, items: page.items }, {
          summary: ctx.v2.t('system.summary.stalls', { count: Number(out.total ?? 0), ms: Math.round(Number(out.longestMs ?? 0)) }), page: page.page,
        })
      },
    },
    updates: {
      ...byOp('updates'),
      doc: 'op: status (default; Desktop and Core) | check (asks the update servers) | apply (options.target: core|desktop; Core options.version; Desktop options.restart: when_idle (default) | now | never — installs from the open app window).',
      preview: async (ctx, args) => {
        const target = updateTarget(ctx, args)
        const facts = await updateFacts(ctx)
        if (target === 'core') {
          const version = str(optionsOf(args).version) ?? facts.core.latestVersion
          if (!version || (!str(optionsOf(args).version) && facts.core.updateAvailable !== true)) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.no_update', { target }))
          return { effect: ctx.v2.t('system.confirm.updates_core', { current: String(facts.core.currentVersion ?? '?'), version: String(version) }), version: shortHash({ t: target, c: facts.core.currentVersion, v: version, u: facts.core.updating }) }
        }
        const latest = asRecord(facts.desktop.latest)
        if (facts.desktop.available !== true) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.no_update', { target }))
        return { effect: ctx.v2.t('system.confirm.updates_desktop', { current: String(facts.desktop.currentVersion), version: String(latest.version), restart: restartOf(args) }), version: shortHash({ t: target, c: facts.desktop.currentVersion, v: latest.version, w: asRecord(facts.desktop.window).connected }) }
      },
      handler: async (ctx, args) => {
        const sub = opFor(ctx, 'updates', args)
        if (sub === 'check') {
          await Promise.all([probe(() => apiCall(ctx, 'POST', '/core-update/check', {})), probe(() => apiCall(ctx, 'POST', '/desktop-updates/check'))])
          return updatesView(ctx, await updateFacts(ctx))
        }
        if (sub === 'apply') {
          const target = updateTarget(ctx, args)
          if (target === 'core') {
            const version = str(optionsOf(args).version)
            const out = await apiCall(ctx, 'POST', '/core-update/update', version ? { version } : {})
            const status = asRecord(await apiCall(ctx, 'GET', '/core-update/status'))
            return result({ target, accepted: true, ...asRecord(out) }, { summary: ctx.v2.t('system.summary.updates_apply_core', { version: version ?? String(status.latestVersion ?? '?') }) })
          }
          const facts = await updateFacts(ctx)
          const out = asRecord(await apiCall(ctx, 'POST', '/desktop-updates/apply', { version: asRecord(facts.desktop.latest).version, restart: restartOf(args) }))
          return result({ target, ...out }, {
            summary: ctx.v2.t('system.summary.updates_apply_desktop', { version: String(out.version), restart: String(out.restart) }),
            warnings: ['The app restarts after installing; this MCP connection drops and reconnects. Re-read specrails_system(updates) or (health) afterwards.'],
          })
        }
        return updatesView(ctx, await updateFacts(ctx))
      },
    },
    continuity: {
      ...byOp('continuity'),
      doc: 'After a restart. op: list (default; interrupted mission turns, runs the restart paused, work running now) | resume (sends each interrupted mission its continuation; options.ids limits it) | settle (dismisses offers: options.ids, options.runs:true for the paused runs). Paused runs resume with specrails_runs(resume).',
      preview: async (ctx, args) => {
        const offers = asArray(asRecord(await apiCall(ctx, 'GET', '/continuity/resume-offers')).offers).map(asRecord)
        const ids = asArray(optionsOf(args).ids).map(String)
        const chosen = ids.length ? offers.filter((offer) => ids.includes(String(offer.conversationId))) : offers
        return { effect: ctx.v2.t('system.confirm.continuity_resume', { count: chosen.length }), refs: chosen.map((offer) => formatRef('mission', String(offer.conversationId))), version: shortHash(chosen.map((offer) => [offer.conversationId, offer.startedAt])), cost: { forecastUsd: null, runs: chosen.length } }
      },
      handler: async (ctx, args) => {
        const sub = opFor(ctx, 'continuity', args)
        const ids = asArray(optionsOf(args).ids).map(String)
        if (sub === 'settle') {
          const out = asRecord(await apiCall(ctx, 'POST', '/continuity/resume-offers/settle', { conversationIds: ids, ...(optionsOf(args).runs === true ? { runs: true } : {}) }))
          return result(out, { summary: ctx.v2.t('system.summary.continuity_settle', { count: Number(out.settled ?? ids.length) }) })
        }
        const state = asRecord(await apiCall(ctx, 'GET', '/continuity/resume-offers'))
        const offers = asArray(state.offers).map(asRecord)
        if (sub === 'resume') {
          const chosen = ids.length ? offers.filter((offer) => ids.includes(String(offer.conversationId))) : offers
          const resumed: string[] = []
          const failed: Row[] = []
          for (const offer of chosen) {
            const id = String(offer.conversationId)
            const trigger = ['quit', 'update', 'crash'].includes(String(offer.trigger)) ? String(offer.trigger) : 'quit'
            try {
              // Same continuation and idempotent queue id as the app's "Resume" (client continuity-model.ts).
              await apiCall(ctx, 'POST', `/agent/conversations/${enc(id)}/send`, { text: ctx.v2.t(`system.resume.prompt.${trigger}`), queueId: `resume-${id}-${Date.parse(String(offer.startedAt)) || 0}` })
              resumed.push(id)
            } catch (err) {
              failed.push({ mission: formatRef('mission', id), error: err instanceof Error ? err.message.slice(0, 300) : String(err) })
            }
          }
          if (resumed.length) await apiCall(ctx, 'POST', '/continuity/resume-offers/settle', { conversationIds: resumed })
          return result({ resumed: resumed.map((id) => formatRef('mission', id)), failed }, { summary: ctx.v2.t('system.summary.continuity_resume', { count: resumed.length }), refs: Object.fromEntries(resumed.map((id, index) => [`mission.${index}`, formatRef('mission', id)])) })
        }
        const active = asRecord(await apiCall(ctx, 'GET', '/continuity/active-work').catch(() => ({})))
        const projects = ctx.v2.projects()
        const runs = asArray(state.runs).map(asRecord).map((run) => {
          const project = projects.find((row) => row.id === run.projectId)
          return project ? formatRef('run', String(run.runId), project.slug) : `${String(run.projectId)}/${String(run.runId)}`
        })
        const items = offers.map((offer) => ({ mission: formatRef('mission', String(offer.conversationId)), title: offer.title ? neutralize(String(offer.title)) : null, trigger: offer.trigger, provider: offer.provider ?? null, stoppedAt: offer.stoppedAt ?? offer.startedAt }))
        return result({ bootedAt: state.bootedAt ?? null, offers: items, pausedRuns: runs, activeWork: active, ...(items.length || runs.length ? { next: [
          ...(items.length ? [{ tool: 'specrails_system', args: { action: 'continuity', op: 'resume' }, why: 'Resume the interrupted missions.' }] : []),
          ...runs.slice(0, 5).map((ref) => ({ tool: 'specrails_runs', args: { action: 'resume', ref }, why: 'Resume this paused run.' })),
        ] } : {}) }, {
          summary: ctx.v2.t('system.summary.continuity', { offers: items.length, runs: runs.length, active: Number(active.total ?? 0) }),
          untrusted: untrusted('/data/offers/*/title'),
        })
      },
    },
    worktrees: {
      ...byOp('worktrees'),
      doc: 'Settings ▸ Storage. op: list (default; retained run worktrees and safety archives) | sizes (id or options.items) | remove (id or options.items [{project, id, deleteBranch}]; refuses a worktree whose head moved) | quarantine_inspect / quarantine_remove (options.items [{project, path}]).',
      preview: async (ctx, args) => {
        if (op(args) === 'quarantine_remove') {
          const choices = quarantineChoices(ctx, args)
          return { effect: ctx.v2.t('system.confirm.quarantines_remove', { count: choices.length, names: choices.map((choice) => path.basename(choice.path)).slice(0, 5).join(', ') }), version: shortHash(choices) }
        }
        return worktreesRemovePreview(ctx, args)
      },
      handler: async (ctx, args) => {
        const sub = opFor(ctx, 'worktrees', args)
        if (sub === 'sizes') {
          const out = asRecord(await apiCall(ctx, 'POST', '/worktrees/retained/sizes', { items: worktreeChoices(ctx, args).map(({ projectId, id }) => ({ projectId, id })) }))
          const items = asArray(out.items)
          return result({ items }, { summary: ctx.v2.t('system.summary.worktrees_sizes', { count: items.length }) })
        }
        if (sub === 'remove') {
          const choices = worktreeChoices(ctx, args)
          const current = await retained(ctx)
          const items = choices.map((choice) => ({ ...choice, head: current.find((item) => item.projectId === choice.projectId && item.id === choice.id)?.head }))
          const out = asRecord(await apiCall(ctx, 'POST', '/worktrees/retained/remove', { items }))
          const results = asArray(out.results).map(asRecord)
          return result({ results }, { summary: ctx.v2.t('system.summary.worktrees_removed', { removed: results.filter((entry) => entry.status === 'removed').length, count: results.length }) })
        }
        if (sub === 'quarantine_inspect' || sub === 'quarantine_remove') {
          const out = asRecord(await apiCall(ctx, 'POST', `/worktrees/quarantines/${sub === 'quarantine_inspect' ? 'inspect' : 'remove'}`, { items: quarantineChoices(ctx, args) }))
          const results = asArray(out.items ?? out.results).map(asRecord)
          return result({ results }, sub === 'quarantine_remove' ? { summary: ctx.v2.t('system.summary.quarantines_removed', { removed: results.filter((entry) => entry.status === 'removed' || entry.status === 'deleted').length, count: results.length }) } : {})
        }
        const [list, quarantines] = await Promise.all([retained(ctx), probe(() => apiCall(ctx, 'GET', '/worktrees/quarantines'))])
        const projectFilter = args.project !== undefined ? ctx.v2.project(args).id : null
        const items = list.filter((item) => !projectFilter || item.projectId === projectFilter).map((item) => worktreeItem(ctx, item))
        const archives = quarantines.ok ? asArray(asRecord(quarantines.data).items).map(asRecord).filter((item) => !projectFilter || item.projectId === projectFilter) : []
        const page = pageOf(items, { cursor: args.cursor, limit: args.limit, key: `worktrees:${projectFilter ?? ''}` })
        return result({ items: page.items, quarantines: archives }, { summary: ctx.v2.t('system.summary.worktrees', { count: items.length, quarantines: archives.length }), page: page.page })
      },
    },
    machine_installs: {
      ...byOp('machine_installs'),
      doc: 'Machine-wide install approvals the person gave (e.g. a toolchain a run needed). op: list (default) | revoke (options.command; the next run that needs it asks again). Runs specrails_settings(machine_installs).',
      handler: async (ctx, args) => {
        // specrails_settings(machine_installs) is the one implementation; this is its system-side entry.
        if (opFor(ctx, 'machine_installs', args) === 'revoke') {
          const command = str(optionsOf(args).command) ?? str(args.id)
          if (!command) throw new V2ToolError('invalid_input', 'Pass the approved command in options.command.')
          return relay(await ctx.v2.dispatch({ tool: 'specrails_settings', args: { action: 'set', section: 'machine_installs', values: { revoke: command } } }))
        }
        return relay(await ctx.v2.dispatch({ tool: 'specrails_settings', args: { action: 'get', section: 'machine_installs', ...(args.lang !== undefined ? { lang: args.lang } : {}) } }))
      },
    },
    background: {
      ...byOp('background'),
      doc: 'Background processes (dev servers, watchers) of a project. op: list (default; options.includeFinished) | logs (id = pid; options.lines) | kill (id = pid). Starting one is the in-app agent\'s (specrails_background start).',
      maxTokens: 4000,
      preview: async (ctx, args) => {
        const { base } = projectBase(ctx, args)
        const pid = pidOf(args)
        const process = await processRow(ctx, base, pid)
        return { effect: ctx.v2.t('system.confirm.background_kill', { pid, command: neutralize(String(process.command ?? '')).slice(0, 200) }), version: shortHash({ pid, id: process.processId ?? process.id, s: process.status }) }
      },
      handler: async (ctx, args) => {
        const sub = opFor(ctx, 'background', args)
        const { base } = projectBase(ctx, args)
        if (sub === 'logs' || sub === 'kill') {
          const pid = pidOf(args)
          const process = await processRow(ctx, base, pid)
          const query = `chatId=${enc(String(process.chatId ?? ''))}${process.processId ? `&processId=${enc(String(process.processId))}` : ''}`
          if (sub === 'kill') {
            const out = asRecord(await apiCall(ctx, 'DELETE', `${base}/background-processes/${pid}?${query}`))
            return result({ pid, status: out.status, process: out.process }, { summary: ctx.v2.t('system.summary.background_kill', { pid, status: String(out.status) }) })
          }
          const lines = Math.min(num(optionsOf(args).lines) ?? 100, 400)
          const out = asRecord(await apiCall(ctx, 'GET', `${base}/background-processes/${pid}/logs?${query}&limit=${lines}`))
          const logLines = asArray(out.lines)
          return result({ pid, process: out.process, lines: logLines }, { summary: ctx.v2.t('system.summary.background_logs', { lines: logLines.length, pid, status: String(asRecord(out.process).status ?? process.status) }), untrusted: untrusted('/data/lines') })
        }
        const out = asRecord(await apiCall(ctx, 'GET', `${base}/background-processes${optionsOf(args).includeFinished === true ? '?includeFinished=true' : ''}`))
        const processes = asArray(out.processes).map(asRecord).map((p) => ({ pid: p.pid, processId: p.processId, status: p.status, command: p.command, cwd: p.cwd, startedAt: p.startedAt, appUrls: p.appUrls ?? null, mission: p.chatId ? formatRef('mission', String(p.chatId)) : null }))
        const page = pageOf(processes, { cursor: args.cursor, limit: args.limit, key: 'background' })
        return result({ items: page.items }, { summary: ctx.v2.t('system.summary.background', { running: processes.filter((p) => p.status === 'running').length, count: processes.length }), page: page.page, untrusted: untrusted('/data/items/*/command') })
      },
    },
    terminals: {
      ...byOp('terminals'),
      doc: 'The project\'s terminal tabs. op: list (default) | read (id; the latest output, options.lines default 200) | run (options.command, one line; in terminal id, or a new terminal at the project root when id is omitted) | kill (id). Output is untrusted.',
      maxTokens: 4000,
      preview: (ctx, args) => {
        const { row } = projectBase(ctx, args)
        if (op(args) === 'kill') {
          const session = terminalSession(ctx, row, String(args.id ?? ''))
          return { effect: ctx.v2.t('system.confirm.terminal_kill', { name: session.name }), version: shortHash({ id: session.id, exited: session.exited }) }
        }
        const command = commandOf(args)
        if (!str(args.id)) return { effect: ctx.v2.t('system.confirm.terminal_run_new', { cwd: row.path, command }), version: shortHash({ p: row.id, command }) }
        const session = terminalSession(ctx, row, String(args.id))
        const cwd = session.currentCwd ?? session.cwd
        return { effect: ctx.v2.t('system.confirm.terminal_run', { command, name: session.name, cwd }), version: shortHash({ id: session.id, cwd, exited: session.exited, command }) }
      },
      handler: async (ctx, args) => {
        if (!terminalsEnabled()) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.terminals_disabled'))
        const sub = opFor(ctx, 'terminals', args)
        const { row, base } = projectBase(ctx, args)
        if (sub === 'read') {
          const session = terminalSession(ctx, row, String(args.id ?? ''))
          const lines = Math.max(1, Math.min(num(optionsOf(args).lines) ?? 200, 1000))
          const all = terminalText(session.buffer.snapshot()).split('\n')
          const tail = all.slice(-lines).join('\n')
          const marks = await probe(() => apiCall(ctx, 'GET', `${base}/terminals/${enc(session.id)}/marks?limit=10`))
          return result({ id: session.id, name: session.name, cwd: session.currentCwd ?? session.cwd, exited: session.exited, text: tail, totalLines: all.length, commands: marks.ok ? asArray(asRecord(marks.data).marks) : [] }, {
            summary: ctx.v2.t('system.summary.terminal_read', { lines: Math.min(lines, all.length), name: session.name }), untrusted: untrusted('/data/text', '/data/commands'),
          })
        }
        if (sub === 'run') {
          const command = commandOf(args)
          let id = str(args.id)
          if (!id) id = String(asRecord(asRecord(await apiCall(ctx, 'POST', `${base}/terminals`, { name: 'MCP' })).session).id)
          const session = terminalSession(ctx, row, id)
          if (session.exited) throw new V2ToolError('invalid_input', ctx.v2.t('system.error.terminal_not_found', { id }))
          getTerminalManager().write(session.id, `${command}\r`)
          return result({ id: session.id, name: session.name, sent: command, next: { tool: 'specrails_system', args: { action: 'terminals', op: 'read', id: session.id }, why: 'Read the output.' } }, { summary: ctx.v2.t('system.summary.terminal_run', { name: session.name }) })
        }
        if (sub === 'kill') {
          const session = terminalSession(ctx, row, String(args.id ?? ''))
          await apiCall(ctx, 'DELETE', `${base}/terminals/${enc(session.id)}`)
          return result({ id: session.id, killed: true }, { summary: ctx.v2.t('system.summary.terminal_kill', { name: session.name }) })
        }
        const out = asRecord(await apiCall(ctx, 'GET', `${base}/terminals`))
        const sessions = asArray(out.sessions).map(asRecord).map((s) => ({ id: s.id, name: s.name, shell: s.shell, cwd: s.cwd, createdAt: s.createdAt }))
        return result({ items: sessions, limit: out.limit ?? null }, { summary: ctx.v2.t('system.summary.terminals', { count: sessions.length }) })
      },
    },
    browser: {
      ...byOp('browser'),
      doc: 'The built-in browser. op: list (default; open sessions and their pages) | capture (id = session; options.rect {x,y,width,height}, default the whole viewport) → a screenshot + DOM saved as attachments (use them as spec evidence).',
      handler: async (ctx, args) => {
        const sub = opFor(ctx, 'browser', args)
        const { base } = projectBase(ctx, args)
        const out = asRecord(await apiCall(ctx, 'GET', `${base}/browser/sessions`))
        const sessions = asArray(out.sessions).map(asRecord)
        if (sub === 'capture') {
          const session = sessions.find((s) => s.id === str(args.id)) ?? (args.id === undefined && sessions.length === 1 ? sessions[0] : undefined)
          if (!session) throw new V2ToolError('not_found', `No browser session ${String(args.id ?? '')}. List them with op: list.`)
          const rect = asRecord(optionsOf(args).rect)
          const viewport = { x: 0, y: 0, width: Number(session.viewportWidth) || 1280, height: Number(session.viewportHeight) || 800 }
          const pendingSpecId = `mcp-${shortHash({ s: session.id, t: Date.now() })}`
          const captured = asRecord(await apiCall(ctx, 'POST', `${base}/browser/sessions/${enc(String(session.id))}/capture`, { rect: Object.keys(rect).length ? rect : viewport, pendingSpecId }))
          const shot = asRecord(captured.screenshot)
          const dom = asRecord(captured.domAttachment)
          return result({ session: session.id, url: session.url, pendingSpecId, screenshot: { id: shot.id, name: shot.filename ?? shot.name, path: shot.path ?? null, bytes: shot.size ?? null }, dom: { id: dom.id, name: dom.filename ?? dom.name, path: dom.path ?? null } }, {
            summary: ctx.v2.t('system.summary.browser_capture', { url: neutralize(String(session.url ?? '?')), file: String(shot.filename ?? shot.name ?? 'screenshot') }),
            untrusted: untrusted('/data/url'),
          })
        }
        const items = sessions.map((s) => ({ id: s.id, url: s.url, title: s.title, viewport: `${String(s.viewportWidth)}x${String(s.viewportHeight)}` }))
        return result({ items, lastUrl: out.lastUrl ?? null }, { summary: ctx.v2.t('system.summary.browser', { count: items.length }), untrusted: untrusted('/data/items/*/title', '/data/items/*/url') })
      },
    },
    docs: {
      tier: 'read', maxTokens: 6000,
      doc: 'The user documentation, in the reply language. No args: categories. query: search titles and headings. topic: "<category>/<slug>" reads a page (paged with cursor).',
      handler: async (ctx, args) => {
        const lang = ctx.v2.lang
        const topic = str(args.topic)
        if (topic) {
          const [category, slug] = topic.replace(/^\/+/, '').split('/')
          if (!category || !slug) throw new V2ToolError('invalid_input', 'topic is "<category>/<slug>", e.g. from docs query results.')
          const page = asRecord(await apiCall(ctx, 'GET', `/docs/${enc(category)}/${enc(slug)}?lang=${lang}`))
          const paged = pageText(String(page.content ?? ''), args.cursor, `docs:${topic}`)
          return result({ topic, title: page.title ?? slug, text: paged.text }, { summary: ctx.v2.t('system.summary.docs_page', { title: String(page.title ?? slug), more: paged.page?.truncated ? ' (more: cursor)' : '' }), ...(paged.page ? { page: paged.page } : {}) })
        }
        const query = str(args.query)
        if (query) {
          const results = asArray(asRecord(await apiCall(ctx, 'GET', `/docs/search?q=${enc(query)}&lang=${lang}`)).results).map(asRecord)
            .map((hit) => ({ topic: `${String(hit.category)}/${String(hit.slug)}`, title: hit.title, heading: hit.heading ?? null }))
          return result({ items: results }, { summary: ctx.v2.t('system.summary.docs_search', { count: results.length, query: neutralize(query) }) })
        }
        const categories = asArray(asRecord(await apiCall(ctx, 'GET', `/docs?lang=${lang}`)).categories).map(asRecord)
          .map((cat) => ({ category: cat.slug, name: cat.name, pages: asArray(cat.docs).map(asRecord).map((doc) => ({ topic: `${String(cat.slug)}/${String(doc.slug)}`, title: doc.title })) }))
        return result({ items: categories }, { summary: ctx.v2.t('system.summary.docs_index', { count: categories.length }) })
      },
    },
  },
})

export const _systemTestHooks = { pageText, OPS, MUTATING }
