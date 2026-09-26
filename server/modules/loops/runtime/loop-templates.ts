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
import type { CoreNodeKind, LoopGraph, LoopNode } from './loop-graph'
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
 *  then the verification prompt (`{{cmd:verify}}` by default) runs; if the Decider says not-done it routes to
 *  `{{cmd:fix}}` (refinement) and RE-verifies — `verify → fix → verify → …` until
 *  the verification passes. No human in the loop. (main may be empty for a
 *  verify-only loop.)
 *
 *  `verificationPrompt` lets a caller own the gate with a dedicated command while
 *  KEEPING the node id `verify` (the Decider, the sentinel scan and every
 *  loop-step consumer key off that id). `isolatedVerificationCycle` marks the
 *  verify/fix pair as `freshSession`, so the gate never inherits the mutating
 *  step's provider conversation — its verdict describes the candidate on disk,
 *  not what the mutator remembers writing. */
export function fixLoopGraph(
  mainPrompts: string[],
  deciderGoal: string,
  maxIterations = 12,
  timeoutMinutes = 30,
  aiStepTimeoutMinutes?: number,
  verificationPrompt = '{{cmd:verify}}',
  isolatedVerificationCycle = false,
): LoopGraph {
  const nodes: LoopGraph['nodes'] = [{ id: 'start', type: 'start', position: { x: COL_X, y: 0 } }]
  let row = 1
  mainPrompts.forEach((prompt, i) => {
    nodes.push({ id: `main-${i + 1}`, type: 'ai-step', position: { x: COL_X, y: ROW_GAP * row++ }, data: { prompt } })
  })
  const verifyRow = row++
  const decideRow = row++
  nodes.push({
    id: 'verify',
    type: 'ai-step',
    position: { x: COL_X, y: ROW_GAP * verifyRow },
    data: {
      prompt: verificationPrompt,
      requireVerificationPass: true,
      ...(isolatedVerificationCycle ? { freshSession: true } : {}),
    },
  })
  nodes.push({ id: 'decide', type: 'decider', position: { x: COL_X, y: ROW_GAP * decideRow }, data: { goal: deciderGoal } })
  // `fix` sits to the RIGHT of the Decider (clean horizontal 'continue' edge);
  // it arcs back UP to `verify` to re-check. `done` drops straight below.
  nodes.push({
    id: 'fix',
    type: 'ai-step',
    position: { x: COL_RIGHT_X, y: ROW_GAP * decideRow },
    data: {
      prompt: '{{cmd:fix}}',
      ...(isolatedVerificationCycle ? { freshSession: true } : {}),
    },
  })
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
// Lightweight lifecycle: prepare → preflight → apply/test → validate artifacts → archive.
// CLI validation checks OpenSpec artifacts; Apply owns code tests and corrections.
const OPSX_FF_PROMPT = [
  '{{cmd:opsx:ff}} {{spec.title}}',
  '{{spec.description}}',
  'Target: "{{run.changeId}}" takes precedence over ticket metadata "{{spec.openspecChangeName}}". CONTINUE that exact OpenSpec change if active; create it if missing. If both are blank, choose a new name. Do not select unrelated changes or create a duplicate.',
  'Preparation ONLY: inspect the affected code and generate the required proposal/specs/design/tasks. Do not implement code or run the repository test suite in this phase.',
  'OpenSpec artifacts are authoritative: map the full requested spec (or each delta/addendum on delivered work) to tasks and an observable acceptance check. Keep artifacts proportional to the change; reference unchanged contracts instead of rewriting them. Do not invent extra work.',
  'Do NOT run `openspec archive` in this step. Leave the change ACTIVE and name that path in your final reply. Return a concise handoff: change path, affected files, decisions, and checks for Apply; do not repeat the spec or addendum bodies.',
  'Work unattended within the requested scope. Record assumptions; report a genuine blocker instead of expanding scope.',
  '{{const:GUARDRAILS}}',
].join('\n\n')

const OPSX_APPLY_PROMPT = [
  '{{cmd:opsx:apply}} {{run.changeId}}',
  'Implement the pending tasks of this exact change for "{{spec.title}}". Inspect the diff and tasks first; preserve completed work and keep edits within the requested scope.',
  'Before editing code, confirm the artifacts describe the requested contract; amend the OpenSpec artifacts first if needed. Do not re-plan the original feature.',
  'Run the relevant tests for each requested behavior and all repository-required checks. Expand testing for affected contracts or failures. Once checks pass, repeat them only after changes that could invalidate them; do not run unrelated optional suites.',
  'Inspect the final diff for omissions and regressions, mark completed tasks, and report concrete file/check evidence for every attached addendum. CLI validation checks artifacts, not implementation. Do not archive here — never run `openspec archive`.',
  'Finish with exactly `{{const:VERIFICATION_PASS}}` only after implementation and relevant checks succeed. Otherwise finish with `{{const:VERIFICATION_FAIL}} — <remaining work or failed checks>`.',
  '{{const:GUARDRAILS}}',
].join('\n\n')

/** The OpenSpec-lifecycle graph (see comment above). Exported for unit testing. */
export function opsxLifecycleGraph(): LoopGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: COL_X, y: 0 } },
      { id: 'ff', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * 1 }, data: { label: 'opsx:ff', prompt: OPSX_FF_PROMPT, stopOnFailure: true } },
      { id: 'preflight', type: 'shell', position: { x: COL_X, y: ROW_GAP * 2 }, data: { label: 'validate artifacts before implementation', stopOnFailure: true, command: 'openspec validate {{run.changeId}} --type change --strict --no-interactive', requireRunVars: ['changeId'], failureRecovery: { target: 'ff', maxRetries: 1, artifactOnly: true } } },
      { id: 'apply', type: 'ai-step', position: { x: COL_X, y: ROW_GAP * 3 }, data: { label: 'opsx:apply', prompt: OPSX_APPLY_PROMPT, requireVerificationPass: true, stopOnFailure: true, failureRecovery: { target: 'apply', maxRetries: 1 } } },
      { id: 'validate', type: 'shell', position: { x: COL_X, y: ROW_GAP * 4 }, data: { label: 'validate', stopOnFailure: true, command: 'openspec validate {{run.changeId}} --type change --strict --no-interactive', requireRunVars: ['changeId'], failureRecovery: { target: 'ff', maxRetries: 1, artifactOnly: true } } },
      // Unattended archive: deterministic CLI, no AI, no prompt. `requireRunVars`
      // makes the engine REFUSE to run if no change id was captured (never archive
      // an unknown change); `openspec archive -y` syncs the main specs by default.
      { id: 'archive', type: 'shell', position: { x: COL_X, y: ROW_GAP * 5 }, data: { label: 'archive', stopOnFailure: true, failureRecovery: { target: 'archive', maxRetries: 1 }, command: 'openspec archive {{run.changeId}} -y', requireRunVars: ['changeId'] } },
      { id: 'done', type: 'end', position: { x: COL_X, y: ROW_GAP * 6 }, data: { outcome: 'success' } },
    ],
    edges: [
      { id: 'e-start', source: 'start', target: 'ff' },
      { id: 'e-ff', source: 'ff', target: 'preflight' },
      { id: 'e-preflight', source: 'preflight', target: 'apply' },
      { id: 'e-apply', source: 'apply', target: 'validate' },
      { id: 'e-validate', source: 'validate', target: 'archive' },
      { id: 'e-archive', source: 'archive', target: 'done' },
    ],
    // Phase recovery is bounded per failing node, without an AI Decider. Like the other built-ins,
    // the run is UNTIMED (0 = no timeout) — apply can
    // implement a whole change and must never be killed mid-flight.
    config: { maxIterations: 3, timeoutMinutes: 0, aiStepTimeoutMinutes: 0 },
  }
}

