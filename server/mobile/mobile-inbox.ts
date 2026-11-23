import { Router, type Request, type Response } from 'express'
import type { DbInstance } from '../db'
import { getDesktopSetting, setDesktopSetting } from '../desktop-db'
import { isTierEnabled, type McpTier } from '../mcp/mcp-tiers'
import type { InboxItem } from '../modules/inbox'
import { getAllowedProjects } from './mobile-devices'
import type { MobileAuthedRequest } from './mobile-auth'
import type { MobileUpstream } from './mobile-missions'
import { redact } from './mobile-redact'

/**
 * The paired companion as a decision remote for the "Needs you" inbox.
 *
 * Read: `GET /v1/inbox` is the desktop read-model, narrowed to the device's
 * project grant, with the SAFE actions each row offers right now.
 *
 * Act: a closed set of four actions, each forwarded to the very route the
 * desktop UI uses, addressed to ONE project and tier-checked with the MCP
 * permission tiers (so turning a tier off in Settings ▸ MCP also turns the
 * action off on the phone). Everything else (merge, discard, force-push,
 * settings, delete) has no route here and the catch-all refuses it.
 */

/** Actions a companion may run. Anything else is desktop-only. */
export const COMPANION_ACTIONS = ['answer', 'resume', 'retry', 'create-pr'] as const
export type CompanionActionId = (typeof COMPANION_ACTIONS)[number]

/**
 * Tier per action. Answering only continues work the person already started
 * (write); resume and retry spend tokens (ai-spawn); a draft PR pushes a branch
 * to the remote, an external-system mutation (destructive, as in the MCP tiers).
 */
export const COMPANION_ACTION_TIERS: Record<CompanionActionId, McpTier> = {
  answer: 'write',
  resume: 'ai-spawn',
  retry: 'ai-spawn',
  'create-pr': 'destructive',
}

export interface CompanionActionView { id: CompanionActionId; tier: McpTier; enabled: boolean }

export interface CompanionItemView {
  actions: CompanionActionView[]
  /** Run addressed by `answer` / `resume`. */
  runId?: string
  /** Delivery id, or `run:<id>`, addressed by `retry`. */
  sourceId?: string
  railIndex?: number
  /** Concurrency token `create-pr` must echo back. */
  expectedDecision?: string
}

const NOT_PRIMARY: ReadonlySet<string> = new Set(['open-logs', 'edit-spec'])

/** The first remedy a phone can act on, mirroring the desktop's ranking (open-logs / edit-spec need the desk). */
function primaryRemedy(item: InboxItem): string | null {
  const remedies = item.diagnosis?.remedies ?? []
  return remedies.find((remedy) => !NOT_PRIMARY.has(remedy)) ?? null
}

/** Which safe actions an item offers, and the identities the phone posts back. Pure. */
export function companionTargetsFor(item: InboxItem): { ids: CompanionActionId[]; target: Omit<CompanionItemView, 'actions'> } {
  const none = { ids: [] as CompanionActionId[], target: {} }
  if (item.action === 'raise-cap' || item.action === 'retry-jira') return none
  if (item.kind === 'question') return { ids: ['answer'], target: { runId: item.subjectId } }
  if (item.action === 'resume-run') return { ids: ['resume'], target: { runId: item.subjectId } }
  if (item.kind === 'review') {
    return item.decision === 'on_review'
      ? { ids: ['create-pr'], target: { expectedDecision: 'on_review' } }
      : none
  }
  if (item.kind === 'failed' || item.kind === 'blocked') {
    const primary = primaryRemedy(item)
    const isRun = item.action === 'open-run'
    // `continue` is the desktop's Continue (`resume` is its older id); the phone's Resume runs it.
    if ((primary === 'continue' || primary === 'resume') && isRun) return { ids: ['resume'], target: { runId: item.subjectId } }
    if (primary === 'retry' && typeof item.railIndex === 'number') {
      return { ids: ['retry'], target: { sourceId: isRun ? `run:${item.subjectId}` : item.subjectId, railIndex: item.railIndex } }
    }
  }
  return none
}

