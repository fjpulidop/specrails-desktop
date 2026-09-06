/**
 * Global, cross-loop constants library. Constants are dragged into loop steps as
 * `{{const:NAME}}` tokens and resolved at RUN TIME by the engine — so editing a
 * constant's value updates every loop that references it (the user-chosen "live
 * token" model). Built-in sentinels (the verify/Decider contract) live in code
 * and can't be edited or deleted; custom constants live in `desktop.sqlite`.
 *
 * Pure + DB helpers, no Express. The router (loops-router) and the engine
 * (loop-run-manager, via loadConstantMap) are the only consumers.
 */
import type { DbInstance } from './db'

/** The canonical hardened anti-gaming contract. Templates that mutate code/tests
 *  drag `{{const:GUARDRAILS}}` so the agent cannot quietly cheat its own exit
 *  condition. Read-only (a built-in) on purpose: an editable guardrails block
 *  could be weakened to defeat its own point. */
/** The transport supervises background tasks, but pipeline work should be
 * joined by its parent before replying. Also applies to architect/developer
 * subagents: starting an Agent is not completion of the implementation step. */
export const FOREGROUND_RULE =
  'Run every command and subagent in the FOREGROUND and wait for it to finish. Never background a command or Agent/Task (no run_in_background, no trailing `&`, no "I will report when it lands"). If work is already running in the background, collect its result with a blocking wait (TaskOutput with block=true, or the provider equivalent), then continue the original workflow through implementation and verification. Do not launch duplicate workers or treat delegation, planning, or a waiting message as completion. If a command is slow, wait for it anyway.'

const GUARDRAILS_CONTRACT = [
  'Guardrails — do NOT violate these to satisfy the exit condition:',
  '- Do not modify the check command, the exit criteria, or the goal to force success.',
  '- Do not skip, disable, comment out, or otherwise bypass any check.',
  '- Do not weaken, delete, or skip tests, and do not replace real assertions with always-pass tests.',
  '- Prefer fixing the production code over patching the tests to go green.',
  '- If you are stuck after several iterations, stop and report the blockers instead of gaming the metric.',
  `- ${FOREGROUND_RULE}`,
].join('\n')

/** The per-pass iteration discipline for "one item at a time" loops (strict TDD,
 *  story executors, one-by-one upgrades). It stops a capable agent from
 *  front-loading the whole feature into a single pass — which collapses the loop
 *  to one iteration and defeats its per-item audit trail. */
const ONE_PER_PASS_CONTRACT = [
  'Do EXACTLY one unit of work in this pass — only the single item you selected.',
  'Do NOT start, implement, or fix any other item the spec or list describes — the loop runs again and will pick the next one. Front-loading several items into one pass defeats the loop.',
].join('\n')

/** How a per-item loop reports what is left, so the Loop Decider can stop at the
 *  right pass. The key distinction: a behavior is "remaining" only when its
 *  IMPLEMENTATION is missing (a failing test could target it) — NOT when it is
 *  already implemented but merely lacks a dedicated unit test. Listing
 *  already-working behavior as remaining just burns an extra (no-op) pass. */
const REMAINING_RULE_CONTRACT = [
  'End your reply with a single final line:',
  '- `REMAINING: <behavior>; <behavior>` — listing ONLY spec behaviors whose IMPLEMENTATION is still missing (ones a failing test could target);',
  '- or exactly `REMAINING: none` when every behavior the spec describes is implemented.',
  'A behavior that already works is NOT remaining — even if it has no dedicated unit test, or is a UI/integration behavior that cannot be red-tested in isolation. Never list already-working behavior as remaining.',
].join('\n')

/** The conflict-resolution guardrail for the AI merge-resolver ({{cmd:resolve-merge}}).
 *  Load-bearing for parallel rails: most merge conflicts when N specs integrate
 *  are trivial add-add (two new lines in a shared registry/barrel) — this contract
 *  keeps the resolver from "resolving" by deleting one branch's work, and forces an
 *  escalation when the merge is non-obvious so a human decides instead of a guess. */
const MERGE_SAFE_CONTRACT = [
  'You are resolving a git merge conflict. Edit ONLY within the conflict markers — touch nothing else in the file or repo.',
  '- For ADDITIVE conflicts (both sides added different lines at the same place), KEEP BOTH sides.',
  "- NEVER delete, overwrite, or weaken either branch's code to make the conflict go away.",
  '- Do NOT introduce new behaviour, refactors, or formatting changes while resolving.',
  '- If the correct resolution is not obvious, do NOT guess — leave it unresolved and end with `RESOLVE: needs-review`.',
  'When you resolve cleanly, remove the conflict markers and end with `RESOLVE: done`.',
].join('\n')

