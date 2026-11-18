/**
 * Run-scoped text for the legacy loop engine: the bounded cross-iteration
 * history handed to later steps and the Decider, captured `{{run.<name>}}`
 * variables, and the OpenSpec change identity a launch seeds or a step reports.
 */
import { createHash } from 'crypto'
import path from 'path'
import fs from 'fs'
import type { LoopRunRequest } from './loop-run-contract'

const HISTORY_MAX_CHARS = 1500

/** The cross-iteration history, bounded to its most recent HISTORY_MAX_CHARS. */
export function composeHistory(history: readonly string[]): string {
  const joined = history.join('\n')
  return joined.length > HISTORY_MAX_CHARS ? '…' + joined.slice(-HISTORY_MAX_CHARS) : joined
}

/** Shrink a step's output for the Decider history. Keeps BOTH ends — the opening
 *  context AND the trailing lines — because the Decider keys off a final verdict
 *  line (e.g. `VERIFICATION: PASS`) that a head-only cut would silently drop. */
export function truncate(s: string, max = 600): string {
  if (s.length <= max) return s
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return s.slice(0, head) + '\n…\n' + s.slice(s.length - tail)
}

// ── Run-scoped captured variables ({{run.<name>}}) ───────────────────────────
// A run can capture values from a step's output and reference them in LATER
// ai-step prompts and shell commands as `{{run.<name>}}`. v1 captures exactly one
// — `changeId`, the OpenSpec change id — written so the family can generalize.

const RUN_TOKEN_RE = /\{\{\s*run\.(\w+)\s*\}\}/g
/** First ACTIVE `openspec/changes/<id>` path mentioned in a step's output.
 *  Archive paths (`openspec/changes/archive/...`) are historical destinations,
 *  not runnable change ids for later `{{run.changeId}}` commands. */
const CHANGE_ID_RE = /openspec[\\/]+changes[\\/]+(?!archive(?:[\\/]|$))([A-Za-z0-9._-]+)(?=[\\/]|\s|$)/g

/** Replace `{{run.<name>}}` with the captured value; uncaptured → '' (never a
 *  leaked literal token). Applied AFTER `{{cmd:*}}` and `{{spec.*}}`. */
export function resolveRunVars(text: string, vars: Record<string, string>): string {
  return text.replace(RUN_TOKEN_RE, (_m, key: string) => vars[key] ?? '')
}

const CHANGE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The authoritative OpenSpec target for a launch.
 *  Addenda/delivery deltas use durable content/lineage identity; ordinary launches use the
 *  follow-up's declared name, else the spec's `openspecChangeName`. */
export function seedChangeId(req: Pick<LoopRunRequest, 'followUp' | 'spec' | 'addenda' | 'runId' | 'constants' | 'cwd' | 'ticketId'>): { id: string; source: 'addenda' | 'revision' | 'followUp' | 'spec' } | undefined {
  const valid = (value: string) => value.length <= 64 && CHANGE_NAME_RE.test(value)
  const fromFollowUp = typeof req.followUp?.openspecChangeName === 'string' ? req.followUp.openspecChangeName.trim() : ''
  const direct = typeof req.spec?.openspecChangeName === 'string' ? req.spec.openspecChangeName.trim() : ''
  const fromMetadata = typeof req.spec?.metadata?.openspecChangeName === 'string' ? req.spec.metadata.openspecChangeName.trim() : ''
  const declared = valid(fromFollowUp) ? fromFollowUp : valid(direct || fromMetadata) ? direct || fromMetadata : ''
  const source = declared === fromFollowUp ? 'followUp' as const : 'spec' as const
  if (req.addenda?.ids.length || req.constants?.REVISION_REQUEST) {
    const state = declared ? openspecChangeState(req.cwd, declared) : 'missing'
    // A pending implementation's addenda refine the same change. Only work
    // already delivered/archived needs a separate delta proposal.
    if (declared && (state === 'active' || (state === 'missing' && !req.constants?.REVISION_REQUEST && req.spec?.status !== 'on_review'))) return { id: declared, source }
    const hash = createHash('sha256').update(JSON.stringify([
      req.constants?.REVISION_OF_DELIVERY_ID ?? null,
      req.constants?.REVISION_NUMBER ?? null,
      req.constants?.REVISION_REQUEST ?? null,
      req.addenda ? [...req.addenda.ids].sort() : [], req.addenda?.briefing ?? null,
    ])).digest('hex').slice(0, 12)
    const revisionNumber = req.constants?.REVISION_NUMBER
    const kind = req.addenda?.ids.length ? 'addenda' : 'revision'
    const suffix = req.constants?.REVISION_REQUEST ? `rev${revisionNumber && /^[1-9]\d{0,3}$/.test(revisionNumber) ? revisionNumber : '1'}-${hash}` : `addenda-${hash}`
    const stem = declared || (req.ticketId && req.ticketId > 0 ? `ticket-${req.ticketId}` : 'spec')
    return { id: `${stem.slice(0, 63 - suffix.length).replace(/-+$/, '')}-${suffix}`, source: kind }
  }
  if (declared) return { id: declared, source }
  return undefined
}

/** Where an OpenSpec change currently lives under `cwd`: an ACTIVE
 *  `openspec/changes/<id>` dir, an ARCHIVED `openspec/changes/archive/<…-id>`
 *  dir, or nowhere. Read-only, never throws (an unreadable tree ⇒ 'missing'). */
export function openspecChangeState(cwd: string | undefined, changeId: string): 'active' | 'archived' | 'missing' {
  if (!cwd || !changeId) return 'missing'
  try {
    const changes = path.join(cwd, 'openspec', 'changes')
    if (fs.existsSync(path.join(changes, changeId))) return 'active'
    const archive = path.join(changes, 'archive')
    if (!fs.existsSync(archive)) return 'missing'
    const hit = fs.readdirSync(archive, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && (entry.name === changeId || entry.name.endsWith(`-${changeId}`)))
    return hit ? 'archived' : 'missing'
  } catch {
    return 'missing'
  }
}

/** Extract the OpenSpec change id from a step's output (first match wins), or
 *  undefined when none is present. */
export function extractChangeId(text: string): string | undefined {
  CHANGE_ID_RE.lastIndex = 0
  const m = CHANGE_ID_RE.exec(text)
  return m ? m[1] : undefined
}
