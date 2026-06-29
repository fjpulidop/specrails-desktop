/**
 * Specrails-owned loop templates — starter graphs the user clones into a Draft
 * ("Use template"). Authored from scratch (own text + own naming); they encode
 * common closed-loop patterns and are native to Specrails (they use the
 * `{{spec.*}}` interpolation tokens, the `{{cmd:*}}` magic commands, and the
 * Loop Decider node). No third-party content is bundled.
 *
 * Design: templates are composed of PROMPT pieces executed by the agent — they
 * do NOT hardcode Shell commands (e.g. `npm test`). Verification is agent-driven:
 * the AI step detects the project's tooling and runs the right command for the
 * stack, so a template works on any repo regardless of test runner. (The Shell
 * node type still exists for power users; the starters just don't depend on it.)
 *
 * Each template is a fully-publishable graph (passes validateLoopGraph).
 */
import type { LoopGraph } from './loop-graph'
import { PORTED_TEMPLATES } from './loop-templates-ported'

/** Closed taxonomy a template's `category` must belong to. Single source of truth
 *  for the gallery's category chips (the client derives its chip list from the
 *  categories actually present in the served catalog). */
export const LOOP_CATEGORIES = [
  'API', 'Automation', 'CI', 'Database', 'Debugging', 'DevOps', 'Docs', 'Git',
  'Maintenance', 'Performance', 'Planning', 'Quality', 'Review', 'Security', 'Testing',
] as const
export type LoopCategory = (typeof LOOP_CATEGORIES)[number]

export interface LoopTemplate {
  id: string
  name: string
  description: string
  /** Discovery category (one of LOOP_CATEGORIES) — drives the gallery chips. */
  category: LoopCategory
  /** Topic tags, surfaced in the gallery. */
  tags: string[]
  /** True ONLY for loops that provably never write the repo (PR/CI watchers,
   *  read-only audits). Drives parallel-rail isolation: read-only loops are NOT
   *  worktree-isolated (nothing to collide). Absent/false ⇒ treated as mutating
   *  (the safe default; a false read-only would corrupt the shared tree). */
  readOnly?: boolean
  graph: LoopGraph
}

/** Declarative shape for a ported starter loop. Compiled to a validated graph by
 *  `compilePortSpec` so every template is structurally consistent. The `steps`
 *  are Specrails-authored prompts (may embed `{{cmd:*}}` / `{{const:*}}` /
 *  `{{spec.*}}`); `goal` is the Decider's exit condition. */
export interface PortSpec {
  id: string
  name: string
  description: string
  category: LoopCategory
  tags: string[]
  steps: string[]
  goal: string
  maxIterations?: number
  /** Wall-clock cap for the whole run, in minutes (default 30). Raise it for
   *  strict per-item loops that legitimately need many passes (e.g. strict TDD). */
  timeoutMinutes?: number
  /** 'verify' ⇒ fixLoopGraph shape (main steps run once, then verify→fix→verify).
   *  'last' (default) ⇒ aiLoopGraph re-running only the LAST step (single-concern
   *  gate loops). 'first' ⇒ aiLoopGraph re-running the WHOLE body from step 1
   *  (iterate one item per pass until the spec is fully covered: TDD, story
   *  executors, one-by-one upgrades). */
  loopBack?: 'last' | 'verify' | 'first'
  /** See LoopTemplate.readOnly — default-false (mutating). */
  readOnly?: boolean
}

/** Compile a PortSpec into a publishable LoopTemplate (graph passes validation,
 *  no Shell nodes, exactly one continue+stop Decider branch — by construction). */
export function compilePortSpec(spec: PortSpec): LoopTemplate {
  const graph =
    spec.loopBack === 'verify'
      ? fixLoopGraph(spec.steps, spec.goal, spec.maxIterations ?? 12, spec.timeoutMinutes ?? 30)
      : aiLoopGraph(spec.steps, spec.goal, spec.maxIterations ?? 10, spec.loopBack === 'first' ? 'first' : 'last', spec.timeoutMinutes ?? 30)
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    tags: spec.tags,
    ...(spec.readOnly ? { readOnly: true } : {}),
    graph,
  }
}

