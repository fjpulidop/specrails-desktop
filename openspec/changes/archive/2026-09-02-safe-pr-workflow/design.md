# Design — Safe PR Workflow

## Context (as-built, verified)

Two code-producing paths mutate a repo today, with no shared git methodology:

1. **Desktop loops** — `server/loop-run-manager.ts` walks a graph; repo-mutating rails in per-ticket scope are wrapped in a git worktree (`server/rail-isolated-launch.ts` → `server/worktree-manager.ts`), committed by the app (`commitWorktree`), and **merged back locally** into the checked-out branch (`server/rail-merge-orchestrator.ts` → `server/merge-manager.ts` `mergeBack`, `git merge --no-ff`, AI-resolver + verify + `git reset --hard` rollback). No push, no PR.
2. **specrails-core `/specrails:implement`** — invoked from loops via `{{cmd:implement}}` (`server/loop-command-catalog.ts`, a real `coreCommand`). Its Phase 4c "Ship" (`templates/commands/specrails/implement.md`) **self-ships under Claude** (`checkout -b feat/…` → commit → `push -u` → `gh pr create`) driven by `GIT_AUTO=true`; under **Codex/Gemini it does no git at all**.

Key facts that shape the design:

- The **base/integration branch is never configured** — worktrees branch off `HEAD`; merge-back lands on whatever is checked out.
- `{{cmd:implement}}` is `ticketScope:'all'` → routed to **shared-cwd**, so the common implement rail **never even enters a worktree** — yet Claude still opens an untracked PR.
- The only suppressor of core's ship, `git_auto:false`, is **Jira-only**, lives in **gitignored** `.specrails/` (absent in a fresh worktree), and the env redirect `SPECRAILS_BACKLOG_CONFIG_PATH` is **not read** by `implement.md`.
- A **relocated** project under isolation loses its `.specrails/` layer (agents, `.mcp.json`, `/specrails:*` commands) because the per-run workspace overlay documented in `rail-isolated-launch.ts:11-16` is **unimplemented**.
- Competitor convergence (Codex/Cursor/Antigravity): isolate every agent; **never auto-merge to the target branch**; PR creation is user-triggered / branch-handoff; the human owns the merge.

## Goals

- One predefined, teachable methodology identical across all loops (built-in + custom) and all providers.
- Git invisible to the product builder; specrails plugs into the team's existing GitHub review flow.
- Certainty: a mutating loop always isolates off the correct base and always ends in a draft PR.

## Non-Goals

- specrails does **not** merge, does **not** open non-draft PRs, does **not** push to protected branches. The engineer merges in GitHub.
- No per-loop configuration of isolation/PR behavior (that is what breaks the guarantee). The only per-project knob is the integration branch.
- Not teaching Codex/Gemini to ship (they are already git-agnostic — the correct shape).

## The platform law (the invariant)

> Every repo-mutating loop runs in an isolated worktree branched from the project's designated integration branch, and delivers its result as a **draft PR** from that branch. specrails never touches the working tree, never commits to the integration branch directly, and never merges or opens a non-draft PR. The human owns the merge.

`mutating` vs `read-only` is **derived** from the loop (does any node write to the repo?), enforced by the engine — not a user toggle, so built-in and custom loops are judged by the same axis.

## Decisions

### D1 — Single git owner = desktop; core is git-agnostic under desktop
Version control and PR opening move entirely to the desktop layer. Rationale: (a) core runs separately per provider → three chances to diverge; putting git in the outer wrapper makes it one uniform behavior. (b) core is a different repo → a methodology in core needs a core release + version gate per change. (c) the git *context* (base branch, batch grouping, draft-PR policy, registry, project settings) lives in desktop, not core.

Inside the worktree, **any** producer (a loop, or `implement` on any provider) only writes files + verifies. Desktop does `commit → push → gh pr create --draft` from outside. Safety no longer depends on what runs inside.

### D2 — Designated integration branch per project
Add a per-project setting (default = repo default branch via `git symbolic-ref refs/remotes/origin/HEAD`, else current `HEAD`). Resolution order: explicit-at-launch (rare) → project setting → repo default. **Resolve and display it before launch.** Wire it through `createWorktree` (`baseRef` = the resolved branch — the dead hook made live). Worktree branch name stays `sr/<slug>/ticket-<id>`.

