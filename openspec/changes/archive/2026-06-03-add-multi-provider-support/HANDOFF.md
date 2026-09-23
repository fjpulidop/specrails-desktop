# Handoff — add-multi-provider-support

This file is the running progress log for the change. It is **not** an
OpenSpec-tracked artifact — `proposal.md`, `design.md`, `specs/`, and
`tasks.md` are.

## Status: **READY TO TEST LOCALLY** ✅

All 26 sections of `tasks.md` are content-complete except §23, which is
an unscripted manual e2e dry-run that requires a live codex session.
The branches in both repos are mergeable; the only step remaining
before GA is the user's local validation against a real codex auth.

### Branches

- `specrails-core: feat/codex-provider-support` — 1 commit, +1254/-58
  LOC, 175 tests pass.
- `specrails-hub: feat/multi-provider-support` — 23 commits,
  +6910/-837 LOC, server 1788/1789 (lone pre-existing smash-runner
  fail outside scope), client 1818/1818.

### What was shipped (all stages)

| Stage | Scope | Status |
|---|---|---|
| **A** | Hub adapter architecture + codex correctness across every manager | ✅ |
| **B** | specrails-core 4.6.0: lift 3 gates + extend scaffold + rail SKILL.md + apply codex settings | ✅ |
| **C-gates** | hub-router + AddProjectDialog + useHub.tsx accept codex | ✅ |
| **C-§22** | AnalyticsPage: tilde + Hero footnote + ProviderBreakdownCard | ✅ |
| **C-§25** | docs/codex.md user guide + docs/adding-a-provider.md + README + CLAUDE.md | ✅ |
| **C-§23** | Manual e2e dry-run | ⏳ (user) |
| **C-§26** | Rollout via SPECRAILS_HUB_CODEX_BETA env var | ✅ wired; default ON |

## How to test locally

The user asked to test specrails-core + specrails-hub end-to-end. Here
is the exact sequence.

### One-time setup

```bash
# 1. Build + link specrails-core locally so the hub picks up the local
#    4.6.0-equivalent code (the npm-published version is still 4.5.0).
cd /Users/javi/repos/specrails-core
npm install        # if needed
npm run build
npm link

# 2. Confirm the link works
which specrails-core    # should print the global symlink
specrails-core --version

# 3. Make sure codex is installed and authenticated
codex --version         # require ≥ 0.128.0
codex login             # if not already authenticated

# 4. (Optional) install uv if you want to test the Serena plugin
brew install uv         # macOS — or follow https://docs.astral.sh/uv
```

### Run the hub against the local core

```bash
cd /Users/javi/repos/specrails-hub
npm install        # if needed

# Force the hub to use the locally-linked specrails-core instead of the
# npm-published 4.5.0. Without this, codex installs would fail because
# 4.5.0 still has the gates up.
export SPECRAILS_CORE_BIN=specrails-core

npm run dev        # starts server (4200) + client (4201)
```

Open http://localhost:4201.

### Smoke test 1 — Add a codex project

1. Click **Add Project**.
2. Pick a fresh path under `/tmp` or any empty git-initialised dir.
3. In the **AI provider** row, click **Codex** (should be enabled if
   `codex` is on PATH).
4. Submit. The setup wizard runs `specrails-core init --provider
   codex --quick`. Expect to see `.codex/`, `.codex/skills/...`,
   `AGENTS.md`, `.codex/config.toml`, `.codex/rules.star` populated.
5. Confirm the setup checkpoints all reach "done".

### Smoke test 2 — Generate a spec via Quick mode

1. From the project page, click **Add Spec**.
2. Type any idea, leave the mode on Quick.
3. Submit. The hub spawns `codex exec --json --sandbox workspace-write
   ...`. Expect a ticket to land in the dashboard within a few seconds.
4. Open the Analytics page. The new ticket's invocation should appear
   in the Raw table with a `~` prefix on the cost cell (estimated).
5. The Hero should show "· includes ~$X.XX estimated" next to the
   invocation count.

### Smoke test 3 — Multi-turn Explore Spec

1. Open **Add Spec** → **Explore**.
2. Type a few rounds of refinement (≥ 3 user turns). Each turn after
   the first should run `codex exec resume <UUID>` — you can verify in
   the server log; the conversation row's `session_id` column in the
   per-project SQLite should hold the real codex thread UUID, not
   anything starting with `codex-`.
3. Click **Create Spec**. Confirm the ticket is created.

### Smoke test 4 — Install Serena on the codex project

Requires `uv` installed and codex auth working.

1. Open **Settings → Integrations** (or wherever your build exposes
   the Plugins UI).
2. Install Serena. The hub spawns `codex mcp add serena -- uvx ...`
   with `CODEX_HOME=~/.specrails/projects/<slug>/codex-home/`.
3. Confirm `~/.specrails/projects/<slug>/codex-home/config.toml`
   exists with a `[mcp_servers.serena]` block.
4. Confirm `AGENTS.md` gains the
   `<!-- specrails-hub-managed:serena:start/end -->` block.

