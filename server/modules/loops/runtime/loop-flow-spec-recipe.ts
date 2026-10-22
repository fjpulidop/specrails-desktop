import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'

/**
 * Flow -> Spec recipe (feedback-2026-10 Flow mode, arch section 4.8). The code
 * already exists — a Flow worktree the rail adopted — so the run DERIVES the
 * OpenSpec change instead of planning one, then proves it like Implement:
 *
 *   derive-change ─pass→ verify (deriver proposals) → reviewer → review policy
 *        │fail                → openspec-archive → verify archived candidate
 *        └→ one repair visit (the piece hands its rejection back to the deriver)
 *
 * Shape mirrors Core's reference definition
 * (`src/agent-runtime/engine/__fixtures__/flow-spec.json`, Core PR #438):
 * strict OpenSpec validation and the archive preflight run INSIDE the
 * `derive-change` piece, so its `fail` outcome is the validation repair loop
 * (no separate `openspec-validate` node). Coverage gaps never fail the piece;
 * they reach the reviewer through `derivation.json`.
 *
 * Desktop data only: the roles (`deriver`, `reviewer`) and their instructions
 * are Core's. Requires Core capability `deriveChange: 1`.
 */

/** Relative to `.specrails/pipeline/<runId>/`; written by Desktop before launch. */
export const FLOW_SUMMARY_FILE = 'flow-summary.md'
/** Core's bound for the summary file (DERIVE_SUMMARY_LIMIT). */
export const FLOW_SUMMARY_LIMIT_BYTES = 32 * 1024
/** One repair visit of the deriver after a rejected derivation. */
export const FLOW_DERIVATION_REPAIRS = 1

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

export function flowSpecGraph(): LoopGraph {
  const change = '{{run.changeId}}'
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }]
  const edges: LoopGraph['edges'] = []
  const node = (id: string, label: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>, x = 0) => {
    nodes.push({ id, type: 'core', position: { x, y: nodes.length * 140 }, data: { kind, label, params } })
    for (const [outcome, target] of Object.entries(outcomes)) edges.push({ id: `e-${id}-${outcome}`, source: id, target, label: outcome })
  }
  node('init', 'Initialize derivation repairs', 'assign', { set: { derivationRepairs: 0 } }, { next: 'derive', failed: 'failed' })
  node('derive', 'Derive OpenSpec change', 'derive-change', { change, summaryPath: FLOW_SUMMARY_FILE }, { pass: 'check', fail: 'repair-guard' })
  node('repair-guard', 'Repair the derivation once', 'condition', { expr: `$vars.derivationRepairs < ${FLOW_DERIVATION_REPAIRS}` }, { true: 'repair-count', false: 'failed' }, 360)
  node('repair-count', 'Count derivation repair', 'assign', { increment: { derivationRepairs: 1 } }, { next: 'derive', failed: 'failed' }, 360)
  node('check', 'Verify derived candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'derive' }, { pass: 'review', fail: 'failed', failed: 'failed' })
  node('review', 'Reviewer', 'role-turn', {
    roleId: 'reviewer',
    prompt: [
      `Review OpenSpec change ${change}, derived from code that already exists in this worktree (a Flow session built it with the user).`,
      'Judge whether the derived proposal, design, delta specs and checked tasks describe the real code faithfully: no invented requirements, nothing material left out.',
      'Derivation coverage measured by Core (every changed file must appear in design.md "## Blast radius"): {{outputs.derive.derivation}}.',
      'Treat EVERY file in unexplainedFiles as an issue. Inspect the real code and the host verification evidence: {{outputs.check}}.',
      'Return approved, summary, issues (empty when none) and score (0-100).',
    ].join(' '),
    structuredOutput: REVIEW_SCHEMA,
    sessionContinuity: 'none',
  }, { next: 'review-policy', invalid: 'failed', failed: 'failed' })
  node('review-policy', 'Review acceptance policy', 'condition', { expr: '$outputs.review.structured.approved == true' }, { true: 'archive', false: 'failed' })
  node('archive', 'Archive OpenSpec', 'openspec-archive', { change, requiresVerified: true }, { next: 'verify', failed: 'failed' })
  node('verify', 'Verify archived candidate', 'verify', { commands: 'configured', additionalCommandsFrom: 'derive' }, { pass: 'done', fail: 'failed', failed: 'failed' })
  nodes.push(
    { id: 'done', type: 'end', position: { x: 0, y: nodes.length * 140 }, data: { outcome: 'success', requiresVerified: true } },
    { id: 'failed', type: 'end', position: { x: 360, y: nodes.length * 140 }, data: { outcome: 'failure' } },
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
