## Context

Today the Add Spec modal (`client/src/features/specs/components/ProposeSpecModal.tsx`) ships only Quick vs. Explore mode + a model picker. There is no way for the user to scope what context the model sees. Quick mode (`POST /tickets/generate-spec`) builds a one-shot prompt with no file tools. Explore mode (`chat-manager.ts` with `kind='explore'`) always spawns with Read/Grep/Glob/Bash open, from `explore-cwd` (or `<project>` when `explore_mcp_enabled=true`). Project-level toggle `config.explore_mcp_enabled` exists in `queue_state` and is exposed via `GET/PATCH /api/projects/:projectId/explore-mcp-enabled`.

Stakeholders: end users (cost-conscious + transparency), and the implement pipeline (downstream `ai_invocations` rows already track per-turn token + cost). The `ai_invocations` table is the truth source for post-turn deltas.

## Goals / Non-Goals

**Goals:**
- Four independent toggles surfaced in the Add Spec modal, configurable per-spec.
- Real, measurable impact on spawn behavior per toggle (no cosmetic-only flags).
- Visual cost-awareness meter that updates live and matches reality within ±25% on first turn.
- Per-project sticky persistence, with default boot derived in part from the global `explore_mcp_enabled`.
- Honest dynamic hint on the Quick chip when full codebase is on.

**Non-Goals:**
- Per-MCP-server granularity (the MCPs check is all-or-nothing for the `.mcp.json` set).
- Token estimates for the codebase beyond a coarse upper bound (we don't tokenize the repo).
- Retroactive replay of past Explore turns under a different scope.
- Surfacing the meter outside the Add Spec modal (Implement / Refine flows are out of scope).
- New billing model. `ai_invocations` capture is unchanged.

## Decisions

### D1 — Toggles are independent; meter is a derived view
Each of the four toggles maps to a real spawn-side change. The Cost Awareness meter is a pure function of the active toggles (+ a cached budget snapshot from `/context-budget`); it never gates submit.

Rationale: simpler mental model, meter can't drift from behavior because it's computed from the same input.

Alternative considered: a single "scope tier" enum with presets. Rejected — defeats the configurability goal.

### D2 — `Full codebase` OFF in Explore passes `--disallowed-tools Read,Grep,Glob,Bash`
The CLI flag is the cleanest, well-supported mechanism. ChatManager appends it to the spawn argv when the per-conversation scope has `fullCodebase=false`.

Rationale: avoids inventing a hub-side tool filter, leverages claude CLI's native gate.

Alternative considered: prompt-side instruction "do not use file tools". Rejected — non-binding, model will still sometimes invoke them, defeating cost goal.

### D3 — `External MCPs` toggle controls spawn cwd, overriding global setting per-turn
When ON, spawn `claude` from `<project.path>` so `.mcp.json` is auto-loaded. When OFF, spawn from `explore-cwd`. The global `explore_mcp_enabled` becomes the **default boot value** for new Explore sessions; the per-modal toggle is the per-spec override.

Rationale: keeps the existing escape hatch (`SPECRAILS_EXPLORE_LEGACY_CWD`) intact, doesn't fork the cwd resolution path.

Alternative considered: derive cwd purely from the modal toggle and deprecate the global setting. Rejected — global setting is already documented and lets users set a default without opening every modal.

### D4 — `specrails specs` and `openspec specs` inject content via the system prompt (Quick + Explore)
For Quick: concatenate file bodies into the system prompt before the user idea. For Explore: same, and additionally allow Read on those paths even when `Full codebase=false` (whitelist via `--allowedTools`).

Rationale: predictable, deterministic, cache-friendly. Avoids relying on the model to discover the right files.

Alternative considered: mount as files-only context via a symlink in explore-cwd. Rejected — still requires Read to be allowed, defeats the whole point of `Full codebase=false`.

### D5 — Cost meter has two layers: qualitative tier + numeric estimate
Tier from toggle weights (specrails=1, openspec=2, mcp=2, full=4); thresholds 0=Light, 1–2=Medium, 3–5=Heavy, 6+=Deep. Numeric estimate from `GET /context-budget` (computed server-side, cached 60s) × selected toggles × model unit price.

Rationale: tier always-visible (resilient to budget-fetch failure); numeric is the precision layer.

Alternative considered: only numeric. Rejected — fragile when budget endpoint is slow or fails on a fresh project.

### D6 — Persistence in `queue_state`, not a new table
Single key `add_spec_context_scope_last` with JSON value `{ specrails, openspec, full, mcp }` (Explore values; Quick reuses the same record but ignores `mcp`).

Rationale: matches existing pattern for `explore_mcp_enabled`. No migration churn.

Alternative considered: separate Quick vs. Explore records. Rejected — small win, doubles surface area.

### D7 — Submit button color shift uses semantic tokens
`accent-success` (Light), `accent-info` (Medium), `accent-warning` (Heavy), `accent-secondary` (Deep). No hardcoded brand colors.

### D8 — First-turn delta toast uses existing `ai_invocations` capture
After the first assistant turn settles, client computes `delta = actualTokens - estimatedTokens` from the `spending.invalidated` WS event payload (extended to carry the just-recorded invocation's totals, or via a follow-up GET to the invocations endpoint filtered by `surface_ref_id`/`conversation_id`).

Rationale: zero new server state; reuses the canonical truth source.

## Risks / Trade-offs

- **Codebase token estimate is coarse** → mitigation: `/context-budget` returns `codebaseFileCount` + a heuristic (sum of file sizes / 4) and the numeric line shows it as `~Xk (rough)` when `full=true`. Tier remains accurate.
- **Disallowed-tools spawn flag may not block Bash on all claude CLI versions** → mitigation: also strip Bash from `--allowedTools` if that mechanism is in use; verify on the pinned claude version in CI.
- **MCPs toggle per-spec confuses users who set the global ON** → mitigation: default boot of the modal toggle = global value; tooltip cites the global setting.
- **specrails specs concat can blow the system prompt** → mitigation: hard cap at 30k tokens of concatenated specs; truncate with a "(truncated)" marker and surface in the numeric estimate.
- **Quick mode with Full codebase loses the "fast" promise** → mitigation: dynamic hint `~45s` replaces `~15s` so the user is not misled. No artificial gating.
- **Stale persisted scope after schema changes** → mitigation: JSON is shape-validated on read; unknown keys ignored; missing keys fall back to default boot.

## Migration Plan

No DB migration. `queue_state` is a key/value table — first read of `add_spec_context_scope_last` returns nothing → default boot applies → first PATCH writes the row.

Rollback: revert the change. Persisted rows become orphans (harmless, ignored).

## Open Questions

- Should `Full codebase` ON in Quick also pass `--allowedTools` whitelisting to keep it cheap, or accept that the model may invoke Bash too? → Initial answer: Quick with Full codebase still does NOT allow Bash by default (read-only exploration); tasks will codify.
- Numeric meter precision target: ±25% on first turn — is this acceptable? → Initial answer: yes, validated by the delta toast loop.
- Should the post-turn delta toast persist after the first turn? → Initial answer: no, only the first turn of a fresh conversation, to avoid noise.