/** Helper: a linear chain of AI steps closed by a Loop Decider. The decider's
 *  "continue" edge loops back to the LAST step (the verify/fix step) — so a retry
 *  re-verifies and fixes WITHOUT re-running the (expensive) earlier steps like
 *  implement; "stop" exits via the End node. Single-step loops simply re-run that
 *  one step until the goal is met. No Shell nodes — verification is agent-driven. */
// Layout grammar (shared by both builders): the main flow is a single vertical
// SPINE down the left column (x=0). The Decider sits at the bottom of the spine;
// its 'stop' output drops straight DOWN to the End node, and its 'continue'
// output exits to the RIGHT and arcs back up to the loop-back step — so the two
// branches never overlap and the loop reads as a clean rectangle on the canvas.
const COL_X = 0
const COL_RIGHT_X = 280
const ROW_GAP = 110

export function aiLoopGraph(
  prompts: string[],
  deciderGoal: string,
  maxIterations = 10,
  loopBackTo: 'first' | 'last' = 'last',
  timeoutMinutes = 30,
): LoopGraph {
  const lastAi = `ai-${prompts.length}`
  // Where the Decider's 'continue' edge returns. 'last' (default) re-runs only the
  // final step — right for single-concern "re-run the gate until clean" loops.
  // 'first' re-runs the WHOLE body from step 1 — right for "iterate one item per
  // pass until the spec is fully covered" loops (TDD, story executors, one-by-one
  // upgrades) where each pass must re-pick the next item.
  const continueTarget = loopBackTo === 'first' ? 'ai-1' : lastAi
  const decideRow = prompts.length + 1
  const nodes: LoopGraph['nodes'] = [
    { id: 'start', type: 'start', position: { x: COL_X, y: 0 } },
    ...prompts.map((prompt, i) => ({
      id: `ai-${i + 1}`,
      type: 'ai-step' as const,
      position: { x: COL_X, y: ROW_GAP * (i + 1) },
      data: { prompt },
    })),
    { id: 'decide', type: 'decider', position: { x: COL_X, y: ROW_GAP * decideRow }, data: { goal: deciderGoal } },
    { id: 'done', type: 'end', position: { x: COL_X, y: ROW_GAP * (decideRow + 1) }, data: { outcome: 'success' } },
  ]
  const edges: LoopGraph['edges'] = [
    { id: 'e-start', source: 'start', target: 'ai-1' },
    ...prompts.slice(0, -1).map((_p, i) => ({ id: `e-ai-${i + 1}`, source: `ai-${i + 1}`, target: `ai-${i + 2}` })),
    { id: 'e-to-decide', source: lastAi, target: 'decide' },
    { id: 'e-continue', source: 'decide', target: continueTarget, branch: 'continue' }, // not-done → loop back (first step or last per loopBackTo)
    { id: 'e-stop', source: 'decide', target: 'done', branch: 'stop' }, // done → exit down
  ]
  return { nodes, edges, config: { maxIterations, timeoutMinutes } }
}

/** Helper: a FULLY-AUTONOMOUS implement-and-fix loop. The `main` steps run ONCE,
 *  then `{{cmd:verify}}` runs; if the Decider says not-done it routes to
 *  `{{cmd:fix}}` (refinement) and RE-verifies — `verify → fix → verify → …` until
 *  the verification passes. No human in the loop. (main may be empty for a
 *  verify-only loop.) */
