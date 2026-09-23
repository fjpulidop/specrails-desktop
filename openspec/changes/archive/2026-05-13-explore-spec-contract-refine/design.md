## Context

`ExploreSpecShell` (client) and `ChatManager` (server, `kind='explore'`) produce a structured spec draft as the user converses with Claude. The committed draft is short, intent-focused (title, description, labels, priority, acceptanceCriteria), and goes to `POST /tickets/from-draft`. Downstream consumers — the Architect → Developer → Reviewer agent chain that specrails-core dispatches — then rebuild a lot of *implicit* context from these short bodies: enum names, exact file paths, function signatures, edge cases, invariants. Each agent reinvents these anchors differently, producing divergence the user must fight in review.

This change adds a **Contract Layer** to every committed Explore spec, populated by a **dedicated refinement turn** that runs after the user has clicked `Create Spec`. The refinement turn's only job is to produce prescriptive anti-reinvention anchors (exact identifiers, data shapes, file touch list, invariants, state-machine sketches when applicable) appended to the spec body. Because the refinement runs after commit, it does not block the user; because it runs as a separate Claude turn with a focused system prompt, it does not pollute the initial conversation; because it is additive (it appends a section, it never rewrites user-authored text), it is safe to degrade or skip on failure.

Current state of relevant surfaces:

- `server/modules/conversations/runtime/chat-manager.ts` already implements an Explore lifecycle (idle-kill on minimize, crash auto-respawn, concurrency cap of 5). The refine turn plugs into this lifecycle as a new sub-step.
- `server/modules/conversations/runtime/explore-cwd-manager.ts` provides hub-managed cwd materialisation. The refine turn reuses it (same cwd resolution as a normal Explore turn — respects `contextScope.mcp`).
- `server/modules/accounting/runtime/ai-invocations.ts` already records every Explore turn. The refine turn writes a row through the same path; spending analytics absorb it transparently.
- `server/project-router.ts` already exposes `explore-mcp-enabled` toggle endpoints — the new `explore-contract-refine-enabled` endpoints mirror that shape exactly.
- `SettingsPage` already renders an "Explore Spec" card — the new toggle drops in without restructuring.
- The Explore system prompt is byte-stable across turns (cache-warmth invariant). The refine turn is a *different* prompt: it does not need to be byte-stable across refines (each one runs once per spec), but it MUST be byte-stable across two refines for the same `(conversationId, draft snapshot)` so retries are cheap.

## Goals / Non-Goals

**Goals:**

- Add a Contract Layer to committed Explore spec bodies, structured as exactly five labelled subsections: `Naming Contract`, `Data Shapes`, `State Machine`, `Invariants`, `File Touch List`. The refine turn fills each; empty subsections render `_N/A — <reason>_` rather than being omitted.
- Run the refinement as a single, non-iterative Claude turn whose system prompt is purely structural (no domain re-interpretation), so it cannot contradict the user-authored body.
- Make refine **opt-in per project** via a new `config.explore_contract_refine_enabled` key in `queue_state` (default `false`). Endpoints `GET/PATCH /api/projects/:projectId/explore-contract-refine-enabled` mirror the existing `explore-mcp-enabled` shape.
- Run refine **after commit**, asynchronously, so the user perceives zero added latency on `Create Spec`. The user sees a `Afinando contrato…` status pill on the ticket card (or in the SpecsBoard toast region) until the refine completes and the description is patched.
- Record every refine turn in `ai_invocations` with `surface='explore-spec'`, `conversation_id` = parent Explore conversation, `ticket_id` = newly committed ticket (back-filled by the same mechanism `from-draft` already uses).
- Provide two escape hatches: (a) per-project toggle off, (b) server env `SPECRAILS_EXPLORE_CONTRACT_REFINE=0` to force-disable hub-wide.
- Spec body remains valid markdown — Contract Layer appended below a horizontal rule (`---`) so existing renderers / archivers don't choke.

**Non-Goals:**

