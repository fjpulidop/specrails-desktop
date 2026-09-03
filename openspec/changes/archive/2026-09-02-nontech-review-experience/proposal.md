# Non-tech premium review experience

## Why

A non-technical user who commissions work through Specrails hits three trust cliffs today: while the run executes they see raw CLI logs they cannot read; when it settles they face raw git vocabulary ("Create PR / Integrate locally / Discard") with no legible proof of what was done; and asking for a small tweak is expensive machinery instead of a sentence. The still-open `safe-pr-workflow` change already carries the unimplemented SHALL requirement ("plain-language what-changed + proof bundle; the builder-facing surface SHALL NOT expose raw git vocabulary") — this change discharges it and completes the commission model: *encarga, no vigiles* (commission the work, walk away, return to a decision you can make alone).

A 10-agent verification pass against the codebase (2026-07-27) corrected the original framework's plumbing assumptions; this proposal is built on the verified substrate: the delivery **generation model** (new superseding row per follow-up, never same-row mutation), the shipped post-PR continuation machinery, eager settle-time data (`file_story_contributions`, PR-body composers), the unread `confidence-score.json` reviewer verdict, and deterministic `loop_step` events.

## What Changes

Three waves, each independently shippable behind flags:

**Wave 1 — Evidence foundations (small, unblocks everything)**
- Eager settle-time evidence harvest persisted on the delivery row: `confidence-score.json` (sr-reviewer's machine-readable verdict — currently read by NOTHING), the `VERIFICATION: PASS/FAIL` sentinel, and the verify step's output tail.
- Spec snapshot (title/description) captured onto the delivery row at LAUNCH so the packet shows what the user actually asked (today it resolves from the live store and can drift).
- Duration percentile query over `loop_runs.total_duration_ms` / `jobs.duration_ms` (honest ranges; render nothing below a minimum sample count).
- "Stuck" native notification wired from the existing per-step activity checkpoints (done/failed notifications already ship via `useOsNotifications`).

**Wave 2 — The review packet (the core)**
- A server-composed, durable **review packet** per delivery generation: family of variants (Success / Nothing-to-change / Partial N-of-M / Failed), inverted pyramid (one-line verdict + confidence pill + decision buttons above the fold; sections behind progressive disclosure).
- Proof tiered by epistemic source and labeled: APP-VERIFIED (diff stats, decider verdict, shell exit codes) / AI-REPORTED (sentinel + verify prose, explicitly labeled) / REVIEWER SCORE (confidence-score.json aspects + flags). Never a number without a structural source.
- Human decision verbs (Accept / Request changes / Discard) as a PRESENTATION layer over the existing ~14 presentation states; ladder pre-resolution from shipped probes (gh auth + remote); merge-local NEVER hides behind Accept — plain-language consequence confirm.
- Cost transparency: per-cycle cost line (composer exists) + cumulative across the generation chain.
- Generated prose in the user's app language (all 8 locales).
- Rendered on EXISTING surfaces via the shipped sync machinery: a routed full-screen page + the agent-chat card; no third Q&A brain ("ask the packet" routes into agent chat with delivery context).

**Wave 3 — Cheap revisions + narrated progress**
- One-sentence revision from the packet: new superseding **generation row** (packet v2 = the row chain; "Back to version 1" rides the shipped restore lineage), fresh-seeded session from durable context (spec + PR body + branch diff + harvested evidence + the sentence), Architect-less revision loop (desktop-only, zero core coupling).
- The one genuinely missing door: an `on_review` revision exemption in the 409 `pr_decision_pending` guard (and its duplicated MCP copy); post-PR revisions already work via shipped continuation.
- Drift-driven reshape nudges (cumulative cost + out-of-scope file churn thresholds, count as backstop) instead of a hard 3-revision limit; explicit failed-revision packet ("your change could not be applied — version 1 is still on review").
- Deterministic narrated progress: i18n-templated milestones from `loop_step`/`loop_step_end`/tool events as a third altitude behind the shipped Story|Log toggle pattern — all providers, zero model cost. (LLM catch-up digest deliberately deferred to a future change if templates test as insufficient.)

**Explicitly out of scope**: screenshots/preview (user decision — revisit "Open preview" for web projects as a follow-up), live per-event LLM narration, a new chat_conversations kind, specrails-core changes (structured test counts + delta-scoped verification are a parallel core ask tracked separately — revision speed improves when they land but nothing here depends on them).

## Capabilities

### New Capabilities
- `delivery-evidence`: eager settle-time harvest of verification evidence (confidence score, sentinel, verify tail) + launch-time spec snapshot persisted on the delivery generation row; honest duration percentiles; stuck detection signal.
- `review-packet`: the plain-language review packet family — composition, proof tiers, human decision verbs with ladder pre-resolution, cost lines, localization, and rendering on the existing synced surfaces.
- `delivery-revisions`: one-sentence revisions as superseding delivery generations — on_review launch door, fresh-seed revision loop, version lineage UX, drift nudges, failed-revision handling.
- `narrated-progress`: deterministic plain-language milestone narration for job/loop views + stuck notifications + honest duration ranges.

### Modified Capabilities
- `implementation-delivery-lifecycle`: the 409 `pr_decision_pending` guard learns an on_review same-ticket-set revision exemption; delivery rows gain evidence/spec-snapshot/revision-sentence fields; revision launches ride the existing generation/supersession model (no new decision states on the wire).

## Impact

- **Server**: `rail-pr-store.ts` (evidence + snapshot columns, generation metadata), `rail-isolated-launch.ts` (settle-time harvest before worktree release), `rails-router.ts` + `server/mcp/tools/rails.ts` (guard exemption, duplicated copy), `rail-pr-decision.ts` (packet-aware verbs), new packet composer module, `loop-factory.ts`/`loop-templates.ts` (revision loop), percentile query, `ai-invocations.ts` (no new surface in v1 — narration is deterministic).
- **Client**: new routed packet page (JobDetailPage precedent — avoids the z-order ladder), `RailPrDecisionStrip`/`AgentPrDecisionCard` integration via the existing `derivePrDeliveryPresentation` + `act()` machinery (no optimistic state), narration view behind Story|Log toggle, i18n ×8 (key-parity test), semantic theme tokens, coverage gates 80% server / 80% client.
- **Wire-compat**: NO new decision enum values (verified hazard: unknown decisions make `coerceRailPrStateSnapshot` return null — the card vanishes on stale clients); revisions reuse `building`/`superseded`; mobile `hub.*` contract untouched.
- **Cross-repo (parallel, non-blocking)**: specrails-core ask — structured test counts in `confidence-score.json` + delta-scoped verification (pipeline-cost-economy program).
- **Supersedes**: discharges the deferred "plain-language Review & Approve bundle" SHALL from the open `safe-pr-workflow` change (its stale tasks 7.1/7.2 reference the retired `rail.pr_delivered` toast).