export function companionView(db: DbInstance, item: InboxItem): CompanionItemView {
  const { ids, target } = companionTargetsFor(item)
  return {
    actions: ids.map((id) => ({ id, tier: COMPANION_ACTION_TIERS[id], enabled: isTierEnabled(db, COMPANION_ACTION_TIERS[id]) })),
    ...target,
  }
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// ── Server-side Snooze / Done ───────────────────────────────────────────────
//
// The desktop inbox keeps Snooze / Done per viewer (localStorage). Remote
// surfaces (the paired phone, MCP clients) have no such storage, so they share
// one app-wide record here (`desktop_settings` key `inbox_dismissals`): Done
// hides an item while its `version` is unchanged (a new state re-arms it), a
// snooze hides it until `until`. Pure state over the inbox's own ids and
// versions; the read-model itself never changes.

export const INBOX_DISMISSALS_KEY = 'inbox_dismissals'
/** Upper bound of stored dismissals (oldest dropped first). */
export const MAX_INBOX_DISMISSALS = 500
const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

export interface InboxDismissal {
  /** `done`: hidden while the version is unchanged; `snooze`: hidden until `until`. */
  kind: 'done' | 'snooze'
  version: string
  until: string | null
  at: string
}

export type InboxDismissals = Record<string, InboxDismissal>

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}:[a-z]{1,16}:[A-Za-z0-9:._-]{1,160}$/

export function isInboxItemId(value: unknown): value is string {
  return typeof value === 'string' && ITEM_ID.test(value)
}

/** The stored dismissals; a missing or corrupt record reads as none. */
export function readInboxDismissals(db: DbInstance): InboxDismissals {
  try {
    const raw = getDesktopSetting(db, INBOX_DISMISSALS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    const out: InboxDismissals = {}
    for (const [id, value] of Object.entries(record(parsed))) {
      const entry = record(value)
      if (!isInboxItemId(id) || (entry.kind !== 'done' && entry.kind !== 'snooze') || typeof entry.version !== 'string' || typeof entry.at !== 'string') continue
      out[id] = { kind: entry.kind, version: entry.version, until: typeof entry.until === 'string' ? entry.until : null, at: entry.at }
    }
    return out
  } catch {
    return {}
  }
}

function writeInboxDismissals(db: DbInstance, dismissals: InboxDismissals): void {
  const entries = Object.entries(dismissals).sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_INBOX_DISMISSALS)
  setDesktopSetting(db, INBOX_DISMISSALS_KEY, JSON.stringify(Object.fromEntries(entries)))
}

/** Whether a stored dismissal still hides an item at `version`, now. */
export function dismissalHides(dismissal: InboxDismissal | undefined, version: string, now: Date = new Date()): boolean {
  if (!dismissal) return false
  if (dismissal.kind === 'done') return dismissal.version === version
  const until = dismissal.until ? Date.parse(dismissal.until) : Number.NaN
  return Number.isFinite(until) && until > now.getTime()
}

/** Store Done (or a snooze until an instant, at most 30 days ahead) for one item at its current version. */
export function dismissInboxItem(db: DbInstance, input: { itemId: string; version: string; until?: string | null }, now: Date = new Date()): InboxDismissal {
  if (!isInboxItemId(input.itemId)) throw new RangeError('Invalid inbox item id')
  let until: string | null = null
  if (input.until !== undefined && input.until !== null) {
    const at = Date.parse(input.until)
    if (!Number.isFinite(at) || at <= now.getTime()) throw new RangeError('until must be a future time')
    until = new Date(Math.min(at, now.getTime() + MAX_SNOOZE_MS)).toISOString()
  }
  const dismissal: InboxDismissal = { kind: until ? 'snooze' : 'done', version: String(input.version).slice(0, 400), until, at: now.toISOString() }
  writeInboxDismissals(db, { ...readInboxDismissals(db), [input.itemId]: dismissal })
  return dismissal
}