- Quick mode (`POST /tickets/generate-spec`) refinement. Quick = fast by definition; revisit only after Explore refine proves value.
- Iterative refine (multi-turn until "complete"). Single-shot only in v1 — predictable cost and latency.
- Per-feature model override (e.g., force Haiku for refine). Refine uses the **same model** as the parent Explore conversation in v1. Cost optimisation is a follow-up change once we have spending data.
- User-visible diff or accept/reject of the refinement output. Refine output is appended, the user can edit the ticket body normally afterwards.
- Edit-mode integration: re-running refine when the user edits an existing ticket via `editTicket`. Out of scope for v1 — refine fires once, at first commit.
- Modifying the existing Explore system prompt to *suppress* contract details from the user-facing draft. The draft already focuses on intent; adding refine does not require gagging the main conversation. (Re-evaluate after dogfooding.)
- Backfill of historical tickets that pre-date this feature.

## Decisions

### D1. Single post-commit refine turn (not pre-commit, not iterative)

**Chosen:** One refine turn, fired asynchronously after `POST /tickets/from-draft` (or the flip-in-place draft path) returns successfully. Refine reads the just-committed ticket body + the full Explore conversation history and outputs a Contract Layer block that the server appends to the ticket description via a follow-up `PATCH /tickets/:id`.

**Rejected alternatives:**

- *Pre-commit refine, blocking the user.* +3-8s latency on every `Create Spec` click — kills the snappiness the Explore UX optimises for.
- *Inline refine as part of the main Explore conversation* (just nudge the model to emit contract data in the final `spec-draft` block). The Explore prompt is optimised for intent + interactivity; bolting contract structure on it doubles the prompt size and competes for the model's attention. Two prompts, two turns, two budgets is cleaner.
- *Iterative refine (re-ask until "complete").* Unbounded cost/latency, hard to evaluate convergence, contradicts v1's goal of predictability.

**Why this works:** Async + opt-in + degrade-on-failure means worst case is "user gets the same ticket they would have got without this feature". Best case is a much richer spec body for the downstream agents.

### D2. Refine output is appended below `---`, not stored separately

**Chosen:** The refined Contract Layer is concatenated to the ticket's `description` field, separated by `\n\n---\n\n## Contract Layer\n\n...`. No new table, no new field on `local-tickets.json`.

**Rejected alternatives:**

- *Store `contract_layer` as a sibling field on the ticket row.* Forces every consumer (specrails-core, the agent chain, JSON exports, third-party tools that read `local-tickets.json`) to learn a new schema. The whole point is to feed agents — keep it in the description body the agents already read.
- *Store as an attachment.* Same problem + attachments aren't pulled into agent context.

**Tradeoff:** Tickets get longer. Mitigation: SpecsBoard card preview already truncates description; the Contract Layer's `---` separator gives the renderer a natural fold point. The `TicketDetailModal` renders the section collapsed by default (chevron to expand), preserving scanability for humans while keeping the full body in `description` for agents.

### D3. Refine runs in the same lifecycle as Explore turns, not a separate spawn pool

**Chosen:** `ChatManager` exposes `runContractRefine(conversationId, ticketId)`. It reuses the existing Explore concurrency cap (5 per project), idle-kill semantics, crash auto-respawn, cwd resolution, and `--resume <session_id>` flow. Concretely, the refine is spawned as the next turn in the same Claude conversation, with a marker prompt (e.g. `/specrails:contract-refine`) that switches the system prompt for that turn only.

**Rejected alternatives:**

- *Spawn a fresh `claude` process with no resume.* Loses prompt-cache warmth (Explore system prompt is byte-stable specifically to keep the cache hot — re-using `--resume` extends that into refine). Also loses access to the conversation history that the refine prompt needs to interpret context.
- *New dedicated lifecycle subsystem.* More code, more invariants to maintain, no upside.