// ── The eight named starters ─────────────────────────────────────────────────
// Prompt/goal text is shared by the legacy graphs (Desktop traversal, older Core)
// and the Core definition graphs below, so porting never silently rewrites the
// user-facing instructions. Iteration bounds are kept per starter as well.

/** Starters that ship as Core definition graphs when the selected Core advertises
 *  both `engineV2: 1` and `workflowDefinitions: 1` (same gate as the factories). */
export const CORE_STARTER_TEMPLATE_IDS = [
  'ship-and-green', 'verify-pass', 'ci-watch', 'lint-and-fix', 'type-safe', 'coverage-climb', 'build-fix', 'deploy-check',
] as const
export type CoreStarterTemplateId = (typeof CORE_STARTER_TEMPLATE_IDS)[number]

interface StarterText {
  /** Agent-facing task for the (single) working step. Empty for verify-only loops. */
  prompt: string
  /** The Decider's exit condition in the legacy graph; reused verbatim by Core deciders. */
  goal: string
  /** Legacy iteration cap (aiLoopGraph default 10 / fixLoopGraph default 12 / watchers 20). */
  maxIterations: number
}

const STARTER_TEXT: Record<CoreStarterTemplateId, StarterText> = {
  'ship-and-green': {
    prompt: '{{cmd:implement}}',
    // Uses the built-in {{const:VERIFICATION_PASS}} so the Decider goal and the
    // sentinel {{cmd:verify}} emits stay in lock-step (resolved at run time).
    goal: 'The verification step reported {{const:VERIFICATION_PASS}} — the spec is implemented and all tests pass.',
    maxIterations: 12,
  },
  'verify-pass': {
    prompt: '',
    goal: 'The verification step reported {{const:VERIFICATION_PASS}} with no remaining issues.',
    maxIterations: 12,
  },
  'ci-watch': {
    prompt: 'Check the CI status of the current pull request using the repository\'s CI tooling (e.g. `gh pr checks`). Report whether every check has passed or is still running/failing.',
    goal: 'Every CI check on the PR reports success.',
    maxIterations: 20,
  },
  'lint-and-fix': {
    prompt: 'Detect this project\'s linter from its config and run it. Fix every issue it reports for spec "{{spec.title}}" (lint/format only — no behaviour change). Report whether the linter is now clean.',
    goal: 'The linter reports zero errors and zero warnings.',
    maxIterations: 10,
  },
  'type-safe': {
    prompt: 'Detect this project\'s type checker from its config and run it. Resolve every type error related to spec "{{spec.title}}" without `any`, ignore comments, or non-null assertions. Report whether it passes.',
    goal: 'The type checker passes with zero errors and no suppressions were added.',
    maxIterations: 10,
  },
  'coverage-climb': {
    prompt: 'Detect this project\'s test/coverage tooling and run it with coverage. Add focused tests for the code implementing spec "{{spec.title}}" until the coverage gate passes; cover edge cases and error paths (tests must assert real behaviour). Report coverage status.',
    goal: 'The coverage thresholds pass and the added tests assert meaningful behaviour.',
    maxIterations: 10,
  },
  'build-fix': {
    prompt: 'Detect this project\'s production build command from its config and run it. Fix any compilation or bundling errors for spec "{{spec.title}}" without disabling type or build checks. Report whether the build succeeds.',
    goal: 'The production build completes successfully with no errors.',
    maxIterations: 10,
  },
  'deploy-check': {
    prompt: 'Check the latest deployment/health status using the repository\'s deploy tooling (e.g. `gh run list --workflow deploy`, a health endpoint). Report whether the deployment finished successfully and the service is healthy.',
    goal: 'The latest deployment finished successfully and the service is healthy.',
    maxIterations: 20,
  },
}

