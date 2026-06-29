## 1. Magic commands (loop-magic-commands)

- [x] 1.1 Add `opsx:ff`, `opsx:apply`, `opsx:verify` as `providerNative` `LoopCommand`s in `server/loop-command-catalog.ts` (claude/gemini → `/opsx:<name>`, codex → `$opsx:<name>`, plus a `template` fallback prompt). Do NOT model them as `coreCommand`.
- [x] 1.2 Give each a clear `label`/`description`/`ticketScope` consistent with existing entries; ensure they are appended (registry is append-only).

## 2. Run-scoped capture (loop-execution)

- [x] 2.1 Add a run-scoped captured-variable store to the loop run state in `server/loop-run-manager.ts` (map of `{{run.<name>}}` values, empty until captured).
- [x] 2.2 After an `opsx:ff` ai-step completes, capture the change id by regex on `openspec/changes/<id>` (first match wins) into `run.changeId`.
- [x] 2.3 Extend the token-resolution pipeline so `{{run.<name>}}` resolves in ai-step prompts AND `shell` node commands, applied after `{{cmd:*}}` and `{{spec.*}}`; unresolved → empty string (never a literal token).

## 3. Template graph (loop-template-catalog + opsx-lifecycle-loop)

- [x] 3.1 Author the `opsx-lifecycle` `LoopTemplate` (hand-written `LoopGraph`) in `server/loop-templates.ts` `LOOP_TEMPLATES`, category `Automation`: START → ai `{{cmd:opsx:ff}}` (with `{{spec.title}}`/`{{spec.description}}` and a loop-back continuation note referencing `{{run.changeId}}`) → ai `{{cmd:opsx:apply}}` → ai `{{cmd:opsx:verify}}` → decider → (`continue`→back to ff with `loopBack:'first'` session reset; `stop`→shell `openspec archive {{run.changeId}} -y`) → END.
- [x] 3.2 Set a conservative `maxIterations` (e.g. 3) + sensible `timeoutMinutes`; write the decider `goal` to stop iff `verify` reported PASS.
- [x] 3.3 Bake the momentum override ("decide and keep momentum; never block/ask") into the ff/apply step prompts.
- [x] 3.4 Guard the archive shell node so it does not run `openspec archive` against an empty/unknown change id (skip + settle with a clear failure reason).
- [x] 3.5 Verify the graph passes `validateLoopGraph` and compiles/serves via the existing template-listing path.

## 4. Tests (coverage gates)

- [x] 4.1 Unit-test `opsx:ff/apply/verify` expansion for claude, gemini, codex, and an unknown provider (fallback).
- [x] 4.2 Unit-test `{{run.changeId}}` capture (match, first-of-many, no-match→empty) and its resolution in prompts and shell commands.
- [x] 4.3 Test the `opsx-lifecycle` template: graph validates, lists under `Automation`, instantiates, and a simulated run routes FAIL→loop-back-to-ff and PASS→archive shell node (using injected executors, no real spawn).
- [x] 4.4 Test the archive-guard path (no change id → no archive command, clear failure).
- [x] 4.5 Run `npm run typecheck`, `npm test`, and `npm run test:coverage`; iterate until server coverage holds (80% lines/functions/statements, 70% branches) and global ≥70%.

## 5. Docs / positioning

- [x] 5.1 Add a one-line note (template description and/or relevant doc) positioning `opsx-lifecycle` as the single-agent, OpenSpec-artifact-centric counterpart to `specrails:implement`, and stating the claude-first multi-provider caveat.
