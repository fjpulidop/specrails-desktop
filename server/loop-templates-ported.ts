/**
 * Ported starter loops — Specrails-owned templates compiled from declarative
 * PortSpecs (see loop-templates.ts `compilePortSpec`). Authored from common
 * closed-loop patterns; original naming + prompt text, no third-party content.
 * Each entry is plain data; the graph is built at module load by compilePortSpec,
 * which guarantees a valid, Shell-free graph with one continue+stop Decider pair.
 */
import type { PortSpec } from './loop-templates'

export const PORTED_TEMPLATES: PortSpec[] = [
  {
    "id": "autoloop-tdd",
    "name": "Autoloop TDD",
    "description": "A strict red-green-refactor cycle for {{spec.title}}: pin down each behavior with a failing test first, write only enough code to turn it green, then tidy up — repeating until the spec is fully covered.",
    "category": "Testing",
    "tags": [
      "tdd",
      "testing",
      "red-green-refactor"
    ],
    "steps": [
      "Pick the next behavior described in {{spec.description}} that is not yet covered. Write one tight, focused test that asserts that behavior and nothing more. Confirm it FAILS for the intended reason (the behavior is genuinely missing) — a test that passes immediately or errors for the wrong reason is not a valid red. {{const:GUARDRAILS}}",
      "Add the smallest possible production change that flips the new test from red to green. No speculative abstractions, no extra features, no code the failing test does not demand. {{const:GUARDRAILS}}",
      "{{cmd:test}}",
      "With the suite green, refactor the code and tests you just touched: remove duplication, sharpen names, and align with the surrounding conventions. Make no behavioral changes — every refactor must keep the suite green, so re-run the gate after each adjustment. {{const:GUARDRAILS}}"
    ],
    "goal": "Every behavior in {{spec.title}} is driven by a test that started red, and the full suite reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 12,
    "loopBack": "verify"
  },
  {
    "id": "e2e-until-green",
    "name": "E2E Until Green",
    "description": "Run the end-to-end suite for {{spec.title}}, diagnose each failing user-flow, fix the underlying UI or integration defect, and keep cycling until every E2E spec passes.",
    "category": "Testing",
    "tags": [
      "e2e",
      "playwright",
      "testing"
    ],
    "steps": [
      "Run the project's end-to-end suite and read the report carefully. For the first failing spec, trace it to a single root cause — a broken selector, a missing wait/assertion, a real integration bug, or a stale fixture — and describe what you found before touching anything.",
      "Apply the smallest fix that resolves that root cause. Favour resilient selectors and realistic waits over arbitrary sleeps, and fix the application defect rather than weakening the assertion. Then re-run the end-to-end suite to confirm that spec is green and nothing else regressed. {{const:GUARDRAILS}}"
    ],
    "goal": "The end-to-end suite runs to completion with no failing specs — it reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 10,
    "loopBack": "last"
  },
  {
    "id": "flaky-test-triage",
    "name": "Flaky Test Triage",
    "description": "Re-run the failing tests around {{spec.title}} several times to separate genuine regressions from intermittent flakes, then repair the real breaks and stabilize or document the flaky ones.",
    "category": "Testing",
    "tags": [
      "testing",
      "flaky",
      "triage"
    ],
    "steps": [
      "Run the failing test file or suite three to five times in a row. Record, per test, whether it failed every run or only some runs — this pass/fail fingerprint is what tells flaky apart from broken.",
      "Classify each failing test using that fingerprint: FAILS-ALWAYS is a real regression; FAILS-SOMETIMES is flaky. For the flaky ones, note the likely trigger (timing, test ordering, shared state, or environment dependence).",
      "Repair only the confirmed real regressions, with minimal changes that fix the actual defect — never relax an assertion to hide a true failure. For each flaky test, apply a real stabilization (isolate shared state, remove timing races, mock nondeterministic inputs) or, if it cannot be stabilized now, document the flake with its trigger and a follow-up note. {{const:GUARDRAILS}}",
      "Re-run the suite multiple times again to prove the real regressions are gone and the flakiness is reduced or accounted for."
    ],
    "goal": "Every failing test is classified as flaky or real; all real regressions are fixed and the flaky ones are stabilized or explicitly documented.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "independent-verifier-pass",
    "name": "Independent Verifier Pass",
    "description": "An adversarial verification of {{spec.title}}: re-run build, lint, and tests from scratch, trust only the raw command output (not any prior 'it works' claim), and surface or fix every gap.",
    "category": "Testing",
    "tags": [
      "verification",
      "testing",
      "adversarial"
    ],
    "steps": [
      "Act as an independent verifier with no knowledge of how the change was implemented or why it was claimed done. Run the build gate. {{const:GUARDRAILS}}",
      "Run the lint gate as the same skeptical verifier. {{const:GUARDRAILS}}",
      "Run the test gate. Now compile a single report of EVERY failing check across build, lint, and tests — each with the file path and a short error excerpt. Only the actual command output counts as evidence; ignore any earlier self-reported success. {{const:GUARDRAILS}}",
      "If any check failed, fix the underlying cause and re-run the gates; if you cannot resolve a failure, hand back a concise, evidence-backed failure report so the implementer can continue. {{const:GUARDRAILS}}"
    ],
    "goal": "Build, lint, and tests each pass under independent re-verification — all three report {{const:VERIFICATION_PASS}} with no gaps remaining.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "post-edit-test-guard",
    "name": "Post-Edit Test Guard",
    "description": "After each batch of edits for {{spec.title}}, immediately run the narrowest set of tests touching the changed files — catching regressions the moment they appear instead of at the end.",
    "category": "Testing",
    "tags": [
      "hooks",
      "testing",
      "regression"
    ],
    "steps": [
      "List the source files you changed in the most recent batch of edits, and map each to the tests most directly exercising it. Keep the set as small as possible so the check stays fast.",
      "Run the smallest relevant slice of the test suite covering those changed files. If anything regressed, stop and fix it before making any further edits — do not pile new changes on top of a red test. {{const:GUARDRAILS}}"
    ],
    "goal": "The tests directly related to the just-edited files pass — they report {{const:VERIFICATION_PASS}} — before any further changes are made.",
    "maxIterations": 12,
    "loopBack": "last"
  },
  {
    "id": "post-merge-regression-guard",
    "name": "Post-Merge Regression Guard",
    "description": "Right after a merge or rebase brings other people's work into {{spec.title}}, run the fast smoke suite to catch integration breakage immediately — before any new feature work starts on top of it.",
    "category": "Testing",
    "tags": [
      "hooks",
      "testing",
      "git",
      "merge"
    ],
    "steps": [
      "Confirm a merge or rebase just completed. Read the diff stat for the merged range and note which areas of the codebase the incoming changes touched, so you know where integration regressions are most likely.",
      "Run the fast smoke suite that exercises the critical paths. If anything fails, treat it as an integration regression introduced by the merge and fix it before starting any new feature work. {{const:GUARDRAILS}}"
    ],
    "goal": "The smoke suite passes after the merge or rebase — it reports {{const:VERIFICATION_PASS}} — so no integration regression is carried forward.",
    "maxIterations": 12,
    "loopBack": "last"
  },
  {
    "id": "pre-commit-guard",
    "name": "Pre-Commit Guard",
    "description": "A safety gate for {{spec.title}} that intercepts every commit: run the test suite first and refuse to commit while it is red, so broken code never enters history.",
    "category": "Testing",
    "tags": [
      "hooks",
      "testing",
      "git",
      "pre-commit"
    ],
    "steps": [
      "Detect that a commit is about to happen and pause before it runs. Identify what is staged so you know the change being committed.",
      "Run the full test suite as the precondition for committing. {{const:GUARDRAILS}}",
      "If the suite is red, fix the failures and re-run the gate — never weaken or skip a test to get the commit through. Only let the commit proceed once the suite is green. {{const:GUARDRAILS}}"
    ],
    "goal": "The test suite reports {{const:VERIFICATION_PASS}} before the commit is allowed to proceed, so no commit lands on a red suite.",
    "maxIterations": 8,
    "loopBack": "last"
  },
  {
    "id": "visual-regression-until-match",
    "name": "Visual Regression Until Match",
    "description": "Capture visual snapshots of the changed UI, hunt down every unintended pixel diff, and self-correct until the visual suite is green with only deliberate design changes approved.",
    "category": "Testing",
    "tags": [
      "testing",
      "visual",
      "playwright",
      "ui"
    ],
    "steps": [
      "Render the UI surface affected by {{spec.title}} ({{spec.ids}}) and capture its visual snapshots so they can be compared against the approved baselines. Enumerate every screenshot whose rendering drifts from baseline, naming the component or route for each diff so the next pass knows exactly what changed.",
      "For each diff: if it is an unintended regression, correct the CSS/markup to match the baseline; if it is a deliberate change called for by {{spec.description}}, re-approve that single baseline only after eyeballing the diff report to confirm the new look is correct. Never bulk-approve to silence the suite. {{const:GUARDRAILS}}"
    ],
    "goal": "The visual regression gate reports {{const:VERIFICATION_PASS}} — every snapshot matches an approved baseline and only intentional design changes were accepted.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "format-until-clean",
    "name": "Format Until Clean",
    "description": "Apply the project formatter, mop up the handful of style problems it cannot auto-fix, and keep going until a fresh format run leaves the working tree untouched.",
    "category": "Testing",
    "tags": [
      "format",
      "prettier",
      "quality"
    ],
    "steps": [
      "Inspect the most recent changes for formatting that the auto-formatter will not resolve on its own — awkward line breaks, import ordering it leaves alone, or stylistic choices that clash with the surrounding code — and tighten them by hand so the next formatter run has nothing left to rewrite. {{const:GUARDRAILS}}",
      "{{cmd:format}}"
    ],
    "goal": "The formatter gate reports {{const:VERIFICATION_PASS}} — running it produces no further changes and the working tree is stable.",
    "maxIterations": 6,
    "loopBack": "last"
  },
  {
    "id": "lint-typecheck-fix",
    "name": "Lint and Typecheck Fix",
    "description": "Run the linter and the type checker, resolve each reported problem with the smallest possible edit, and loop until both gates come back completely clean.",
    "category": "Testing",
    "tags": [
      "lint",
      "typescript",
      "quality"
    ],
    "steps": [
      "{{cmd:lint}}",
      "{{cmd:typecheck}}"
    ],
    "goal": "Both the lint and typecheck gates report {{const:VERIFICATION_PASS}} — no lint warnings and no type errors remain, with no rules disabled to get there.",
    "maxIterations": 8,
    "loopBack": "last"
  },
  {
    "id": "a11y-audit-until-clean",
    "name": "A11y Audit Until Clean",
    "description": "Run the automated accessibility checks over the changed screens, fix the violations one category at a time, and repeat until the audit comes back with zero issues.",
    "category": "Quality",
    "tags": [
      "a11y",
      "quality",
      "frontend"
    ],
    "steps": [
      "Run the accessibility audit across the UI touched by {{spec.title}} ({{spec.ids}}) and list every violation with its offending selector, grouped by type. Then fix them, prioritizing keyboard-navigation and screen-reader blockers, and always reaching for semantic HTML before falling back to ARIA attributes. {{const:GUARDRAILS}}",
      "{{cmd:verify}}"
    ],
    "goal": "The accessibility audit reports {{const:VERIFICATION_PASS}} — zero serious violations remain on the changed UI.",
    "maxIterations": 8,
    "loopBack": "last"
  },
  {
    "id": "de-sloppify-pass",
    "name": "De-Sloppify Pass",
    "description": "After the feature lands, sweep the diff for leftover slop — debug output, dead branches, sloppy names, bloated functions — clean it up, and prove the cleanup did not break anything.",
    "category": "Review",
    "tags": [
      "review",
      "quality",
      "cleanup"
    ],
    "steps": [
      "Comb through the changes made for {{spec.title}} ({{spec.ids}}) and flag every bit of slop: stray debug logs, commented-out code, throwaway TODO hacks, functions that grew too long, and names that read inconsistently against the rest of the file.",
      "Tidy each flagged item with the smallest edit that fixes it — delete the dead code, pull oversized blocks into well-named helpers, sharpen the types, and align the style with the surrounding code so the diff reads as if it were written cleanly the first time. {{const:GUARDRAILS}}"
    ],
    "goal": "No slop remains in the changed code and the project's lint and test gates both report {{const:VERIFICATION_PASS}}, confirming the cleanup changed nothing it should not have.",
    "maxIterations": 4,
    "loopBack": "verify"
  },
  {
    "id": "fix-ci-until-green",
    "name": "Fix CI Until Green",
    "description": "Pull the most recent red CI run on this branch, reproduce the breakage on your machine, patch the real cause, push, and keep cycling until every check reports success.",
    "category": "CI",
    "tags": [
      "ci",
      "github",
      "fix"
    ],
    "steps": [
      "Inspect the latest CI run for the current branch with {{cmd:ci-status}}. If it is green, you are done. Otherwise pull the logs for every failing job and name the exact step (tests, lint, type check, build) that broke and the first error it reports.",
      "Reproduce the red step locally by running the matching project gate — {{cmd:test}}, {{cmd:lint}}, {{cmd:typecheck}}, or {{cmd:build}} — and confirm you see the same failure the runner saw before changing anything.",
      "Repair the underlying cause with the smallest possible diff (no unrelated refactors), then have the agent fix-and-self-verify the affected gate via {{cmd:fix}} so the same gate now emits {{const:VERIFICATION_PASS}}. {{const:GUARDRAILS}}",
      "Commit and push the fix with {{cmd:push}}, then re-poll the pipeline with {{cmd:ci-status}}. If the newest run is still red, feed the fresh logs back into the next pass; repeat until it is green."
    ],
    "goal": "The most recent CI run on the current branch concludes successfully with every required check green.",
    "maxIterations": 15,
    "loopBack": "last"
  },
  {
    "id": "pr-babysitter",
    "name": "PR Babysitter",
    "description": "On a recurring interval, sweep the open pull requests you are watching and keep each one mergeable: revive red CI, rebase the ones that have fallen behind the base branch, and ping the stale ones — escalating anything a human has to decide.",
    "category": "CI",
    "tags": [
      "pr",
      "github",
      "ci",
      "babysitter"
    ],
    "steps": [
      "Enumerate the open PRs you are babysitting and read each one's current health with {{cmd:ci-status}}: mergeable state, check rollup, and time since last activity. Drop drafts and any PR whose only blocker is a product decision a human owns.",
      "Walk each watched PR and apply the lightest unblocking action: if its checks are red, run one {{cmd:fix}} pass to repair the cause and re-confirm the gate hits {{const:VERIFICATION_PASS}}; if it trails the base branch, rebase it; if reviewers have gone quiet, leave a concise status nudge with {{cmd:pr}}. {{const:GUARDRAILS}}",
      "Re-check the watched set with {{cmd:ci-status}} and write a one-line verdict per PR. Stop touching any PR that hit a merge conflict needing a product call or that failed the identical way twice — flag it as a human-escalation blocker instead of retrying."
    ],
    "goal": "Every watched pull request is green and current with its base branch, or has been clearly flagged as a blocker that needs a human decision.",
    "maxIterations": 20,
    "loopBack": "last"
  },
  {
    "id": "pr-watch-loop",
    "name": "PR Watch Loop",
    "description": "Poll the pull requests on your watch list at a steady cadence, summarize each one's CI and review health, and either knock out trivial blockers or surface what needs an owner.",
    "category": "CI",
    "tags": [
      "ci",
      "pr",
      "watch"
    ],
    "steps": [
      "List the open PRs on your watch list and capture, per PR, its check rollup, review state, and how long since the last activity using {{cmd:ci-status}}.",
      "For each watched PR, drill into the specifics: which checks are failing, which review threads are still unresolved, and whether it has a merge conflict against its base branch.",
      "Produce a short health report covering every watched PR. Where a failure is trivial, run one {{cmd:fix}} pass and re-confirm the gate reports {{const:VERIFICATION_PASS}}; otherwise leave a status note for the author via {{cmd:pr}} naming the blocker. {{const:GUARDRAILS}}"
    ],
    "goal": "A current health report has been delivered for every watched pull request, with trivial CI failures fixed and real blockers attributed to an owner.",
    "maxIterations": 18,
    "loopBack": "last"
  },
  {
    "id": "pr-self-review",
    "name": "PR Self-Review",
    "description": "Critique your own working diff the way a demanding senior reviewer would, resolve what you find, and re-review until a clean pass turns up nothing critical — before the PR ever leaves your hands.",
    "category": "Review",
    "tags": [
      "review",
      "pr",
      "quality"
    ],
    "steps": [
      "Read the full diff on the current branch as if you were reviewing someone else's PR. Enumerate every concern: latent bugs, unhandled edge cases, weak or misleading names, and behavior that lacks test coverage.",
      "Resolve the highest-severity findings from that critique, keeping each change tightly scoped to the issue it fixes and nothing more. {{const:GUARDRAILS}}",
      "Run an independent verification sweep over the touched code with {{cmd:review}}, then re-read the updated diff to confirm the prior findings are gone and no critical issue remains; surface anything still open for the next pass. {{const:GUARDRAILS}}"
    ],
    "goal": "A fresh self-review pass over the current diff surfaces no critical findings and the automated review reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 4,
    "loopBack": "last"
  },
  {
    "id": "spec-first-ship",
    "name": "Spec-First Ship",
    "description": "Drive a written requirements checklist to completion one item at a time — each pass implements a single unchecked requirement, proves it, and ticks it off — so the spec is the contract for done.",
    "category": "Planning",
    "tags": [
      "planning",
      "spec",
      "requirements"
    ],
    "steps": [
      "Read the spec for {{spec.title}} ({{spec.ids}}) and its requirement checklist. Select the single first still-unchecked requirement and restate its acceptance criteria; do not begin more than one requirement in a pass.",
      "Implement that one requirement against its acceptance criteria, adding the tests it needs as you go. Mark the checklist item done only once it is built. {{const:GUARDRAILS}}",
      "Verify just-built requirement against the spec by running the project's test gate with {{cmd:test}} plus any manual checks the requirement calls for; confirm it reports {{const:VERIFICATION_PASS}} before ticking the box and moving on to the next unchecked item."
    ],
    "goal": "Every requirement in the spec checklist for {{spec.title}} is implemented, verified to {{const:VERIFICATION_PASS}}, and checked off.",
    "maxIterations": 12,
    "loopBack": "last"
  },
  {
    "id": "dependency-audit-weekly",
    "name": "Weekly Dependency Audit",
    "description": "Each week, take stock of which packages have fallen behind, sort them into safe-to-bump versus risky, and hand back a clear upgrade plan you can act on.",
    "category": "Maintenance",
    "tags": [
      "dependencies",
      "maintenance",
      "security"
    ],
    "steps": [
      "Survey the project's dependency manifest for packages that are behind their latest published release. Group what you find into three buckets — patch-level, minor-level, and major-level bumps — and note the current vs. available version for each. This is a read-only inventory; do not change any files.",
      "Turn the inventory into an actionable upgrade plan. For each candidate, judge how safe the bump is, call out any that ship breaking changes or will require code edits, and rank them so the lowest-risk wins come first. Summarize the recommendation so a developer can decide what to pull in next."
    ],
    "goal": "A current dependency audit summary has been produced this pass, grouping every outdated package by upgrade level with a prioritized, risk-annotated upgrade recommendation.",
    "maxIterations": 15,
    "loopBack": "last"
  },
  {
    "id": "dependency-upgrade-one-by-one",
    "name": "Upgrade Dependencies One at a Time",
    "description": "Bump exactly one outdated package per pass, repair whatever the bump breaks, prove the project still works, and commit — far safer than upgrading everything at once.",
    "category": "Maintenance",
    "tags": [
      "dependencies",
      "maintenance",
      "upgrades"
    ],
    "steps": [
      "Scan the dependency manifest for outdated packages and choose a single highest-impact one to upgrade this pass — exactly one, no more. Record its current and target version, then apply the version bump. Update any code the new version forces you to change: renamed APIs, removed options, changed types, adjusted signatures. {{const:GUARDRAILS}}",
      "{{cmd:typecheck}}",
      "{{cmd:test}}",
      "Once the project is green, commit just this single dependency bump with a clear conventional message that names the package and the version it moved to (for example, chore(deps): bump <package> to <version>). Then report which package was upgraded and whether outdated packages still remain."
    ],
    "goal": "This pass upgraded exactly one outdated package, the typecheck and test gates report {{const:VERIFICATION_PASS}}, the bump is committed on its own, and either no meaningful outdated packages remain or the user has chosen to stop.",
    "maxIterations": 12,
    "loopBack": "last"
  },
  {
    "id": "knip-until-clean",
    "name": "Prune Dead Code Until Clean",
    "description": "Hunt down unreferenced exports, orphaned files, and dependencies nobody imports, remove them safely, and keep going until the dead-code scanner has nothing left to report.",
    "category": "Maintenance",
    "tags": [
      "maintenance",
      "dead-code",
      "deps"
    ],
    "steps": [
      "Run the project's dead-code / unused-dependency scanner and read its report carefully. Sort every finding into three groups: unreferenced exports, files nothing imports, and dependencies declared but never used. For each item decide whether it is truly dead or a legitimate false positive (entry points, dynamically loaded modules, type-only or plugin-resolved imports).",
      "Delete the findings you confirmed are genuinely dead, keeping each change minimal and self-contained. For any false positive, add a scanner ignore entry annotated with a one-line reason rather than deleting code that is actually in use. {{const:GUARDRAILS}}",
      "{{cmd:test}}"
    ],
    "goal": "The dead-code scanner reports no remaining unused files, exports, or dependencies, every removal was a true positive, and the test gate reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 15,
    "loopBack": "last"
  },
  {
    "id": "docs-sync-after-edits",
    "name": "Sync Docs to Code Changes",
    "description": "After a round of code edits, track down every doc the changes touched — README, API reference, inline comments — and bring them back in line with how the code actually behaves now.",
    "category": "Maintenance",
    "tags": [
      "docs",
      "maintenance",
      "sync"
    ],
    "steps": [
      "Inspect the current diff and build a list of everything user- or developer-facing that changed: public function and API signatures, configuration options, environment variables, default behaviors, and CLI flags. This list is the source of truth for what documentation must reflect.",
      "Search the README, the docs directory, and inline code comments for any mention of the behaviors you listed. Flag every section that now describes something the code no longer does, and note any newly added surface that is documented nowhere.",
      "Bring the affected documentation back into agreement with the code: correct stale descriptions, refresh examples so they actually run, document the new surface, and delete sections describing removed behavior. Keep wording consistent with the existing docs voice. {{const:GUARDRAILS}}",
      "{{cmd:docs-sync}}"
    ],
    "goal": "Every piece of documentation touched by the diff has been updated to match the current code, the docs-sync gate reports {{const:VERIFICATION_PASS}}, and no contradiction remains between the docs and the changed behavior.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "security-audit-weekly",
    "name": "Weekly Security Audit",
    "description": "Run a weekly vulnerability scan over the dependency tree, triage what turns up by severity and real-world exposure, and hand back a prioritized remediation plan.",
    "category": "Maintenance",
    "tags": [
      "security",
      "npm",
      "audit",
      "maintenance"
    ],
    "steps": [
      "{{cmd:audit}}",
      "Triage the advisories the scan surfaced. Group them by severity (critical, high, moderate, low) and by whether each is reachable in production code or confined to dev-only tooling. Note which findings are directly exploitable in this project's usage versus theoretical.",
      "Draft a remediation plan that maps each meaningful finding to its safest fix — an automatic audit fix, a targeted dependency override, or a direct version bump — and flag any fix that carries a breaking change. Order the plan so the highest-severity, production-exposed issues are addressed first."
    ],
    "goal": "A current weekly security audit summary has been delivered this pass, with every finding triaged by severity and exposure and matched to a prioritized, safety-annotated remediation plan.",
    "maxIterations": 15,
    "loopBack": "last"
  },
  {
    "id": "npm-audit-fix-loop",
    "name": "Patch Vulnerabilities One at a Time",
    "description": "Clear high and critical dependency advisories deliberately — one fix per pass, each verified against the test suite — instead of a blind force-fix that can quietly break the build.",
    "category": "Security",
    "tags": [
      "security",
      "npm",
      "audit"
    ],
    "steps": [
      "{{cmd:audit}}",
      "From the high- and critical-severity advisories, pick a single one to resolve this pass. Apply the safest available remedy — a scoped automatic fix for that advisory or a targeted bump of the offending direct dependency — and avoid forced, breaking-change resolutions unless there is genuinely no other path. Adjust any code the patched version requires. {{const:GUARDRAILS}}",
      "{{cmd:test}}"
    ],
    "goal": "No high- or critical-severity dependency advisories remain, every fix was applied deliberately one at a time, and the test gate reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 10,
    "loopBack": "last"
  },
  {
    "id": "api-contract-until-match",
    "name": "API Contract Until Match",
    "description": "Drive the implementation until its responses honor the published API contract, closing any gap between what the schema promises and what the handlers actually return.",
    "category": "API",
    "tags": [
      "api",
      "openapi",
      "contract-testing"
    ],
    "steps": [
      "Apply the changes in {{spec.title}} ({{spec.ids}}) — {{spec.description}} — so every affected endpoint's request and response shapes line up with the declared API contract (OpenAPI document or JSON Schema fixtures). For each route, reconcile status codes, required fields, and types: adjust the handler when the code is wrong, or correct the contract when the implementation is the source of truth — but never both blindly. {{const:GUARDRAILS}}",
      "{{cmd:test}}"
    ],
    "goal": "The contract test suite reports {{const:VERIFICATION_PASS}} — every endpoint's live behavior matches the published API contract with no schema or response drift.",
    "maxIterations": 10,
    "loopBack": "verify"
  },
  {
    "id": "openapi-sync-until-valid",
    "name": "OpenAPI Sync Until Valid",
    "description": "Keep the OpenAPI document well-formed and faithful to the real route handlers, repairing spec errors and code-vs-doc drift on each pass until the linter is satisfied.",
    "category": "API",
    "tags": [
      "api",
      "openapi",
      "docs"
    ],
    "steps": [
      "Reconcile the OpenAPI specification with the routes touched by {{spec.title}} ({{spec.ids}}). Cross-check each documented path, parameter, request body, response schema, and status code against the actual handler, then fix whichever side is wrong so the document describes reality. Also repair any structural or syntax problems flagged by the spec linter. {{const:GUARDRAILS}}",
      "{{cmd:lint}}"
    ],
    "goal": "The OpenAPI linter reports {{const:VERIFICATION_PASS}} — the spec is structurally valid and accurately mirrors the implemented routes.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "migration-until-applied",
    "name": "Migration Until Applied",
    "description": "Bring the database schema forward cleanly: run the pending migrations, repair any schema or SQL faults they surface, and confirm migration history stays consistent.",
    "category": "Database",
    "tags": [
      "database",
      "prisma",
      "migrations"
    ],
    "steps": [
      "Author and apply the schema changes required by {{spec.title}} ({{spec.ids}}) — {{spec.description}}. Add or amend the migration, run it against the dev database, and resolve any failure it raises: fix the schema definition or hand-written SQL, regenerate any derived client or types, and make sure the migration is reversible and ordered correctly relative to existing history. {{const:GUARDRAILS}}",
      "{{cmd:build}}"
    ],
    "goal": "Migration status reports {{const:VERIFICATION_PASS}} — every migration applies cleanly with consistent history and the app still builds against the new schema.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "bundle-size-budget",
    "name": "Bundle Size Budget",
    "description": "Land the feature without inflating the client bundle past its budget — measure each pass and trim, code-split, or lazy-load until the size gate is green.",
    "category": "Performance",
    "tags": [
      "performance",
      "bundle",
      "frontend"
    ],
    "steps": [
      "Implement {{spec.title}} ({{spec.ids}}) — {{spec.description}} — while keeping the client bundle inside its configured size budget. If your change pushes a chunk over the limit, prefer dynamic imports for heavy modules, route-level splitting, and dropping unused dependencies before considering any feature reduction. {{const:GUARDRAILS}}",
      "{{cmd:build}}"
    ],
    "goal": "The bundle-size gate reports {{const:VERIFICATION_PASS}} — the production build stays under its configured size budget.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "changelog-sync-after-ship",
    "name": "Changelog Sync After Ship",
    "description": "After shipping, make sure the changelog tells the user-facing story: review what landed, write Keep-a-Changelog entries, and confirm nothing visible was missed.",
    "category": "Docs",
    "tags": [
      "docs",
      "changelog",
      "release"
    ],
    "steps": [
      "Survey what shipped since the last release: list the commits and pull requests beyond the most recent tag or changelog section, and pull out the changes a user would actually notice from {{spec.title}} ({{spec.ids}}).",
      "Add the corresponding entries under the [Unreleased] heading of the changelog, grouped as Added / Changed / Fixed in plain user-facing language, linking the relevant issues or PRs. Match the project's existing changelog conventions. {{const:GUARDRAILS}}",
      "{{cmd:docs-sync}}"
    ],
    "goal": "The changelog's [Unreleased] section documents every user-visible change from this ship, correctly grouped and formatted, with no notable change left out.",
    "maxIterations": 3,
    "loopBack": "last"
  },
  {
    "id": "guardrails-learning-loop",
    "name": "Guardrails Learning Loop",
    "description": "Keep iterating on the gates until they go green, but every time a check fails the same way twice, write down a guardrail note first so the loop never burns iterations re-attempting an approach that already failed.",
    "category": "Automation",
    "tags": [
      "guardrails",
      "learning",
      "automation"
    ],
    "steps": [
      "Open .ralph/guardrails.md (create it if absent) and read every recorded guardrail note. Treat each one as a hard constraint for this pass: do not re-try any approach a note says has already failed.",
      "Run the test gate. {{cmd:test}}",
      "Run the lint gate. {{cmd:lint}}",
      "Compare any failure against the last pass. If the identical error reappears, append a short, concrete guardrail note to .ralph/guardrails.md (one line: what broke and the rule that prevents it), then fix the underlying cause honouring every recorded note and never re-running a previously failed fix. {{const:GUARDRAILS}}"
    ],
    "goal": "Both the test and lint gates report {{const:VERIFICATION_PASS}} and no failure pattern recorded in .ralph/guardrails.md recurs.",
    "maxIterations": 12,
    "loopBack": "last"
  },
  {
    "id": "ralph-story-executor",
    "name": "Backlog Story Executor",
    "description": "Work a backlog of user stories one at a time with a fresh context each pass: pick the next unfinished story, build only it, prove the project gates stay green, commit, and mark it done before moving on.",
    "category": "Automation",
    "tags": [
      "automation",
      "backlog",
      "prd",
      "fresh-context"
    ],
    "steps": [
      "Read .ralph/prd.json and .ralph/progress.md. If a story is flagged inProgress, resume it; otherwise select the lowest-priority story whose passes flag is still false. Flag exactly that one story inProgress in prd.json before writing any code.",
      "Implement that single story end to end at the smallest reasonable scope. Touch nothing outside what the story requires. {{const:GUARDRAILS}}",
      "Run the project's gates and resolve every failure before committing. {{cmd:test}} {{cmd:lint}} {{cmd:build}}",
      "{{cmd:commit}} with a message scoped to this story, then set its passes flag to true in .ralph/prd.json and append what you learned to .ralph/progress.md."
    ],
    "goal": "Every story in .ralph/prd.json has passes set to true, with each one committed and its gates reporting {{const:VERIFICATION_PASS}}.",
    "maxIterations": 20,
    "loopBack": "last"
  },
  {
    "id": "investigation-script-loop",
    "name": "Investigation Script Loop",
    "description": "Pin down a bug's true cause empirically: write a tiny disposable script that exercises the suspect behaviour, run it, read the real output, and refine the probe until the output itself proves the root cause.",
    "category": "Debugging",
    "tags": [
      "debugging",
      "repro",
      "scripts"
    ],
    "steps": [
      "Write a single throwaway probe script (roughly 20 lines, one file) that reproduces the failing behaviour or prints the suspect internal state for {{spec.title}}. Keep it isolated from production code paths.",
      "Execute the probe and capture stdout and stderr verbatim. Reason only from the captured output, never from assumptions about what the code does.",
      "Adjust the probe or your written hypothesis based on what the output actually showed, then re-run. Once the output unambiguously demonstrates the root cause, write a one-paragraph summary tying the evidence to the cause and stop."
    ],
    "goal": "The probe script's captured output demonstrates the root cause of the issue, accompanied by a written summary linking that output to the explanation.",
    "maxIterations": 8,
    "loopBack": "last"
  },
  {
    "id": "reflexion-debug-loop",
    "name": "Reflection Debug Loop",
    "description": "Turn a failing test green without thrashing: each time an attempt fails, record a short reflection to disk and consult it before the next try, so the loop never repeats a fix that has already been ruled out.",
    "category": "Debugging",
    "tags": [
      "debugging",
      "reflection",
      "memory"
    ],
    "steps": [
      "Read .loops/reflexion.md (create it if missing) for past attempts, then reproduce the bug by running the failing test and capturing its exact error output.",
      "Append one entry to .loops/reflexion.md: what you just tried, precisely how it failed, and one hypothesis that steers the next attempt somewhere new.",
      "Choose a fix that differs from every approach already logged in .loops/reflexion.md, targeting the root cause rather than masking the symptom. {{const:GUARDRAILS}}"
    ],
    "goal": "The previously failing test now passes and the project gates report {{const:VERIFICATION_PASS}}.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "merge-conflict-resolver",
    "name": "Merge Conflict Resolver",
    "description": "Bring the branch up to date with its target by rebasing, then resolve every conflict file by file while preserving both sides' intent, and prove the result still passes before declaring the branch current.",
    "category": "Git",
    "tags": [
      "git",
      "rebase",
      "merge"
    ],
    "steps": [
      "Fetch the latest target branch and start a rebase of the current branch onto it. List every file reported as conflicted.",
      "Resolve each conflicting file individually: read both the incoming and the local hunk, keep the intent of each side, and integrate them with the smallest sensible edit rather than blindly choosing one side. {{const:GUARDRAILS}}",
      "Continue the rebase until it completes with no remaining conflict markers anywhere in the tree."
    ],
    "goal": "The branch is rebased on its target with zero conflicts remaining and the project gates report {{const:VERIFICATION_PASS}}.",
    "maxIterations": 8,
    "loopBack": "verify"
  },
  {
    "id": "staging-smoke-test",
    "name": "Staging Smoke Test",
    "description": "After a staging deploy, walk a fixed smoke checklist — auth, the core user paths, and key integrations — fixing the smallest issue each time something breaks and re-running until the whole checklist comes back clean.",
    "category": "DevOps",
    "tags": [
      "staging",
      "smoke-test",
      "deploy"
    ],
    "steps": [
      "Run the staging smoke checklist end to end: confirm login works, exercise the critical user flows, and verify webhooks and other integrations respond as expected. Record the status of each item.",
      "For any failing item, trace the staging logs to the cause and apply the smallest corrective change, redeploying or hotfixing as the situation requires. {{const:GUARDRAILS}}",
      "Re-run the full smoke checklist and confirm each item now reports healthy. {{cmd:verify}}"
    ],
    "goal": "Every item on the staging smoke checklist passes and verification reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 6,
    "loopBack": "last"
  },
  {
    "id": "deploy-verification-loop",
    "name": "Deploy Verification Loop",
    "description": "After a deploy goes out, poll the health and smoke endpoints on an interval, investigating and fixing or escalating any non-healthy response, and keep checking until every configured endpoint reports success.",
    "category": "DevOps",
    "tags": [
      "deploy",
      "devops",
      "smoke-test"
    ],
    "steps": [
      "Probe each configured health and smoke endpoint and record its status code and response body. Treat any non-success response as a signal to investigate.",
      "When an endpoint is unhealthy, inspect the recent deploy logs, environment configuration, and any pending migrations to locate the cause, then apply the smallest fix or escalate a rollback if it is not safely recoverable. {{const:GUARDRAILS}}",
      "Re-probe all endpoints after each fix or rollback decision and confirm they have returned to a healthy state. {{cmd:verify}}"
    ],
    "goal": "Every configured health and smoke endpoint returns a successful response and verification reports {{const:VERIFICATION_PASS}}.",
    "maxIterations": 16,
    "loopBack": "last"
  }
]