/** Legacy starter graphs (Desktop node traversal). Served whenever the selected
 *  Core does not advertise the definition engine; retained until D8. */
function legacyStarterGraph(id: CoreStarterTemplateId): LoopGraph {
  const { prompt, goal, maxIterations } = STARTER_TEXT[id]
  if (id === 'ship-and-green' || id === 'verify-pass') return fixLoopGraph(prompt ? [prompt] : [], goal, maxIterations)
  return aiLoopGraph([prompt], goal, maxIterations)
}

/** Legacy catalog: every starter as a Desktop-traversal graph. `LOOP_TEMPLATES`
 *  keeps this meaning for existing consumers; capability-aware callers use
 *  `loopTemplatesForCapabilities` / `getLoopTemplate(id, capabilities)`. */
export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    id: 'opsx-lifecycle',
    name: 'OpenSpec Lifecycle',
    description: 'Lightweight ticket-to-archive OpenSpec lifecycle: generate artifacts, implement and test, validate the change through the CLI, then archive it unattended. The artifact-centric counterpart to the implement pipeline. Claude-first — codex/gemini fall back to a generic prompt until OpenSpec ships their native opsx commands.',
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
    graph: legacyStarterGraph('ship-and-green'),
  },
  {
    id: 'verify-pass',
    name: 'Verify Pass',
    description: 'Autonomous verify-and-fix: detect and run the project\'s build/lint/tests, then refine on failure — verify → fix → verify until green.',
    category: 'Testing',
    tags: ['testing', 'quality'],
    graph: legacyStarterGraph('verify-pass'),
  },
  {
    id: 'ci-watch',
    name: 'CI Watch',
    description: 'Poll CI checks on the open PR (the agent uses the repo\'s CI tooling) until every check is green.',
    category: 'CI',
    tags: ['CI', 'DevOps'],
    graph: legacyStarterGraph('ci-watch'),
  },
  {
    id: 'lint-and-fix',
    name: 'Lint & Fix',
    description: 'The agent detects and runs the project\'s linter and fixes every issue, iterating until the codebase is clean.',
    category: 'Quality',
    tags: ['quality', 'lint'],
    graph: legacyStarterGraph('lint-and-fix'),
  },
  {
    id: 'type-safe',
    name: 'Type Safe',
    description: 'The agent detects and runs the project\'s type checker and resolves every error, iterating until it passes cleanly.',
    category: 'Quality',
    tags: ['quality', 'types'],
    graph: legacyStarterGraph('type-safe'),
  },
  {
    id: 'coverage-climb',
    name: 'Coverage Climb',
    description: 'The agent runs the project\'s coverage tooling and adds focused tests until the thresholds pass.',
    category: 'Testing',
    tags: ['testing', 'coverage'],
    graph: legacyStarterGraph('coverage-climb'),
  },
  {
    id: 'build-fix',
    name: 'Build Fix',
    description: 'The agent detects and runs the project\'s production build and fixes compile/bundle errors until it is green.',
    category: 'CI',
    tags: ['CI', 'build'],
    graph: legacyStarterGraph('build-fix'),
  },
  {
    id: 'deploy-check',
    name: 'Deploy Check',
    description: 'The agent polls the deployment/health status (using the project\'s deploy tooling) until the service reports healthy.',
    category: 'DevOps',
    tags: ['DevOps', 'deploy'],
    graph: legacyStarterGraph('deploy-check'),
  },
  // Ported community-pattern starters (Specrails-authored), compiled from
  // declarative PortSpecs so the catalog spans every category in the taxonomy.
  ...PORTED_TEMPLATES.map(compilePortSpec),
]

