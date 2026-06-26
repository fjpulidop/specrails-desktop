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

export interface LoopTemplate {
  id: string
  name: string
  description: string
  /** Topic tags, surfaced in the gallery. */
  tags: string[]
  graph: LoopGraph
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

export function aiLoopGraph(prompts: string[], deciderGoal: string, maxIterations = 10): LoopGraph {
  const lastAi = `ai-${prompts.length}`
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
    { id: 'e-continue', source: 'decide', target: lastAi, branch: 'continue' }, // not-done → loop back up to the last step
    { id: 'e-stop', source: 'decide', target: 'done', branch: 'stop' }, // done → exit down
  ]
  return { nodes, edges, config: { maxIterations, timeoutMinutes: 30 } }
}

/** Helper: a FULLY-AUTONOMOUS implement-and-fix loop. The `main` steps run ONCE,
 *  then `{{cmd:verify}}` runs; if the Decider says not-done it routes to
 *  `{{cmd:fix}}` (refinement) and RE-verifies — `verify → fix → verify → …` until
 *  the verification passes. No human in the loop. (main may be empty for a
 *  verify-only loop.) */
export function fixLoopGraph(mainPrompts: string[], deciderGoal: string, maxIterations = 12): LoopGraph {
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
  return { nodes, edges, config: { maxIterations, timeoutMinutes: 30 } }
}

export const LOOP_TEMPLATES: LoopTemplate[] = [
  {
    id: 'ship-and-green',
    name: 'Ship & Green',
    description: 'Fully autonomous: implement the spec, verify, and refine (fix) on failure — looping verify → fix → verify until everything is green. No human intervention.',
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
    tags: ['DevOps', 'deploy'],
    graph: aiLoopGraph(
      ['Check the latest deployment/health status using the repository\'s deploy tooling (e.g. `gh run list --workflow deploy`, a health endpoint). Report whether the deployment finished successfully and the service is healthy.'],
      'The latest deployment finished successfully and the service is healthy.',
      20
    ),
  },
]

export function getLoopTemplate(id: string): LoopTemplate | undefined {
  return LOOP_TEMPLATES.find((t) => t.id === id)
}