**Constraint introduced:** Refine counts against the per-project concurrency cap. With cap=5 and refine running ~5-10s after commit, this is fine for realistic load (humans don't commit 5 specs in 10s). If it becomes a problem, raise the cap or add a separate refine slot — defer the decision.

### D4. Refine system prompt is structural-only and explicitly read-only

**Chosen:** The refine system prompt:

1. Forbids the model from changing the user-authored part of the ticket.
2. Forbids opening any tool (Read/Grep/Glob/Bash) regardless of the parent conversation's `contextScope.full` — refine works from the conversation transcript + the committed ticket body only.
3. Demands output in a strict fenced block tagged `contract-layer` (analogous to `spec-draft`) with a known JSON shape:

   ```json
   {
     "namingContract": { "enums": [...], "fields": [...], "functions": [...], "files": [...] },
     "dataShapes": [ { "name": "...", "ts": "..." } ],
     "stateMachine": "...ascii diagram or null...",
     "invariants": [ "..." ],
     "fileTouchList": [ { "path": "...", "action": "create|extend|delete", "reason": "..." } ]
   }
   ```

4. Includes a few-shot example so the model emits a clean block on the first try.

**Why read-only:** Refine has no business doing fresh codebase research — that's what the Explore phase was for. Read-only refine is faster, cheaper, and incapable of mid-flight contradictions with the user-authored intent.

**Why a parseable block (not raw markdown):** The hub renders the block into a deterministic markdown subsection. This means the rendered shape is owned by the hub, not the model, so we can iterate the rendering (collapse, syntax-highlight, etc.) without re-prompting.

### D5. Toggle storage and defaults

**Chosen:** New `queue_state` key `config.explore_contract_refine_enabled`, default `false`. Endpoints:
- `GET /api/projects/:projectId/explore-contract-refine-enabled` → `{ enabled: boolean }`
- `PATCH /api/projects/:projectId/explore-contract-refine-enabled` body `{ enabled: boolean }`, 400 on non-boolean.

Defaults to `false` because: (a) the feature is new and unvalidated, (b) adds cost, (c) appends content the user might not want. Off-by-default + opt-in via SettingsPage is the safe path.

**Rejected alternative:** Default `true`. Premature — wait until we've seen at least one project's worth of spending impact and at least one downstream agent run that quantifies the improvement.

### D6. Spending capture: refine row vs. roll-up

**Chosen:** Write a separate row in `ai_invocations` per refine turn, `surface='explore-spec'`, with `conversation_id` set to the Explore conversation id and `ticket_id` set to the newly committed ticket id. This matches how Explore turns are recorded today — the refine just appears as one more turn on the same conversation, which is what it actually is.

**Why not a dedicated surface name like `'explore-spec-refine'`:** Would force `server/modules/accounting/runtime/spending.ts`, the analytics dashboard, the CSV export schema, and every filter chip to learn a new value. The cost-vs-value ratio of a finer-grained breakdown in v1 is poor. If we later want to isolate refine spend, add a `mode` column or a derived filter — don't fork the surface enumeration.

### D7. Refinement failure is silent + non-blocking

**Chosen:** If refine fails (model error, `chat_error`, crash beyond auto-respawn, malformed `contract-layer` block, timeout 60s):

- Log a server warning with `conversationId`, `ticketId`, and the failure category.
- Emit a project-scoped WS event `explore.contract_refine_failed { ticketId, reason }`.
- The ticket body is **not** patched.
- The user sees a small toast (sonner) on the SpecsBoard surface with copy "Contract layer skipped — ticket saved without it" and an action `Try again` that re-invokes the refine on that ticket id.

**Why not auto-retry:** Auto-retry on top of the existing crash auto-respawn would conflate two layers of recovery. Crash recovery handles transient claude failures; a refine-level failure is final unless the user opts back in.

### D8. Spec generator prompt does NOT change in v1

**Chosen:** Leave `/specrails:explore-spec` system prompt unchanged. The refine layer is purely additive — the user-facing draft pane and conversation behaviour are identical to today.

**Rejected alternative:** Strip naming/contract hints out of the main Explore prompt so the model focuses purely on intent. Tempting (cleaner separation of concerns), but high-risk: the main prompt is byte-stable today, has dozens of tests against scenarios, and changing it has compound effects on cache hit rate and turn quality. Defer to a follow-up change.

## Risks / Trade-offs

- **Refine model contradicts user-authored body** → System prompt explicitly forbids modifying user fields; refine only emits Contract Layer block; hub appends, never rewrites. If the contract block references field names that don't appear in the user body, the agent chain may diverge — mitigation is a *post-parse validation* step (warn on identifiers in `namingContract` that aren't substring-present in the description, but do not block).
- **Cost doubles per committed Explore spec** → Refine uses the parent conversation's model, which can be opus for heavy users. Mitigation: off-by-default, per-project toggle, hub-wide kill switch. Future work: Haiku for refine (D3 in non-goals).
- **Refine spawns saturate the concurrency cap** → A single user committing 5 specs in 10s queues every refine. Acceptable in v1; the failure mode is "Contract Layer skipped on N specs", which degrades to no-feature. Revisit if telemetry shows this firing in practice.
- **Appended Contract Layer makes ticket bodies long and harder to scan** → `TicketDetailModal` renders the Contract Layer collapsed by default; SpecsBoard preview ignores content after the `---` separator.
- **`contract-layer` block parsing diverges from the `spec-draft` parser** → Build the new parser on top of the existing `parseSpecDraftBlock` infrastructure (same fenced-block discovery, same JSON.parse-with-fallback, same WS-scrub of the raw block from chat content). Two parsers, one foundation.
- **Existing `from-draft` flip-in-place path complicates refine triggering** → Refine fires on the *resulting* ticket id regardless of whether the commit created a new row or flipped a draft. Single trigger point in `chat-manager` after the existing `ticket_created`/`ticket_updated` broadcast.
- **Tests for `explore-spec` capability are extensive** → Refine code is gated behind toggle OFF; existing test suite must continue to pass unmodified. New tests live in dedicated files (`explore-contract-refine.test.ts`, etc.) and only fire when the toggle is ON.
- **Cache invalidation when prompt changes** → The refine prompt is byte-stable per `(template version)` but **different** from the main Explore prompt. First refine on a hot Explore conversation is a cache miss for refine's system prompt (the rest of the context — conversation transcript — stays warm via `--resume`). Cost impact accepted.