/** Explicit alias: the legacy (older Core / no engineV2) catalog. */
export const LEGACY_LOOP_TEMPLATES: readonly LoopTemplate[] = LOOP_TEMPLATES

// ── Core definition starters (engineV2 + workflowDefinitions) ────────────────
// Rules (CHECKPOINT-D1B-D5 "Still pending"):
// - watchers (ci-watch, deploy-check) are explicit `access: 'read'` prompts and
//   certify nothing (their success end has `requiresVerified: false`);
// - every mutating starter runs the real `verify` piece over the project's
//   configured checks and ends with `requiresVerified: true` — a passing sentinel
//   alone never reaches a success end;
// - ship-and-green = native `implementation` → verify → decider → prompt(fix) loop;
// - prompts, goals and iteration caps come from STARTER_TEXT (legacy parity).

/** Fix step shared by every mutating Core starter. Reuses the tuned `{{cmd:fix}}`
 *  contract and covers the verify→fix edge, where no Decider verdict precedes it. */
const CORE_FIX_PROMPT = [
  'Either the configured host verification failed or the Loop Decider judged the goal not yet met.',
  '{{cmd:fix}}',
  'If the verification findings are not visible above, run the project\'s configured checks (build, type-check, lint, tests) yourself first and act on their actual output. Never weaken, skip or disable a check to make it pass.',
].join('\n\n')

