import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'

/**
 * Flow -> Spec recipe (feedback-2026-10 Flow mode, arch section 4.8). The code
 * already exists — a Flow worktree the rail adopted — so the run DERIVES the
 * OpenSpec change instead of planning one, then proves it like Implement:
 *
 *   derive-change ─pass→ check (verify) ─pass→ reviewer → review policy ─true→ archive → verify → done
 *        │fail             │fail                               │false
 *        └→ one repair     └──────────→ findings ←─────────────┘
 *           visit                          │
 *                       correction budget (2 rounds) ─exhausted→ changes-requested
 *                                          │
 *                       fixer (developer, fixer stance, WRITE) ─no change→ changes-requested
 *                                          └→ derive again (the change is updated in place)
 *
 * Shape mirrors Core's reference definition
 * (`src/agent-runtime/engine/__fixtures__/flow-spec.json`): strict OpenSpec
 * validation and the archive preflight run INSIDE the `derive-change` piece,
 * so its `fail` outcome is the validation repair loop. Coverage gaps never
 * fail the piece; they reach the reviewer through `derivation.json`. A
 * rejected review or failing check is no longer a dead end: a bounded fixer
 * round repairs the code and tests, and the deriver re-syncs the artifacts
 * with the code. Only when the rounds are exhausted (or a round changes
 * nothing) does the run end at `changes-requested`, which Desktop presents as
 * "the reviewer requested changes" with Back to Flow and Relaunch.
 *
 * Desktop data only: the roles (`deriver`, `developer` in the fixer stance,
 * `reviewer`) and their instructions are Core's. Requires Core capability
 * `deriveChange: 1`.
 */

/** Relative to `.specrails/pipeline/<runId>/`; written by Desktop before launch. */
export const FLOW_SUMMARY_FILE = 'flow-summary.md'
/** Core's bound for the summary file (DERIVE_SUMMARY_LIMIT). */
export const FLOW_SUMMARY_LIMIT_BYTES = 32 * 1024
/** One repair visit of the deriver after a rejected derivation (reset by every correction round). */
export const FLOW_DERIVATION_REPAIRS = 1
/** Fixer rounds after a rejected review or a failing check before the run ends at `changes-requested`. */
export const FLOW_CORRECTION_ROUNDS = 2
/** The terminal of an exhausted (or fruitless) repair loop. */
export const FLOW_CHANGES_REQUESTED_END = 'changes-requested'
/** Its completion reason (Core's reference text; Desktop recognises the end by its node id, not this text). */
export const FLOW_CHANGES_REQUESTED_REASON = 'Flow → Spec: the reviewer requested changes that {{run.correctionRounds}} correction round(s) did not resolve. Latest findings: {{run.latestFindings}}'

/** OpenSpec change names: kebab-case, at most 64 characters (Core's `changeId`). */
export const FLOW_CHANGE_ID_MAX = 64
const FLOW_CHANGE_ID_FALLBACK = 'flow-change'

/** Kebab-case stem of a Flow spec title (diacritics folded, ≤64, cut at a word boundary). */
export function flowChangeIdStem(title: string | null | undefined): string {
  const kebab = (title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!kebab) return FLOW_CHANGE_ID_FALLBACK
  if (kebab.length <= FLOW_CHANGE_ID_MAX) return kebab
  const head = kebab.slice(0, FLOW_CHANGE_ID_MAX)
  if (kebab[FLOW_CHANGE_ID_MAX] === '-') return head
  const cut = head.lastIndexOf('-')
  return (cut >= 24 ? head.slice(0, cut) : head).replace(/-+$/, '')
}

/**
 * Who holds a candidate change name in the Flow worktree: `free`; `own` (an
 * ACTIVE change this Flow's earlier run derived — absent at the Flow base —
 * which a relaunch re-derives in place); `taken` (present at the base, or
 * already archived under that name).
 */
export type FlowChangeIdHolder = 'free' | 'own' | 'taken'

/**
 * The OpenSpec change a Flow → Spec run derives: named after the spec title,
 * never after addenda or the run id. A name another change already uses gets
 * `-2`, `-3`… (within 64 characters).
 */