/** Bring a dismissed item back. True when something was removed. */
export function restoreInboxItem(db: DbInstance, itemId: string): boolean {
  const current = readInboxDismissals(db)
  if (!current[itemId]) return false
  delete current[itemId]
  writeInboxDismissals(db, current)
  return true
}

/**
 * Split items into visible and hidden. Dismissals of items that are gone, or
 * that no longer hide anything (a lapsed snooze, a Done whose version moved),
 * are pruned when `prune` is set, so the record never grows without bound.
 */
export function applyInboxDismissals<T extends Pick<InboxItem, 'id' | 'version'>>(db: DbInstance, items: readonly T[], options: { now?: Date; prune?: boolean } = {}): { visible: T[]; hidden: Array<T & { dismissed: InboxDismissal }> } {
  const now = options.now ?? new Date()
  const dismissals = readInboxDismissals(db)
  const visible: T[] = []
  const hidden: Array<T & { dismissed: InboxDismissal }> = []
  for (const item of items) {
    const dismissal = dismissals[item.id]
    if (dismissalHides(dismissal, item.version, now)) hidden.push({ ...item, dismissed: dismissal! })
    else visible.push(item)
  }
  if (options.prune) {
    const live = new Set(hidden.map((item) => item.id))
    const kept = Object.fromEntries(Object.entries(dismissals).filter(([id]) => live.has(id)))
    if (Object.keys(kept).length !== Object.keys(dismissals).length) {
      try { writeInboxDismissals(db, kept) } catch { /* pruning is best-effort */ }
    }
  }
  return { visible, hidden }
}

const PID = /^[A-Za-z0-9_-]{1,64}$/
const RUN_ID = /^[A-Za-z0-9-]{1,128}$/
const SOURCE_ID = /^(?:run:)?[A-Za-z0-9-]{1,128}$/
const MAX_ANSWER = 20_000
const MAX_RUN_CAP_USD = 10_000
const pick = (value: unknown, keys: string[]) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => keys.includes(key)))