export function fixLoopGraph(mainPrompts: string[], deciderGoal: string, maxIterations = 12, timeoutMinutes = 30, aiStepTimeoutMinutes?: number): LoopGraph {
  const nodes: LoopGraph['nodes'] = [{ id: 'start', type: 'start', position: { x: COL_X, y: 0 } }]
  let row = 1
  mainPrompts.forEach((prompt, i) => {
    nodes.push({ id: `main-${i + 1}`, type: 'ai-step', position: { x: COL_X, y: ROW_GAP * row++ }, data: { prompt } })
  })
  const verifyRow = row++
  const decideRow = row++
  nodes.push({ id: 'verify', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * verifyRow }, data: { prompt: '{{cmd:verify}}' } })
  nodes.push({ id: 'decide', type: 'decider', position: { x: COL_X, y: ROW_GAP * decideRow }, data: { goal: deciderGoal } })
  // `fix` sits to the RIGHT of the Decider (clean horizontal 'continue' edge);
  // it arcs back UP to `verify` to re-check. `done` drops straight below.
  nodes.push({ id: 'fix', type: 'ai-step', position: { x: COL_RIGHT_X, y: ROW_GAP * decideRow }, data: { prompt: '{{cmd:fix}}' } })
  nodes.push({ id: 'done', type: 'end', position: { x: COL_X, y: ROW_GAP * row }, data: { outcome: 'success' } })

  const firstId = mainPrompts.length ? 'main-1' : 'verify'
  const edges: LoopGraph['edges'] = [{ id: 'e-start', source: 'start', target: firstId }]
  mainPrompts.forEach((_p, i) => {
    const next = i + 1 < mainPrompts.length ? `main-${i + 2}` : 'verify'
    edges.push({ id: `e-main-${i + 1}`, source: `main-${i + 1}`, target: next })
  })
  edges.push({ id: 'e-verify', source: 'verify', target: 'decide' })
  edges.push({ id: 'e-fix', source: 'decide', target: 'fix', branch: 'continue' }) // not-done → refine (exits right)
  edges.push({ id: 'e-refix', source: 'fix', target: 'verify' }) // then re-verify (arcs back up)
  edges.push({ id: 'e-stop', source: 'decide', target: 'done', branch: 'stop' }) // green → exit (drops down)
  return { nodes, edges, config: { maxIterations, timeoutMinutes, ...(aiStepTimeoutMinutes != null ? { aiStepTimeoutMinutes } : {}) } }
}

// ── OpenSpec lifecycle loop ──────────────────────────────────────────────────
// A hand-authored graph (NOT a PortSpec) because it combines an AI-step spine, a
// Decider, a `shell` archive node, AND a terminal action on the Decider's `stop`
// branch — a shape the stock aiLoopGraph/fixLoopGraph builders do not produce.
// Per iteration: opsx:ff → opsx:apply → opsx:verify → Decider. The Decider stops
// when verify reports PASS (→ unattended `openspec archive <id> -y` shell node);
// otherwise it loops back to opsx:ff, which AMENDS the same change ({{run.changeId}}
// captured by the engine from ff's first-pass output) using the gaps verify found.
const OPSX_FF_PROMPT = [
  '{{cmd:opsx:ff}} {{spec.title}}',
  '',
  '{{spec.description}}',
  '',
  'If a change id appears here — "{{run.changeId}}" — an OpenSpec change for this ticket already exists: CONTINUE that change (do NOT create a new one) and address only what the verification reported as still missing (see the context below). If it is blank, create the change and generate all required artifacts.',
  '',
  'Run fully unattended: make reasonable decisions to keep momentum and NEVER stop to ask — there is no human to answer. When something is unclear, pick the most sensible option, proceed, and note the assumption.',
].join('\n')

const OPSX_APPLY_PROMPT = [
  '{{cmd:opsx:apply}}',
  '',
  'Implement every pending task of the active OpenSpec change for ticket "{{spec.title}}", editing code as needed and marking tasks complete as you finish them.',
  '',
  'Run fully unattended: decide and keep momentum, never pause to ask. If you hit an ambiguity or blocker, make the most reasonable choice, implement it, and continue.',
].join('\n')

const OPSX_VERIFY_PROMPT = [
  '{{cmd:opsx:verify}}',
  '',
  'Verify the active OpenSpec change against its specs, design, and tasks for ticket "{{spec.title}}". Be strict and honest — inspect the REAL code and tests, not any step\'s self-report.',
  '',
  'Finish with a clear final line: exactly `{{const:VERIFICATION_PASS}}` when the change fully matches the ticket with nothing required missing, or `{{const:VERIFICATION_FAIL}} — <what is still missing>` otherwise.',
].join('\n')