### D3 — Retire local merge-back; push + draft PR instead
`mergeBack`'s `git merge --no-ff` into local HEAD is removed from the mutating path. Replace with an app-owned primitive: from the ticket branch (already committed by `commitWorktree`), `git push -u origin <branch>` then `gh pr create --draft --base <integration-branch>`. Degrade cleanly: no auth/network → push-only → local-branch-only; **never fail the loop** over PR creation, surface the degraded state.

### D4 — Cross-repo contract: core honors a travelling git-agnostic signal
Core must be silenced in a way that **survives into a worktree** and is **provider-invariant**. A config file does not (gitignored + absent in fresh worktree). Therefore an **explicit flag** `--no-ship` (and/or env `SPECRAILS_GIT_AUTO=false`) parsed in `implement.md` **Phase 0**, short-circuiting Phase 4c/4d exactly like `GIT_AUTO=false`. Desktop passes it on **every** rail invocation, all three providers, both the `all`-scoped and per-ticket paths — replacing the Jira-only `git_auto:false`. Reconcile `backend-developer.md`/`frontend-developer.md` self-commit behavior under this mode. Interim (no-core-change) stopgap: desktop writes `git_auto:false` into backlog-config for all projects **and** ensures it is present inside the worktree — but the flag is the robust fix.

Also: run `{{cmd:implement}}` **per-ticket isolated** so it obeys the same law (today `ticketScope:'all'` → shared cwd → never isolated).

### D5 — Combined batch PR + repurposed AI resolver
A batch of N tickets → **one** combined draft PR. The AI merge-resolver is repurposed from "merge into local main" to "assemble the N ticket branches onto one integration branch `sr/<slug>/batch-<id>` (off the designated base), keeping it clean" → one draft PR. PR body = per-ticket checklist (`- [x] TICKET-A: <title> — <plain-language what changed>`) + per-ticket verification; per-ticket commit history is preserved (no squash) so the Commits tab and `git log` show attribution. Safe failure mode: cannot combine cleanly → fall back to N separate PRs or mark "needs a human to combine"; never touch the base.

### D6 — Enforce the law in the engine, not by convention
The mutating/read-only classification and the isolate+draft-PR requirement are enforced at launch (engine/validator), so a custom loop cannot opt out of isolation. Add **hard git guardrails** (block force-push; block direct commits to the integration branch) as technical blocks, not the current soft prompt etiquette in `{{cmd:push}}`/`{{cmd:commit}}`. `{{const:GUARDRAILS}}` (anti-metric-gaming) is unchanged and orthogonal.

### D7 — Close the relocation overlay blocker
Implement the per-run workspace overlay so a relocated project under isolation still has `.specrails/` (agents, `.mcp.json`, `/specrails:*`) available inside the worktree. Without it, any loop needing native commands (i.e. `{{cmd:implement}}`) fails in relocated repos, and the methodology cannot rely on implement running in a worktree.

## Two-persona flow

```
PRODUCT BUILDER (non-engineer)              ENGINEER (already on the team)
1. describe "I want X"
2. launch loop  (isolates off resolved base)
3. runs in background, isolated
4. Review: plain-language "what changed + proof"
5a. Approve → draft PR → ready + notify   ──▶  6. review PR in GitHub (existing flow)
5b. Discard → close PR + drop branch/worktree   7. merge (or request changes)
```

The builder is a quality pre-filter: the engineer's review queue only receives PRs that already passed automated verification + a human business check.

## Risks / open questions

- **Core change coordination.** Requires a synchronized specrails-core release for the `--no-ship` flag. The interim desktop-only stopgap (D4) de-risks the rollout window.
- **Draft-PR requires `gh` auth + a remote.** Degradation ladder (D3) keeps loops functional offline; the methodology's "PR" endpoint is best-effort, never load-bearing for loop success.
- **Schema duplication.** `LoopGraph` type is duplicated (`server/loop-graph.ts` vs `client/src/lib/loops-api.ts`); the mutating/read-only classifier must live server-side (authoritative) with the client mirroring.
- **`{{cmd:implement}}` scope change** from `all` to per-ticket alters batch execution semantics; verify dependency ordering still holds.

## Rollout

1. Land D2 (integration branch) + D3 (push + draft PR) + D6 (enforcement + guardrails) desktop-only, behind the existing isolation gate.
2. Land D7 (relocation overlay) — unblocks implement-in-worktree.
3. Land the interim D4 stopgap (silence core for all projects), then the real `--no-ship` contract once specrails-core ships it.
4. Land D5 (combined batch PR) + the "Review & Approve" client surface.