export function flowChangeId(title: string | null | undefined, holder: (id: string) => FlowChangeIdHolder): string {
  const stem = flowChangeIdStem(title)
  for (let n = 1; n <= 99; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const id = `${stem.slice(0, FLOW_CHANGE_ID_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (holder(id) !== 'taken') return id
  }
  throw new Error(`No free OpenSpec change name for "${stem}"`)
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'summary', 'issues', 'score'],
  properties: {
    approved: { type: 'boolean' },
    summary: { type: 'string' },
    issues: { type: 'array', maxItems: 100, items: { type: 'string' } },
    score: { type: 'number', minimum: 0, maximum: 100 },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'incomplete'],
  properties: {
    summary: { type: 'string' },
    incomplete: { type: 'array', maxItems: 100, items: { type: 'string' } },
  },
}

export function flowSpecGraph(): LoopGraph {
  const change = '{{run.changeId}}'
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }]
  const edges: LoopGraph['edges'] = []
  const node = (id: string, label: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>, x = 0) => {
    nodes.push({ id, type: 'core', position: { x, y: nodes.length * 140 }, data: { kind, label, params } })
    for (const [outcome, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${outcome}`, source: id, target, label: outcome })
  }
  node('init', 'Initialize repair budgets', 'assign', { set: { derivationRepairs: 0, correctionRounds: 0, correctionLimit: FLOW_CORRECTION_ROUNDS, latestFindings: '' } }, { next: 'derive', failed: 'failed' })
  node('derive', 'Derive OpenSpec change', 'derive-change', { change, summaryPath: FLOW_SUMMARY_FILE, feedback: '{{run.latestFindings}}' }, { pass: 'check', fail: 'repair-guard' })
  node('repair-guard', 'Repair the derivation once', 'condition', { expr: `$vars.derivationRepairs < ${FLOW_DERIVATION_REPAIRS}` }, { true: 'repair-count', false: 'failed' }, 360)
  node('repair-count', 'Count derivation repair', 'assign', { increment: { derivationRepairs: 1 } }, { next: 'derive', failed: 'failed' }, 360)
  node('check', 'Verify derived candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'derive' }, { pass: 'review', fail: 'check-findings', failed: 'failed' })
  node('check-findings', 'Capture failing verification', 'assign', { set: { latestFindings: 'Host verification failed for the current candidate: {{outputs.check}}' } }, { next: 'correction-budget', failed: 'failed' }, 720)
  node('review', 'Reviewer', 'role-turn', {
    roleId: 'reviewer',
    prompt: [
      `Review OpenSpec change ${change}, derived from code that already exists in this worktree (a Flow session built it with the user).`,
      'Judge whether the derived proposal, design, delta specs and checked tasks describe the real code faithfully: no invented requirements, nothing material left out.',
      'Derivation coverage measured by Core (every changed file must appear in design.md "## Blast radius"): {{outputs.derive.derivation}}.',
      'Treat EVERY file in unexplainedFiles as an issue. Inspect the real code and the host verification evidence: {{outputs.check}}.',
      'Every issue must be actionable by a fixer (code or tests) or by the deriver (artifacts): name the file and what must change.',
      'Return approved, summary, issues (empty when none) and score (0-100).',
    ].join(' '),
    structuredOutput: REVIEW_SCHEMA,
    sessionContinuity: 'none',
  }, { next: 'review-policy', invalid: 'failed', failed: 'failed' })
  node('review-policy', 'Review acceptance policy', 'condition', { expr: '$outputs.review.structured.approved == true' }, { true: 'archive', false: 'review-findings' })
  node('review-findings', 'Capture review findings', 'assign', { set: { latestFindings: '{{outputs.review.structured}}' } }, { next: 'correction-budget', failed: 'failed' }, 720)
  node('correction-budget', 'Check the correction budget', 'condition', { expr: '$vars.correctionRounds < $vars.correctionLimit' }, { true: 'begin-correction', false: FLOW_CHANGES_REQUESTED_END }, 720)
  node('begin-correction', 'Count correction round', 'assign', { increment: { correctionRounds: 1 }, set: { derivationRepairs: 0 } }, { next: 'fix', failed: 'failed' }, 720)
  node('fix', 'Fixer', 'role-turn', {
    roleId: 'developer',
    stance: 'fixer',
    prompt: [
      `Correct the code a Flow session built for OpenSpec change ${change} so the review can approve it.`,
      'Findings to resolve (the reviewer\'s structured verdict, or the failing host verification): {{run.latestFindings}}.',
      'Fix the defects the findings name. Add or extend the tests the findings ask for; creating a test file is allowed for that.',
      'Tag every test that demonstrates an ADDED or MODIFIED requirement of the change\'s delta specs with `[spec:<capability>/<requirement-slug>]` in its title.',
      'Never expand scope: no new features, effects, options or behaviour.',
      'Do not edit anything under openspec/: Core re-derives proposal, design, specs and tasks from the code after your turn, so a finding about the artifacts needs no code change.',
      'Revert code only when a finding says the behaviour was unrequested AND contradicts a stated Non-Goal.',
      'Return summary and incomplete (each finding you could not resolve, with the reason).',
    ].join(' '),
    structuredOutput: FIX_SCHEMA,
    sessionContinuity: 'none',
  }, { next: 'fix-progress', invalid: 'failed', failed: 'failed' }, 720)
  node('fix-progress', 'Check the correction changed the candidate', 'condition', { expr: 'exists($outputs.fix.candidateHash) && $outputs.fix.candidateHash != null && $outputs.fix.candidateHash != $outputs.check.candidateHash' }, { true: 'derive', false: FLOW_CHANGES_REQUESTED_END }, 720)
  node('archive', 'Archive OpenSpec', 'openspec-archive', { change, requiresVerified: true }, { next: 'verify', failed: 'failed' })
  node('verify', 'Verify archived candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'derive' }, { pass: 'done', fail: 'failed', failed: 'failed' })
  nodes.push(
    { id: 'done', type: 'end', position: { x: 0, y: nodes.length * 140 }, data: { outcome: 'success', requiresVerified: true } },
    { id: 'failed', type: 'end', position: { x: 360, y: nodes.length * 140 }, data: { outcome: 'failure' } },
    { id: FLOW_CHANGES_REQUESTED_END, type: 'end', position: { x: 720, y: nodes.length * 140 }, data: { outcome: 'failure', reason: FLOW_CHANGES_REQUESTED_REASON } },
  )
  edges.unshift({ id: 'e-start', source: 'start', target: 'init' })
  return {
    nodes,
    edges,
    config: {
      maxIterations: 12,
      maxTransitions: 100,
      timeoutMinutes: 0,
      aiStepTimeoutMinutes: 0,
      change: 'new',
      journal: 'ledger-only',
      reviewerStepId: 'review',
    },
  }
}