const OPSX_DECIDER_GOAL =
  'The verify step reported {{const:VERIFICATION_PASS}} — the implementation fully matches ticket "{{spec.title}}" and nothing required is missing.'

/** The OpenSpec-lifecycle graph (see comment above). Exported for unit testing. */
export function opsxLifecycleGraph(): LoopGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: COL_X, y: 0 } },
      { id: 'ff', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * 1 }, data: { label: 'opsx:ff', prompt: OPSX_FF_PROMPT } },
      { id: 'apply', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * 2 }, data: { label: 'opsx:apply', prompt: OPSX_APPLY_PROMPT } },
      { id: 'verify', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * 3 }, data: { label: 'opsx:verify', prompt: OPSX_VERIFY_PROMPT } },
      { id: 'decide', type: 'decider', position: { x: COL_X, y: ROW_GAP * 4 }, data: { goal: OPSX_DECIDER_GOAL } },
      // Unattended archive: deterministic CLI, no AI, no prompt. `requireRunVars`
      // makes the engine REFUSE to run if no change id was captured (never archive
      // an unknown change); `openspec archive -y` syncs the main specs by default.
      { id: 'archive', type: 'shell', position: { x: COL_X, y: ROW_GAP * 5 }, data: { label: 'archive', command: 'openspec archive {{run.changeId}} -y', requireRunVars: ['changeId'] } },
      { id: 'done', type: 'end', position: { x: COL_X, y: ROW_GAP * 6 }, data: { outcome: 'success' } },
    ],
    edges: [
      { id: 'e-start', source: 'start', target: 'ff' },
      { id: 'e-ff', source: 'ff', target: 'apply' },
      { id: 'e-apply', source: 'apply', target: 'verify' },
      { id: 'e-verify', source: 'verify', target: 'decide' },
      // not-done (verify FAIL) → loop back to ff (firstStepId ⇒ session resets, the
      // pass re-reads disk; verify's gaps ride in the injected history).
      { id: 'e-continue', source: 'decide', target: 'ff', branch: 'continue' },
      // done (verify PASS) → archive then end.
      { id: 'e-stop', source: 'decide', target: 'archive', branch: 'stop' },
      { id: 'e-archive', source: 'archive', target: 'done' },
    ],
    // Conservative bounds so a never-satisfied verify can't spin: at most 3 full
    // lifecycle passes; per-step cap raised (apply can implement a whole change).
    config: { maxIterations: 3, timeoutMinutes: 180, aiStepTimeoutMinutes: 45 },
  }
}