/** Read-only watcher verdict: the legacy Decider goal becomes the explicit sentinel rule. */
function watcherVerdict(goal: string): string {
  return [
    'Read-only: do not modify any file, branch, pull request or deployment.',
    `Finish with exactly \`{{const:VERIFICATION_PASS}}\` only when this holds: ${goal} Otherwise finish with \`{{const:VERIFICATION_FAIL}} — <what is still running or failing>\`.`,
  ].join('\n\n')
}

/** Evidence clause appended to legacy Decider goals: the Core decider only runs after
 *  the real `verify` piece passed, so it judges completeness, not check status. */
const CORE_GOAL_EVIDENCE = 'The configured host verification already passed on the current candidate before this decision. Judge only from concrete evidence in the history (commands run, their output, files changed); green baseline checks, setup or planning alone do not prove the goal.'

const SHIP_AND_GREEN_GOAL = 'Stop only when the history proves the spec is implemented: every acceptance criterion maps to real code and behavioral evidence across every selected ticket and repository, and the configured host verification passed on the current candidate. Setup, planning, a launched subagent or green baseline checks alone are insufficient; continue when work is missing or incomplete.'

/** Wall-clock cap for starters (legacy default). ship-and-green is untimed like the
 *  Implement factory: the native implementation piece runs the whole pipeline. */
const STARTER_TIMEOUT_MIN = 30

type CoreStarterShape = 'ship' | 'verify-fix' | 'quality' | 'watch'
const CORE_STARTER_SHAPES: Record<CoreStarterTemplateId, CoreStarterShape> = {
  'ship-and-green': 'ship',
  'verify-pass': 'verify-fix',
  'ci-watch': 'watch',
  'lint-and-fix': 'quality',
  'type-safe': 'quality',
  'coverage-climb': 'quality',
  'build-fix': 'quality',
  'deploy-check': 'watch',
}

/** Core definition graph for one of the eight starters. Deterministic: same id ⇒
 *  structurally identical graph (positions included). */
export function coreStarterGraph(id: CoreStarterTemplateId): LoopGraph {
  const shape = CORE_STARTER_SHAPES[id]
  const { prompt, goal, maxIterations } = STARTER_TEXT[id]
  const nodes: LoopNode[] = [{ id: 'start', type: 'start', position: { x: COL_X, y: 0 } }]
  const edges: LoopGraph['edges'] = []
  const piece = (nodeId: string, kind: CoreNodeKind, params: Record<string, unknown>, outcomes: Record<string, string>, x = COL_X) => {
    nodes.push({ id: nodeId, type: 'core', position: { x, y: ROW_GAP * nodes.length }, data: { kind, params } })
    for (const [label, target] of Object.entries(outcomes)) edges.push({ id: `e-${nodeId}-${label}`, source: nodeId, target, label })
  }
  const verify = (pass: string) => piece('verify', 'verify', { commands: 'configured' }, { pass, fail: 'fix', failed: 'failed' })
  const decide = (deciderGoal: string, next: string) =>
    piece('decide', 'decider', { roleId: 'loop-decider', goal: deciderGoal, noProgress: 3 }, { stop: 'done', continue: next, failed: 'failed' })
  const fix = () => piece('fix', 'prompt', { text: CORE_FIX_PROMPT, access: 'write' }, { next: 'verify', failed: 'failed' }, COL_RIGHT_X)
  let entry: string
  let config: LoopGraph['config'] = { maxIterations, timeoutMinutes: STARTER_TIMEOUT_MIN, journal: 'ledger-only', change: 'none' }
  let successEnd: Record<string, unknown> = { outcome: 'success', requiresVerified: true }
  if (shape === 'ship') {
    entry = 'implement'
    piece('implement', 'implementation', {}, { next: 'verify', rejected: 'failed', failed: 'failed' })
    verify('decide')
    decide(SHIP_AND_GREEN_GOAL, 'fix')
    fix()
    config = { maxIterations, timeoutMinutes: 0, aiStepTimeoutMinutes: 0, journal: 'implementation', change: 'new' }
  } else if (shape === 'verify-fix') {
    entry = 'verify'
    verify('done')
    fix()
  } else if (shape === 'quality') {
    entry = 'work'
    piece('work', 'prompt', { text: prompt, access: 'write' }, { next: 'verify', failed: 'failed' })
    verify('decide')
    decide(`${goal} ${CORE_GOAL_EVIDENCE}`, 'work')
    fix()
  } else {
    entry = 'check'
    piece('check', 'prompt', { text: `${prompt}\n\n${watcherVerdict(goal)}`, access: 'read', sentinel: 'verification' }, { pass: 'done', fail: 'check', failed: 'failed' })
    successEnd = { outcome: 'success', requiresVerified: false }
  }
  edges.unshift({ id: 'e-start', source: 'start', target: entry })
  nodes.push(
    { id: 'done', type: 'end', position: { x: COL_X, y: ROW_GAP * nodes.length }, data: successEnd },
    { id: 'failed', type: 'end', position: { x: COL_RIGHT_X, y: ROW_GAP * nodes.length }, data: { outcome: 'failure' } },
  )
  return { nodes, edges, config }
}