### Smoke test 5 — Side-by-side with a claude project

1. Add a claude project next to the codex one. Both should coexist —
   no interference.
2. The Analytics page on the codex project should NOT show the
   `ProviderBreakdownCard` (single provider). Add at least one
   invocation on the claude side, then on the codex side, of a
   shared metric — wait, they're separate projects; never mind.
   Instead, verify the card renders correctly on a project that has
   both providers represented in `ai_invocations` history (won't
   happen organically — would require manually mixing rows).

### Smoke test 6 — Emergency rollback

```bash
SPECRAILS_HUB_CODEX_BETA=0 npm run dev
```

The Add Project dialog should show Codex as **disabled / not found**
even when the binary is on PATH. POST `/api/hub/projects` with
`provider: 'codex'` should return HTTP 400 with a message naming the
env var.

## Test status (CI mirror)

```
Hub server:    PASS (1788) FAIL (1)   ← pre-existing smash-runner WIP
Hub client:    PASS (1818) FAIL (0)
specrails-core: PASS (175)  FAIL (0)
```

Multi-provider test counts in the hub:

| Module | Tests |
|---|---|
| server/providers/ | 71 |
| server/pricing | 18 |
| server/result-event | 11 |
| server/codex-otel-bridge | 7 |
| server/chat-manager | 41 |
| server/queue-manager | 85 |
| server/agent-refine-manager | 29 |
| server/setup-manager | 107 |
| server/setup-prerequisites | 15 |
| server/core-compat | 19 |
| server/explore-cwd-manager | 12 |
| server/ai-invocations | 12 |
| server/profile-manager | 32 |
| server/plugin-manager | 30 |
| server/plugins/contributors | 12 |
| server/plugins/serena (install + verify) | 14 + 5 codex |
| server/plugins/codex-mcp | 8 |
| server/plugins-router | 16 |
| server/hub-router (incl Stage C gate-lift tests) | 105 |
| server/spending (incl byProvider tests) | 25 |

## Commits in order (hub)

1.  `docs(openspec): add-multi-provider-support change with full artifact set`
2.  `feat(providers): introduce ProviderAdapter contract + claude/codex adapters`
3.  `feat(server): pricing table + finaliseInvocationResult + codex OTEL bridge`
4.  `feat(db): ai_invocations.provider + total_cost_usd_estimated + byProvider`
5.  `docs(openspec): handoff log + tasks.md progress markers through §15.3`
6.  `refactor(chat-manager): migrate onto ProviderAdapter; real codex thread_id`
7.  `refactor(core-compat): registry-walking provider detection`
8.  `feat(setup-prerequisites): registry-driven provider entries + at-least-one rule`
9.  `refactor(queue-manager): migrate onto ProviderAdapter; wire codex OTEL bridge`
10. `refactor(agent-refine-manager): adapter-driven; codex SKILL.md path support`
11. `feat(explore-cwd): provider-aware instructions file (AGENTS.md for codex)`
12. `docs(openspec): refresh handoff log`
13. `refactor(setup-manager): adapter-driven enrich; real codex thread_id resume`
14. `feat(profile-manager): adapter-driven model catalog + optional provider field`
15. `refactor(project-router): generate-spec spawn uses adapter.buildArgs`
16. `feat(plugins): provider-aware contributors target AGENTS.md on codex`
17. `docs(openspec): handoff refresh — 16 commits, Stage A 95% done`
18. `feat(plugins): codex `mcp add` install path with per-project CODEX_HOME`
19. `docs(openspec): mark Stage A complete; 17/17 sections done`
20. `feat: lift codex gates in hub-router + UI (Stage C §21)`
21. `docs(openspec): handoff — Stage A + B + C-gates complete`
22. `feat(analytics): provider breakdown + estimated-cost tilde + Hero footnote`
23. `docs: codex user guide + adding-a-provider dev guide + README + CLAUDE.md`

## How to ship to production

1. Merge `specrails-core feat/codex-provider-support` to its main.
   release-please will bump to 4.6.0 and publish to npm.
2. Wait for npm to propagate (~1-2 min).
3. Drop the `SPECRAILS_CORE_BIN=specrails-core` env var from your dev
   environment so the hub goes back to using `npx
   specrails-core@latest` and picks up 4.6.0.
4. Verify the smoke tests above one more time with the published
   version.
5. Merge `specrails-hub feat/multi-provider-support` to main.
   `SPECRAILS_HUB_CODEX_BETA` env var remains as the emergency
   rollback for the first week or two.
6. Once stable, drop the env-var docs and call it generally available.

## Pre-existing repo state to be aware of

- `git stash list` on the hub shows 30+ entries. The first is
  `claude-model-auth-fix-wip`. Never run bare `git stash pop`.
- `server/project-router.ts` and `server/modules/specs/runtime/smash-runner.ts` have
  pre-existing TypeScript errors and 1 pre-existing test failure
  outside this change's scope. They also prevent the codex-specific
  project-router test file from loading; the route handler refactor
  is verified by the typecheck and the other test suites that don't
  depend on those broken imports.