/** Read-only built-ins. `VERIFICATION_PASS/FAIL` are the sentinel strings that
 *  `{{cmd:verify}}` emits and the Loop Decider reads — keeping them as constants
 *  means a Decider goal can drag the exact contract string instead of retyping.
 *  `GUARDRAILS` is the anti-gaming contract; `ONE_PER_PASS` is the per-item
 *  iteration discipline — both injected by templates. */
export const BUILTIN_CONSTANTS: Record<string, string> = {
  VERIFICATION_PASS: 'VERIFICATION: PASS',
  VERIFICATION_FAIL: 'VERIFICATION: FAIL',
  GUARDRAILS: GUARDRAILS_CONTRACT,
  ONE_PER_PASS: ONE_PER_PASS_CONTRACT,
  REMAINING_RULE: REMAINING_RULE_CONTRACT,
  MERGE_SAFE: MERGE_SAFE_CONTRACT,
}

/** Token names: letters, digits, `_ . -`. Mirrors what the resolver matches. */
export const CONSTANT_NAME_RE = /^[A-Za-z0-9_.-]+$/
const CONST_TOKEN_RE = /\{\{const:([A-Za-z0-9_.-]+)\}\}/g

export interface LoopConstant {
  id: string
  name: string
  value: string
  /** True for the read-only built-ins; absent/false for user constants. */
  builtin?: boolean
}

export type LoopConstantErrorCode = 'invalid_name' | 'reserved_name' | 'duplicate' | 'not_found' | 'missing_value'
export class LoopConstantError extends Error {
  constructor(public code: LoopConstantErrorCode, message: string) {
    super(message)
    this.name = 'LoopConstantError'
  }
}

interface ConstantRow { id: string; name: string; value: string }

/** Built-ins first, then custom constants alphabetically. */
export function listConstants(db: DbInstance): LoopConstant[] {
  const custom = (db.prepare('SELECT id, name, value FROM loop_constants ORDER BY name').all() as ConstantRow[])
    .map((r) => ({ id: r.id, name: r.name, value: r.value }))
  const builtins = Object.entries(BUILTIN_CONSTANTS).map(([name, value]) => ({ id: `builtin:${name}`, name, value, builtin: true }))
  return [...builtins, ...custom]
}

/** Flat name→value map (built-ins + custom) for run-time `{{const:*}}` resolution. */
export function loadConstantMap(db: DbInstance): Record<string, string> {
  const map: Record<string, string> = { ...BUILTIN_CONSTANTS }
  for (const r of db.prepare('SELECT name, value FROM loop_constants').all() as { name: string; value: string }[]) {
    map[r.name] = r.value
  }
  return map
}

/** Replace every `{{const:NAME}}` with its value; unknown/deleted names resolve to
 *  '' (never leak the literal token to the model — same stance as `{{spec.*}}`). */
export function resolveConstants(text: string, map: Record<string, string>): string {
  return text.replace(CONST_TOKEN_RE, (_m, name: string) => map[name] ?? '')
}

function assertValidName(name: string): void {
  if (!name || !CONSTANT_NAME_RE.test(name)) {
    throw new LoopConstantError('invalid_name', 'Constant name may contain only letters, digits, "_", ".", "-".')
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_CONSTANTS, name)) {
    throw new LoopConstantError('reserved_name', `"${name}" is a built-in constant and cannot be redefined.`)
  }
}

export function createConstant(db: DbInstance, input: { id: string; name: string; value: string }): LoopConstant {
  assertValidName(input.name)
  if (typeof input.value !== 'string' || input.value.length === 0) {
    throw new LoopConstantError('missing_value', 'Constant value is required.')
  }
  const exists = db.prepare('SELECT 1 FROM loop_constants WHERE name = ?').get(input.name)
  if (exists) throw new LoopConstantError('duplicate', `A constant named "${input.name}" already exists.`)
  db.prepare('INSERT INTO loop_constants (id, name, value) VALUES (?, ?, ?)').run(input.id, input.name, input.value)
  return { id: input.id, name: input.name, value: input.value }
}

/** Only the VALUE is editable — the name is the token key (immutable) so existing
 *  `{{const:NAME}}` references never dangle. */
export function updateConstant(db: DbInstance, id: string, value: string): LoopConstant {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LoopConstantError('missing_value', 'Constant value is required.')
  }
  const row = db.prepare('SELECT id, name FROM loop_constants WHERE id = ?').get(id) as { id: string; name: string } | undefined
  if (!row) throw new LoopConstantError('not_found', 'Constant not found.')
  db.prepare("UPDATE loop_constants SET value = ?, updated_at = datetime('now') WHERE id = ?").run(value, id)
  return { id, name: row.name, value }
}

export function deleteConstant(db: DbInstance, id: string): boolean {
  return db.prepare('DELETE FROM loop_constants WHERE id = ?').run(id).changes > 0
}