export function createMobileInboxRouter({ db, upstream }: { db: DbInstance; upstream: MobileUpstream }): Router {
  const router = Router()
  const seg = (value: unknown): string => (typeof value === 'string' ? value : '')

  const send = async (res: Response, method: string, path: string, body?: unknown, shape?: (json: unknown) => unknown) => {
    try {
      const result = await upstream(method, path, body)
      const ok = result.status >= 200 && result.status < 300
      res.status(result.status).json(redact(ok && shape ? shape(result.json) : result.json))
    } catch {
      res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' })
    }
  }

  /** 403 unless the action's permission tier is on. */
  const tierGate = (res: Response, action: CompanionActionId): boolean => {
    const tier = COMPANION_ACTION_TIERS[action]
    if (isTierEnabled(db, tier)) return true
    res.status(403).json({ error: 'tier_disabled', tier, action })
    return false
  }

  const base = (pid: string): string => `/api/projects/${encodeURIComponent(pid)}`

  router.get('/inbox', async (req: Request, res: Response) => {
    const allowed = getAllowedProjects(db, (req as MobileAuthedRequest).mobileDevice!.id)
    try {
      const result = await upstream('GET', '/api/inbox')
      if (result.status !== 200) { res.status(result.status).json(redact(result.json)); return }
      const snapshot = record(result.json)
      const visible = (projectId: unknown): boolean => typeof projectId === 'string' && (allowed === null || allowed.has(projectId))
      const granted = (Array.isArray(snapshot.items) ? snapshot.items : []).filter((item) => visible(record(item).projectId)) as InboxItem[]
      // Snooze / Done shared with the other remote surfaces; `?all=1` lists the hidden ones too, marked.
      const { visible: shown, hidden } = applyInboxDismissals(db, granted)
      const items = [...shown, ...(req.query.all === '1' ? hidden : [])]
        .map((item) => ({ ...item, companion: companionView(db, item) }))
      const projects = (Array.isArray(snapshot.projects) ? snapshot.projects : []).filter((p) => visible(record(p).projectId))
      res.json(redact({ items, projects, generatedAt: snapshot.generatedAt }))
    } catch {
      res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' })
    }
  })

  // Snooze (`until`) or Done (no `until`) one item at the version the device saw; DELETE brings it back.
  router.post('/inbox/dismissals', (req: Request, res: Response) => {
    const body = record(req.body), itemId = seg(body.itemId), version = seg(body.version)
    const allowed = getAllowedProjects(db, (req as MobileAuthedRequest).mobileDevice!.id)
    if (!isInboxItemId(itemId) || !version || version.length > 400 || (body.until !== undefined && typeof body.until !== 'string')) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (allowed !== null && !allowed.has(itemId.split(':')[0])) { res.status(404).json({ error: 'Not found' }); return }
    try {
      res.json({ ok: true, itemId, dismissed: dismissInboxItem(db, { itemId, version, until: body.until as string | undefined }) })
    } catch (err) {
      res.status(400).json({ error: err instanceof RangeError ? err.message : 'Invalid parameter' })
    }
  })

  router.delete('/inbox/dismissals/:itemId', (req: Request, res: Response) => {
    const itemId = seg(req.params.itemId)
    const allowed = getAllowedProjects(db, (req as MobileAuthedRequest).mobileDevice!.id)
    if (!isInboxItemId(itemId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (allowed !== null && !allowed.has(itemId.split(':')[0])) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ ok: true, itemId, restored: restoreInboxItem(db, itemId) })
  })

  // The question a paused run is waiting on (the Answer sheet shows it verbatim).
  router.get('/projects/:pid/inbox/runs/:runId/question', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), runId = seg(req.params.runId)
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    await send(res, 'GET', `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}`, undefined, (json) => {
      const run = record((Array.isArray(record(json).runs) ? record(json).runs as unknown[] : [])[0])
      const question = record(run.pendingQuestion)
      // `card`: the same structured question the desktop renders (choices, recommendation, consequence).
      const card = run.question && typeof run.question === 'object' && record(run.question).kind === 'question' ? run.question : null
      return typeof question.question === 'string'
        ? { pending: true, question: question.question, requestedAt: question.requestedAt ?? null, card }
        : { pending: false }
    })
  })

  // Answer agent question: the desktop's run "Answer" (runtime resume with an answer).
  router.post('/projects/:pid/inbox/answer', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), runId = seg(body.runId), answer = body.answer
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_ANSWER) { res.status(400).json({ error: `An answer of 1–${MAX_ANSWER} characters is required` }); return }
    if (!tierGate(res, 'answer')) return
    let run: Record<string, unknown>
    try {
      const status = await upstream('GET', `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}`)
      if (status.status !== 200) { res.status(status.status).json(redact(status.json)); return }
      run = record((Array.isArray(record(status.json).runs) ? record(status.json).runs as unknown[] : [])[0])
    } catch { res.status(502).json({ error: 'Desktop is unreachable. Retry when connected.' }); return }
    const question = record(run.pendingQuestion)
    if (typeof question.question !== 'string' || question.answeredAt !== undefined) { res.status(409).json({ error: 'no_pending_question' }); return }
    const definition = run.engineVersion === 2
    const path = definition
      ? `${base(pid)}/loop-runs/${encodeURIComponent(runId)}/resume`
      : `${base(pid)}/agent-runtime/runs/${encodeURIComponent(runId)}/resume`
    // A chosen option (Core questionOptions) travels with its label as the answer.
    const card = record(run.question)
    const optionId = typeof body.optionId === 'string' && Array.isArray(card.options) && card.options.some((option) => record(option).id === body.optionId) ? body.optionId : undefined
    if (body.optionId !== undefined && !optionId) { res.status(400).json({ error: 'The chosen option is not one the question offered' }); return }
    await send(res, 'POST', path, { answer: answer.trim(), ...(definition && typeof question.stepId === 'string' ? { interruptId: question.stepId } : {}), ...(definition && optionId ? { optionId } : {}) })
  })

  // Resume a budget/limit-paused or interrupted run; a run paused at its per-run cap takes the person's choice.
  router.post('/projects/:pid/inbox/resume', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), runId = seg(body.runId)
    if (!PID.test(pid) || !RUN_ID.test(runId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    const narrowed: Record<string, unknown> = {}
    if (body.runCap !== undefined) {
      if (body.runCap !== 'ignore') { res.status(400).json({ error: 'runCap must be "ignore"' }); return }
      narrowed.runCap = 'ignore'
    }
    if (body.runCapUsd !== undefined) {
      if (typeof body.runCapUsd !== 'number' || !Number.isFinite(body.runCapUsd) || body.runCapUsd <= 0 || body.runCapUsd > MAX_RUN_CAP_USD) { res.status(400).json({ error: 'runCapUsd must be a positive amount' }); return }
      if (narrowed.runCap) { res.status(400).json({ error: 'Choose ignore or raise, not both' }); return }
      narrowed.runCapUsd = body.runCapUsd
    }
    if (!tierGate(res, 'resume')) return
    // A run that already ended (failed or stopped) is continued, the desktop's Continue; a paused one resumes.
    try {
      const current = await upstream('GET', `${base(pid)}/loop-runs/${encodeURIComponent(runId)}`)
      const status = (record(record(current.json).loopRun)).status
      if (current.status === 200 && status === 'completed') { await send(res, 'POST', `${base(pid)}/loop-runs/${encodeURIComponent(runId)}/remedy`, { remedy: 'continue' }); return }
    } catch { /* the plain resume below answers with the desktop's own error */ }
    await send(res, 'POST', `${base(pid)}/loop-runs/${encodeURIComponent(runId)}/resume`, narrowed)
  })

  // Retry the failed attempt: the cockpit's relaunch of the same rail, same source.
  router.post('/projects/:pid/inbox/retry', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), sourceId = seg(body.sourceId), railIndex = body.railIndex
    if (!PID.test(pid) || !SOURCE_ID.test(sourceId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (typeof railIndex !== 'number' || !Number.isSafeInteger(railIndex) || railIndex < 0 || railIndex > 1000) { res.status(400).json({ error: 'Invalid rail' }); return }
    if (!tierGate(res, 'retry')) return
    await send(res, 'POST', `${base(pid)}/rails/${railIndex}/relaunch`, { sourceId })
  })

  // Create draft PR: the PR decision, narrowed to create-pr on a delivery that is still on review.
  router.post('/projects/:pid/inbox/create-pr', async (req: Request, res: Response) => {
    const pid = seg(req.params.pid), body = record(req.body), prDeliveryId = seg(body.prDeliveryId)
    if (!PID.test(pid) || !RUN_ID.test(prDeliveryId)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    if (body.expectedDecision !== 'on_review') { res.status(400).json({ error: 'expectedDecision must be on_review' }); return }
    if (!tierGate(res, 'create-pr')) return
    await send(res, 'POST', `${base(pid)}/rails/pr-decision`,
      { prDeliveryId, action: 'create-pr', expectedDecision: 'on_review' },
      (json) => pick(json, ['ok', 'decision', 'prUrl', 'prState', 'detail']))
  })

  // Deny by name, not by silence: merge, discard, publish, force-push, settings, delete.
  router.all('/projects/:pid/inbox/:action', (_req: Request, res: Response) => {
    res.status(403).json({ error: 'action_not_allowed_for_companion', detail: 'This decision stays on Desktop.' })
  })

  return router
}