## Migration Plan

- No schema migration: `queue_state` is a key/value table; new key materialises on first PATCH.
- Default OFF on every existing project. Users opt in from `SettingsPage`.
- No backfill of historical tickets — refine fires only on commits that happen *after* the feature is enabled.
- Rollback: flip `SPECRAILS_EXPLORE_CONTRACT_REFINE=0` env var on the hub to disable feature-wide, or PATCH per-project toggles off. Tickets already committed with Contract Layer retain it (it's just markdown).
- Release behind a flag at first; once telemetry confirms cost/quality, consider flipping default ON via a follow-up change (separate proposal).

## Open Questions

- **Should the refine prompt include the project's `<project>/.specrails/specs/**`?** When the parent conversation already had `contextScope.specrails=true`, the model has seen these specs. When it didn't, the refine could optionally read them to ground identifiers in existing project conventions. Defer to a follow-up change — measure first whether refine quality without this is good enough.
- **Should refine emit a `version` field in the `contract-layer` block** so future parser changes can be backwards-compatible? Leaning yes (`"contractVersion": 1`). Decide during specs phase.
- **Refine timeout (60s) vs. concurrency cap interaction**: if a refine is queued behind 5 streaming Explore turns and waits > 30s (existing `busy` cap), should it timeout earlier or piggyback on the existing cap? Leaning piggyback — refine is just another turn for the lifecycle. Specs phase locks this in.
- **UX of the per-ticket "refine pending" indicator**: a sonner toast on SpecsBoard vs. a spinner overlaying the ticket card vs. a pill in the ticket detail modal. Need a UX call. Default to sonner toast (least invasive, matches existing spec-generation pattern).