export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    id: 'opsx-lifecycle',
    name: 'OpenSpec Lifecycle',
    description: 'Single-agent, ticket-to-archive OpenSpec lifecycle: generate artifacts (opsx:ff) → implement (opsx:apply) → verify (opsx:verify); on a FAIL verdict loop back to amend the SAME change, on PASS archive it unattended. The artifact-centric counterpart to the implement pipeline. Claude-first — codex/gemini fall back to a generic prompt until OpenSpec ships their native opsx commands.',
    category: 'Automation',
    tags: ['Automation', 'openspec', 'lifecycle'],
    graph: opsxLifecycleGraph(),
  },
  {
    id: 'ship-and-green',
    name: 'Ship & Green',
    description: 'Fully autonomous: implement the spec, verify, and refine (fix) on failure — looping verify → fix → verify until everything is green. No human intervention.',
    category: 'CI',
    tags: ['CI', 'testing'],
    graph: fixLoopGraph(
      ['{{cmd:implement}}'],
      // Uses the built-in {{const:VERIFICATION_PASS}} so the Decider goal and the
      // sentinel {{cmd:verify}} emits stay in lock-step (resolved at run time).
      'The verification step reported {{const:VERIFICATION_PASS}} — the spec is implemented and all tests pass.'
    ),
  },
  {
    id: 'verify-pass',
    name: 'Verify Pass',
    description: 'Autonomous verify-and-fix: detect and run the project\'s build/lint/tests, then refine on failure — verify → fix → verify until green.',
    category: 'Testing',
    tags: ['testing', 'quality'],
    graph: fixLoopGraph(
      [],
      'The verification step reported {{const:VERIFICATION_PASS}} with no remaining issues.'
    ),
  },
  {
    id: 'ci-watch',
    name: 'CI Watch',
    description: 'Poll CI checks on the open PR (the agent uses the repo\'s CI tooling) until every check is green.',
    category: 'CI',
    tags: ['CI', 'DevOps'],
    graph: aiLoopGraph(
      ['Check the CI status of the current pull request using the repository\'s CI tooling (e.g. `gh pr checks`). Report whether every check has passed or is still running/failing.'],
      'Every CI check on the PR reports success.',
      20
    ),
  },
  {
    id: 'lint-and-fix',
    name: 'Lint & Fix',
    description: 'The agent detects and runs the project\'s linter and fixes every issue, iterating until the codebase is clean.',
    category: 'Quality',
    tags: ['quality', 'lint'],
    graph: aiLoopGraph(
      ['Detect this project\'s linter from its config and run it. Fix every issue it reports for spec "{{spec.title}}" (lint/format only — no behaviour change). Report whether the linter is now clean.'],
      'The linter reports zero errors and zero warnings.'
    ),
  },
  {
    id: 'type-safe',
    name: 'Type Safe',
    description: 'The agent detects and runs the project\'s type checker and resolves every error, iterating until it passes cleanly.',
    category: 'Quality',
    tags: ['quality', 'types'],
    graph: aiLoopGraph(
      ['Detect this project\'s type checker from its config and run it. Resolve every type error related to spec "{{spec.title}}" without `any`, ignore comments, or non-null assertions. Report whether it passes.'],
      'The type checker passes with zero errors and no suppressions were added.'
    ),
  },
  {
    id: 'coverage-climb',
    name: 'Coverage Climb',
    description: 'The agent runs the project\'s coverage tooling and adds focused tests until the thresholds pass.',
    category: 'Testing',
    tags: ['testing', 'coverage'],
    graph: aiLoopGraph(
      ['Detect this project\'s test/coverage tooling and run it with coverage. Add focused tests for the code implementing spec "{{spec.title}}" until the coverage gate passes; cover edge cases and error paths (tests must assert real behaviour). Report coverage status.'],
      'The coverage thresholds pass and the added tests assert meaningful behaviour.'
    ),
  },
  {
    id: 'build-fix',
    name: 'Build Fix',
    description: 'The agent detects and runs the project\'s production build and fixes compile/bundle errors until it is green.',
    category: 'CI',
    tags: ['CI', 'build'],
    graph: aiLoopGraph(
      ['Detect this project\'s production build command from its config and run it. Fix any compilation or bundling errors for spec "{{spec.title}}" without disabling type or build checks. Report whether the build succeeds.'],
      'The production build completes successfully with no errors.'
    ),
  },
  {
    id: 'deploy-check',
    name: 'Deploy Check',
    description: 'The agent polls the deployment/health status (using the project\'s deploy tooling) until the service reports healthy.',
    category: 'DevOps',
    tags: ['DevOps', 'deploy'],
    graph: aiLoopGraph(
      ['Check the latest deployment/health status using the repository\'s deploy tooling (e.g. `gh run list --workflow deploy`, a health endpoint). Report whether the deployment finished successfully and the service is healthy.'],
      'The latest deployment finished successfully and the service is healthy.',
      20
    ),
  },
  // Ported community-pattern starters (Specrails-authored), compiled from
  // declarative PortSpecs so the catalog spans every category in the taxonomy.
  ...PORTED_TEMPLATES.map(compilePortSpec),
]

export function getLoopTemplate(id: string): LoopTemplate | undefined {
  return LOOP_TEMPLATES.find((t) => t.id === id)
}