const CORE_STARTER_DESCRIPTIONS: Record<CoreStarterTemplateId, string> = {
  'ship-and-green': 'Fully autonomous: run Core\'s native implementation pipeline for the spec, then verify with the project\'s configured checks and refine (fix) on failure — verify → decide → fix until green. Success requires a verified candidate; no human intervention.',
  'verify-pass': 'Autonomous verify-and-fix: run the project\'s configured build/lint/tests through Core\'s verify piece, then refine on failure — verify → fix → verify until green.',
  'ci-watch': 'Poll CI checks on the open PR (the agent uses the repo\'s CI tooling) until every check is green. Read-only: the watcher never edits the repository.',
  'lint-and-fix': 'The agent detects and runs the project\'s linter and fixes every issue, iterating until the codebase is clean. Every pass is confirmed by the project\'s configured verification before the loop can succeed.',
  'type-safe': 'The agent detects and runs the project\'s type checker and resolves every error, iterating until it passes cleanly. Every pass is confirmed by the project\'s configured verification before the loop can succeed.',
  'coverage-climb': 'The agent runs the project\'s coverage tooling and adds focused tests until the thresholds pass. Every pass is confirmed by the project\'s configured verification before the loop can succeed.',
  'build-fix': 'The agent detects and runs the project\'s production build and fixes compile/bundle errors until it is green. Every pass is confirmed by the project\'s configured verification before the loop can succeed.',
  'deploy-check': 'The agent polls the deployment/health status (using the project\'s deploy tooling) until the service reports healthy. Read-only: the watcher never edits the repository.',
}

function isCoreStarterId(id: string): id is CoreStarterTemplateId {
  return (CORE_STARTER_TEMPLATE_IDS as readonly string[]).includes(id)
}

/** Same gate as `factoryLoopsForCapabilities`: both flags must be advertised. */
export function supportsCoreTemplates(capabilities?: Record<string, number>): boolean {
  return capabilities?.engineV2 === 1 && capabilities.workflowDefinitions === 1
}

/** The catalog for the selected Core: the eight starters become Core definitions
 *  when the capabilities allow it; every other entry (and every entry on older
 *  Core) is the legacy graph. Order, ids, names, categories and tags are stable. */
export function loopTemplatesForCapabilities(capabilities?: Record<string, number>): LoopTemplate[] {
  if (!supportsCoreTemplates(capabilities)) return LOOP_TEMPLATES
  return LOOP_TEMPLATES.map((template) => {
    if (!isCoreStarterId(template.id)) return template
    const readOnly = CORE_STARTER_SHAPES[template.id] === 'watch'
    return {
      ...template,
      description: CORE_STARTER_DESCRIPTIONS[template.id],
      ...(readOnly ? { readOnly: true } : {}),
      graph: coreStarterGraph(template.id),
    }
  })
}

export function getLoopTemplate(id: string, capabilities?: Record<string, number>): LoopTemplate | undefined {
  return loopTemplatesForCapabilities(capabilities).find((t) => t.id === id)
}
