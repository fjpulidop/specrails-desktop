## Context

Current `ProposeSpecModal` Explore mode renders four toggles (`Specrails specs`, `OpenSpec specs`, `Full repo read`, `External tools (MCPs)`) bound to the conversation's `contextScope`. Contract Refine just landed as a fifth dimension and a sixth toggle would crowd the modal further. In practice the user picks one of a handful of *named combinations* per project (debugging vs greenfield vs production-grade). A snap slider with 6 preset stops + a collapsible `▾ Fine-tune` disclosure keeps the fast path one-drag while preserving full editorial control.

Existing state in scope:

- `server/modules/conversations/runtime/context-scope.ts` already defines `ContextScope` `{ specrails, openspec, full, mcp }`, plus `defaultBootScope`, `normalizeContextScope`, `buildScopedSystemPromptPrefix`, `toolFlagsForScope`.
- `chat_conversations.context_scope` is a JSON column (no migration cost for new fields).
- `server/modules/specs/runtime/contract-refine-runner.ts` currently reads the project-wide `getExploreContractRefineEnabled` toggle. We want the per-conversation scope to be the source of truth for whether refine fires on commit; the project setting becomes the *modal default*.
- The Settings card toggle already exists (per project). It will keep working (gate retries; seed the modal's default value), only the label changes.

The slider is purely a UX layer over the same five booleans — it does **not** introduce a new persistent state shape on the server. Internally the modal still stores five booleans; the slider's preset stop is a *derived* value (closest matching combination, or `Custom` when no preset matches).

## Goals / Non-Goals

**Goals:**

- One-drag selection of context scope for 95% of cases; full editorial control via `▾ Fine-tune` for the remaining 5%.
- `contractRefine` joins the four existing flags as a first-class member of the per-conversation scope (not a parallel side-channel). The runner reads from the conversation, not from the project setting.
- Six preset stops with frozen v1 mapping (proposal.md). Adding/removing stops in the future is a follow-up change.
- Backward-compatible: legacy conversations (no `contractRefine` in `context_scope`) normalise to `false`; the project setting still drives retry eligibility.
- Accessibility: `role="slider"` ARIA pattern, keyboard navigation, focus ring, screen-reader-friendly stop labels.
- Touch support (Tauri webview + future mobile): pointer events, momentum-less snap on release.

**Non-Goals:**

- Custom presets per project (defer).
- Real token-count cost (defer; show relative `Nx` cost in v1).
- Visualising MCP server count in the cost line.
- Per-user remote preference sync.
- Showing the slider in Quick mode.
- Changing the runner's failure semantics or retry endpoint behaviour.
- Animation polish beyond `transform` transitions on the slider thumb.

## Decisions

### D1. Slider state model: 5 booleans drive the slider, not the reverse

**Chosen:** Internal state remains the existing five-boolean `ContextScope` extended with `contractRefine`. The slider position is a *pure derivation*: given the current booleans, find the matching preset (exact match) or render `Custom` (no exact match). Drag operations write back the five booleans of the target preset.

**Rejected alternatives:**

- *Slider as primary state, booleans derived.* Forces the slider's enum to be the source of truth, which would break the Fine-tune disclosure where the user can toggle individual flags off-preset.
- *Two-way binding via reducer.* Adds reducer complexity without a clear win — booleans are already mutated by Fine-tune checkboxes today.

**Why it works:** the slider is a "preset picker" view of the same booleans the modal already manages, so existing payload shapes (`onSubmit`, `add_spec_context_scope_last`) keep working unchanged.

### D2. The `Custom` indicator sits *between* the two nearest stops, no extra snap point

**Chosen:** When the current boolean combination matches no preset (e.g. `specrails=false, openspec=true`), the slider thumb floats between the two nearest stops at a position interpolated by cost rank, with a `Custom` label pill replacing the active-stop label. Dragging from `Custom` snaps to the dot under cursor on release — there is no "Custom" snap point users can drag *to*; you arrive at `Custom` only via the Fine-tune checkboxes.

**Rejected alternative:** add `Custom` as a 7th snap point. Doubles the visual noise and confuses "is this a thing I can drag to or not" — Custom is a *state*, not a destination.

### D3. `contractRefine` source of truth = conversation scope; project setting = boot default

**Chosen:** `runContractRefine` first reads `conversation.context_scope.contractRefine`. If the conversation has `false` → skip; if `true` → continue (still respects the env kill switch). The project-wide setting `getExploreContractRefineEnabled` is consulted *only* when the conversation lacks `contractRefine` (legacy migration path).

Retry endpoint behaviour: gates on the *project setting*, not the conversation, because a manual retry from the UI is an explicit user request that should not be blocked by a one-off per-conversation opt-out. Documented in the spec.

**Rejected alternative:** consult both; "OR" them. Confusing — users would not understand why an off-toggle still ran refine.

### D4. Slider implementation: headless pointer-events, no slider library

**Chosen:** Hand-roll the slider with `onPointerDown`/`onPointerMove`/`onPointerUp` on the rail, plus `keydown` for `←/→/Home/End`. ARIA `role="slider"`, `aria-valuemin=0`, `aria-valuemax=5` (six stops indexed 0–5), `aria-valuenow={stopIndex}`, `aria-valuetext={presetLabel}`. The thumb position is `transform: translateX(...)` for smooth drag; on release it animates to the snapped position via a 120ms `transition`.

**Rejected alternative:** Radix `<Slider>`. Overkill — discrete 6-stop snap with custom labels per stop is awkward to express through Radix's continuous range API. A 90-line component is cheaper to own and matches existing project style (`PanelChevronButton`, etc.).

### D5. Cost summary line copy is *relative*, not absolute

**Chosen:** Line below the slider reads (for the active stop):

- Minimal: `1× cost · fastest first-token · no specs loaded`
- Light: `1.3× cost · Specrails specs loaded`
- Standard: `1.6× cost · Specrails + OpenSpec specs loaded`
- Rich: `2× cost · full repo read access`
- Max: `4× cost · full read + Contract Layer refinement`
- Hub: `4–6× cost · all features + MCP servers loaded`
- Custom: `Custom mix — see Fine-tune below`

Relative cost (`Nx`) is robust to model price changes and easy to interpret without numbers. Absolute token/$ display is deferred.

### D6. Persistence shape: `add_spec_context_scope_last` extends with `contractRefine`

**Chosen:** The existing per-project last-used scope endpoint already accepts a free-form JSON; we simply add `contractRefine: boolean` to the payload. Boot order in the modal: (a) per-project `add_spec_context_scope_last` if present → (b) `defaultBootScope('explore', projectMcpEnabled, projectContractRefineEnabled)` derived from the two project settings.

`defaultBootScope` extends to accept the new boolean. Tests cover the two-arg legacy call site for compatibility.

### D7. Slider hides for Quick mode; Quick gets a standalone Contract Refine toggle

Quick mode has no `contextScope` plumbing today and the cost of giving it one would be a much bigger change. We keep the existing Quick modal layout (idea + attachments + model) and **add one extra row**: a standalone `Enrich with Contract Layer` toggle. The toggle's default value comes from the project setting; the per-project last-used value is persisted under `add_spec_quick_contract_refine_last`.

Quick's `POST /tickets/generate-spec` request body extends with `contractRefine?: boolean`. When `true`, the server schedules `runContractRefine(...)` after the ticket is created, identical to the from-draft path but with two differences:

- There is no parent Explore conversation, so the runner spawns `claude` *without* `--resume`. The system prompt is augmented with a one-shot context block that quotes the just-generated spec body (title + description). The marker user message is unchanged.
- The recorded `ai_invocations` row uses `surface='quick-spec'`. `conversation_id` is `null`. `ticket_id` is the newly created ticket.

The slider remains Explore-only; it is not rendered in Quick mode.

### D8. Contract Refine sits at the heavy end of the slider

The six-stop slider intentionally places `contractRefine=true` at `Max` and `Hub` only. Rationale:

- Refine is the most expensive of the five flags (one extra full claude turn).
- It is also the highest-value flag for downstream agent quality — the slider's gradient communicates "more scope → bigger output", which matches the Contract Layer's role.
- Users who want Refine at lower scope levels can enter Custom via the Fine-tune disclosure; the modal shows the `Custom` pill so the deviation is explicit.

This positioning is locked in v1 (proposal preset table). Future iterations may extract refine as an orthogonal axis if telemetry shows users wanting it independent of scope.

## Risks / Trade-offs

- **Hardcoded preset table risks looking arbitrary** → mitigated by D2 (Custom state when no match) plus the always-available `▾ Fine-tune`. Power users can always disagree with our presets and override.
- **Slider drag UX on Tauri webview** → pointer events work consistently across Chromium, Safari (Tauri default on macOS uses WKWebView), and mobile. Test on macOS DMG build before release.
- **`Custom` indicator can confuse users** → label copy and a `▾ Fine-tune` auto-open when entering Custom is a UX call. v1 keeps it manual.
- **Reading scope from conversation in the runner means deleted conversations break retry** → mitigated by retry endpoint reading the *project* setting, not the conversation scope.
- **Cost ratios are guesses, not measurements** → relative numbers are good enough for v1; replace with telemetry-driven figures in a future change once we have a few weeks of `ai_invocations` data.
- **Fine-tune disclosure could be missed** → render a subtle "Custom" pill on the slider when applicable to draw the user back to Fine-tune; default state of the disclosure is closed but with a chevron always visible.

## Migration Plan

- No DB migration — `context_scope` is JSON; `contractRefine` defaults to `false` when absent.
- Existing in-flight Explore conversations created before this change keep working: their `context_scope` lacks `contractRefine`; `normalizeContextScope` fills with `false`; refine does not fire automatically (matches current behaviour).
- Settings card label change is cosmetic; no behavioural shift for users who already toggled the project setting on.
- Rollback: revert the modal change + the runner's scope lookup; the project setting still drives behaviour as before.

## Open Questions

- **Should the slider snap labels translate?** Strings live in the modal which has no i18n today. Defer.
- **Should the Custom state auto-open the Fine-tune disclosure?** Leaning yes for v2 once we see usage data. v1 keeps it manual.
- **Should we ship a "Reset to project default" button next to the slider?** Useful when the user has been tinkering. Leaning yes, small `↺` icon button to the right of the slider rail. Tasks include it; final UX call during implementation.
- **Cost figures: do we standardise on a single reference model (sonnet) for the `Nx` numbers, or normalise per active model?** v1 uses sonnet as reference; document in copy.
