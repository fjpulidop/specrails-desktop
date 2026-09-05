# Project Builder — as-built internals

> OpenSpec change `add-project-builder`. Greenfield project creation from an
> idea: a day-0 blueprint conversation, an orchestrated bootstrap commit, and a
> milestone lifecycle (Launch M1 batch rail, sidebar re-entry, Generate M2+).

> **Kimi capability boundary:** Kimi may be selected as a target provider for
> the materialized project, and it may launch an already committed milestone
> through the normal agentic Batch rail. Day-0 blueprint snapshots and M2+
> milestone generation are pure structured-output actions and therefore fail
> closed for Kimi 0.27 `-p`; no Kimi process is spawned for them.

## Entry + builder mode (reskin)

"+ Add Project" shows an **Existing | New** pre-screen (`AddProjectDialog`,
`chooser-existing` / `chooser-new` cards) when both `FEATURE_PROJECT_BUILDER`
(client) and the parent-wired `onOpenBuilder` callback are present. *Existing*
continues into the unchanged AddProjectDialog/setup-wizard flow; *New* calls
`AgentChatContext.builderMode.enter()` — the AGENT transforms into the Builder
(change `reskin-project-builder-into-agent-panel`; the original full-screen
`ProjectBuilderShell` overlay is deleted). Flags:
`VITE_FEATURE_PROJECT_BUILDER` (client) / `SPECRAILS_PROJECT_BUILDER` (server),
both default ON, `"false"` opts out (server flag 404s every `/api/blueprint/*`
route).

**Builder mode (client architecture):**

- `builderMode` slice on `AgentChatContext`: `{ active, enter, exit, session }`.
  `enter()` also opens the floating panel outside Agent Mode; `exit()` aborts
  the in-flight builder turn (`POST /abort`) and resets every session slice.
  The agent's own chrome (project/mission selectors, conversation, queue,
  pinned cards) is hidden while active but NEVER unmounted.
- Session logic in `client/src/hooks/useBuilderSession.ts` (extracted from the
  retired shell): bootstrap, `blueprint.*` WS handling with NULL-SAFE identity
  checks (a pre-bootstrap/pre-commit null ref must never match a null/absent
  message id), phases, snapshot, send/commit/launch actions, `dirty` flag.
- `BuilderConversation` (`client/src/components/project-builder/`): the four
  phases in the MISSION format — chat renders a centered message column with
  the `BuilderComposer` docked at the bottom (centered card while empty,
  mission-style); in Agent Mode the hero and docked cards share a `layoutId`,
  so the first send morphs the agent smoothly down. Then commit
  (`BlueprintCommitForm`), progress step list, done (Launch M1 / Open project).
  Esc: commit→chat, chat→exit (confirm-gated when dirty).
- `BuilderComposer`: mirrors the mission composer's visual language — the SAME
  provider/model/effort selectors (provider/model bind to the blueprint
  conversation; reasoning effort is validated against the selected provider
  and rides each send), surprise-me chip, native `resize-y` textarea, and the
  same `SendHorizontal` action. Models and effort levels come from
  `GET /api/blueprint/models?provider=`.
- `BuilderHalo`: orbiting ring — CSS `builder-halo-spin` keyframes over an
  XOR-masked conic-gradient border band (follows ANY radius: circular on the
  bubble/panel-header icon, card radius on the composer; no per-frame JS),
  `motion` enter/exit, `prefers-reduced-motion` ⇒ static glow. It is strictly
  an ENTRY flourish: shown on the fresh empty composer and the matching
  bubble/panel-header identity, then removed as soon as the first work message
  begins. Builder mode itself continues without a halo; there is no wind-down.
- Per UI mode: **board** — `AgentChatPanel` widens (860px) and gains an
  attached blueprint side pane; **Agent Mode** — `AgentModeSurface` renders
  the builder conversation and `AgentWorkspaceSidebar` swaps (AnimatePresence)
  to `BlueprintPanel` + the Create-specs CTA, forced-expanded for the duration.
- The builder conversation stays on `blueprint_conversations` / `blueprint.*`
  — never mixed into `agent_conversations` or the mission selector.
- `BlueprintPanel` M1 spec cards are clickable → `BlueprintSpecModal`
  (hand-rolled body portal at z-[65], same tier as `LoopPreviewModal`; Esc +
  backdrop close). At day 0 the specs are NOT tickets yet (only in the
  snapshot), so this is a lightweight read-only preview — NOT the heavy
  `TicketDetailModal`. Cards expose `shortSummary`, priority, and acceptance-
  criteria count; the modal exposes the summary, priority, canonical five-
  section description, and every separate acceptance criterion. The same panel
  (and therefore the modal) is reused in the M2+ `MilestoneGenerateShell`, so
  the user reviews the content that will become the authoritative tickets
  (apart from the deterministic criteria fold). The detailed M2+ preview is
  transient; the blueprint has no per-milestone detailed-spec collection.

## Day-0 chat (no project exists)

**Decision cards (`BuilderDecisionCard`).** The interview prose keeps
asking the user to type "surprise me" and, once the five dimensions are
decided, to "approve the blueprint" — and the hero composer's Surprise-me
button only exists before the first turn (`showSurpriseMe`). Each ask gets ONE
premium card in the thread (same glass shell as `AgentSpecDraftCard`: accent
header band, identity chip, CTA pill, `motion` enter/exit, reduced-motion
safe) in two modes. **Offer** — clickable, rendered after the newest SETTLED
Builder reply by a deterministic rule (no prose detection): `phase === 'chat'`,
not busy, no stream buffer, last message is the assistant's, snapshot not
`generating`; `surprise` while the readiness `blueprint` step is not `done`,
`approve` once it is `done` and no M1 spec exists yet (specs step pending with
count 0). One click sends the canonical prompt (`prompts.surpriseMe` /
`prompts.approve`) through `session.surpriseMe()` / `session.approveBlueprint()`
tagged with an **intent**. **Settled** — the user turn that carried the intent
renders as the non-clickable "Decision taken · time" card IN PLACE of the raw
prompt bubble, so the decision stays fixed in the thread; the intent is
PERSISTED on the message row (`blueprint_messages.intent`, desktop-db
migration 24; `POST /send { intent: 'surprise' | 'approve' }`, validated,
anything else dropped; `GET /conversations/:id` returns it) so it survives a
resume and a locale switch. i18n `builder:decisionCard.*` + `prompts.approve`
×8.

The provider selector excludes adapters that cannot enforce the blueprint
generator's pure-output policy. A direct Kimi request is rejected before
`BlueprintChatManager` spawns. This does not prevent the approved blueprint
from declaring Kimi among the new project's target providers.

- **Manager**: `server/blueprint-chat-manager.ts` `BlueprintChatManager` — an
  app-level sibling of `AgentChatManager` reusing `runAiCliInvocation`. Spawns
  from `~/.specrails/builder-cwd/` (`server/builder-cwd-manager.ts`: always
  re-written instruction files from `server/blueprint-operator-prompt.ts`, NO
  `./project` symlink, NO MCP). Auto-heal: a resume that yields no text retries
  fresh once. Abort keeps partial text and records `aborted`.
- **Persistence**: `blueprint_conversations` / `blueprint_messages` in
  `desktop.sqlite` (migration 22; CRUD in `server/blueprint-store.ts`).
- **WS**: app-global `blueprint.stream` / `blueprint.done` / `blueprint.error`
  (no `projectId`; NOT in the mobile-ws translation layer). `blueprint.done`
  carries the STRIPPED `fullText` plus the last valid `blueprint` snapshot.
- **Accounting**: one `agent_invocations` row per settled turn with
  `project_id NULL` (the Home-turn precedent). No backfill after creation.
- **REST**: `/api/blueprint/*` (`server/blueprint-router.ts`) — conversations
  CRUD, `/send` (202, 409 while streaming), `/abort`, `/models`, `/commit`.
  `/models` returns the provider's `efforts` catalog; `/send` accepts only a
  catalog-valid `reasoning_effort`, and providers without the capability omit
  the field when spawning.
- **Generation boundary**: interview turns and Surprise Me may complete the
  product/flow/platform/stack/assumption/milestone proposal, but MUST keep
  `m1Specs: []` and `specsComplete: false`. Detailed M1 generation starts only
  after explicit user approval or a direct request to generate the backlog.
  That next assistant turn emits the entire self-validated 5–10-spec M1 set in
  ONE response containing ONE complete fenced snapshot. It never publishes a
  partial subset as the latest draft; `specsComplete: true` appears only on the
  complete set. If generation cannot finish, the prior non-complete proposal
  remains the last valid state and cannot be committed.
- **Lazy conversation row**: the client no longer POSTs a conversation when
  the Builder opens. `useBuilderSession.ensureConversation()` creates the row
  (with the composer's provider/model) on the FIRST send, single-flight, or
  `resume()` rehydrates a persisted one — so opening and closing the Builder
  never leaves empty orphan rows behind.

## Snapshot hardening (harden-project-builder-snapshots)

> Why: a real run (WebTetris, 8 specs, `specsComplete: true` claimed by the
> model) ended with a greyed-out *Create specs* button reading "Generation is
> not complete yet." The 8-spec block had been REJECTED by `JSON.parse` and
> dropped **silently** — `continue // malformed; drop silently` — so the panel
> kept the interview snapshot (`m1Specs: []`), the model never learned its
> block was unusable ("no reemito un nuevo snapshot"), and because the
> snapshot lived only in client memory (persisted rows were STRIPPED of the
> JSON) the whole batch was lost when the panel closed. Two grave bugs with
> one root: the snapshot pipeline had no feedback loop and no durability.

**1. Nothing is dropped silently (parser).** `parseBlueprintDraftBlocks`
(server + client mirror) now returns `rejected: BlueprintRejectedBlock[]`
(`{index, reason: 'invalid_json'|'missing_version'|'truncated', detail}`),
`repaired` and `truncated` next to the existing fields. Before rejecting, every
block runs through `parseJsonTolerant` (`server/json-tolerant.ts` ⇄
`client/src/lib/json-tolerant.ts`): strict `JSON.parse` first, then ONE
string-aware repair pass for the mistakes a model makes when hand-writing a
~20 KB payload — raw newlines/tabs/control chars inside strings, a stray inner
`"`, trailing commas, `//` / `/* */` comments outside strings, a nested
```` ```json ```` fence, prose around the object, invalid `\x` escapes — and
parses again (`repaired: true`, repair kinds listed). An UNTERMINATED trailing
fence in a settled reply (the output limit cut the block) is now reported as
`truncated` (with the number of spec titles that had started, via
`countStartedSpecs`) and CUT from the transcript — raw partial JSON never
reaches the chat. The `invalid_json` detail carries the parser message plus a
±40-char excerpt around the failing position so the model can fix it.

**2. The app tells the model (repair loop).** `BlueprintChatManager._runTurn`
audits every settled turn: `planSnapshotRepair(parse)` returns a repair
request when (a) no snapshot was accepted but a block was emitted (kind
`invalid_json` / `truncated`), or (b) the accepted raw snapshot declares
`specsComplete: true` and the deterministic M1 gate
(`auditRawBlueprintForM1`, the same `analyzeBuilderSpecBatch` the commit runs)
disagrees (kind `quality`, detail = one line per issue). Then it runs **ONE
automatic repair turn** on the SAME session (`--resume`, so the model has its
own context) with a byte-stable prompt from `blueprint-operator-prompt.ts`
`buildSnapshotRepairPrompt(kind, detail)` — "APP CHECK: … re-emit the
COMPLETE snapshot … reply with ONLY the block" (the `truncated` variant asks
to tighten descriptions so the block fits). `blueprint.repairing
{kind, attempt, manual}` is broadcast first; the repair turn streams like any
turn; ONE `blueprint.done` follows. Outcomes: repaired block accepted ⇒
`snapshot.status='accepted', repaired: true, repairAttempted: true`; still
unusable ⇒ `status='rejected'` with the freshest diagnostic (never
`blueprint.error` — the user's turn succeeded); a quality repair that still
fails the gate ⇒ the snapshot is delivered WITH `qualityIssues` so the UI can
list them. Bounded: a repair never nests another; no session id / provider
without `nativeResume` ⇒ the rejection is reported without a repair. Every
spawn records its own `agent_invocations` row (a repair bills too). Manual
repair: `POST /api/blueprint/conversations/:id/repair-snapshot` →
`BlueprintChatManager.repairSnapshot(id)` decides what to ask from the
PERSISTED state (pending rejection ⇒ JSON/truncated prompt; claimed-complete
snapshot failing the gate ⇒ quality prompt) so it works after a restart; 202
`{kind}` / 409 `streaming|nothing_to_repair|no_session` / 404. The operator
prompts (both `BUILDER_INSTRUCTIONS` and `BUILDER_SYSTEM_PROMPT`) gained the
JSON hygiene rules (escape `\n` / `\"`, no trailing commas, no nested
fences, nothing after the closing fence, "if the app reports a rejected or
cut-off block answer with ONLY the corrected snapshot").

**3. Durable snapshots (migration 23, `desktop.sqlite`).**
`blueprint_conversations` += `blueprint_json` (normalized accepted snapshot),
`raw_blueprint_json` (exact payload — the commit/readiness evidence),
`snapshot_updated_at`, `snapshot_issue_json` (the pending rejection until the
next accepted block), `committed_project_id` (set by the commit's
`markCommitted` IO hook right after `register`; the commit body accepts an
optional `conversationId`, unknown ids are ignored, a failing link never fails
the commit). `blueprint_messages` += `raw_content` — the model's UNSTRIPPED
reply whenever it carried a block (forensics; a later parser fix can re-read
an old rejected snapshot). A block-only reply persists `content=''` with the
raw payload; `GET /conversations/:id` hides empty rows and never exposes
`raw_content`. Store helpers: `saveBlueprintSnapshot`,
`saveBlueprintSnapshotIssue`, `getBlueprintSnapshot` (normalizes through
`coerceBlueprint`; corrupt JSON reads as null), `markBlueprintCommitted`,
`listResumableBlueprintConversations`.

**4. Resume ("Continue where you left off").** `GET
/api/blueprint/conversations?resumable=1` lists unfinished conversations
(never committed, ≥1 assistant reply) newest first with a snapshot summary
(`productName`, `platform`, `specCount`, `specsComplete`, `dimensionsFilled`,
`hasSnapshot`, `pendingIssue`, `messageCount`). `GET /conversations/:id` now
returns the transcript + `blueprint` + `rawBlueprint` + `snapshot`
(`accepted` with `claimsComplete`/`qualityIssues`, `rejected` with
reason/detail, or `none`) + `snapshotUpdatedAt`. Client:
`BuilderRecentBlueprints` (under the hero composer while the session is empty)
→ `session.resume(id)` rehydrates messages, snapshot pair, provider/model and
the provider session (later turns `--resume`); two-step inline discard →
`DELETE`. The exit confirm copy no longer threatens to discard the blueprint —
it says where to pick it up.

**5. Readiness, made legible (client).** `client/src/lib/blueprint-readiness.ts`
`deriveReadiness` turns the same deterministic report into three steps —
**blueprint** (5 dimensions) · **specs** (count within 5–10 and
`specsComplete`) · **audit** (issues excluding the two batch-level codes) —
with structured params, and `localizeQualityIssue(t, issue)` maps every
`(field, code)` to a `builder:quality.*` key (`{{n}}`, `{{heading}}`,
`{{label}}`, `{{min}}`/`{{max}}`/`{{count}}`, `{{criterion}}`, `{{other}}`;
unknown codes fall back to the English message). Both quality analyzers
(server `analyzeBuilderSpecBatch` and the client mirror) now attach `params`
to each issue. `BlueprintReadiness` (`client/src/components/project-builder/`)
replaces the old CTA + raw-English hint in BOTH surfaces (floating panel side
pane and the Agent-Mode workspace sidebar) and in the M2+ shell: the three
steps, the snapshot status (repairing pill / rejected card with reason +
diagnostic + **Ask for the snapshot again** / "repaired automatically" note),
the audit issues per spec with **Ask the Builder to fix these** (shown only
when the model claimed completion — the only case the app can repair), and the
primary CTA whose disabled hint names the FIRST blocker in plain language.
`useBuilderSession` exposes `snapshot: BuilderSnapshotState`
(`idle|repairing|accepted|rejected`), `readiness`, `generation`, `recent`,
`resume`, `discardRecent`, `repairSnapshot`, `conversationId`; a block-only
`blueprint.done` (empty `fullText`) appends no bubble; a legacy `done` without
`snapshot` still parses the settled text. `BlueprintPanel` shows a
Complete / In progress pill on the M1 header and a pulse while repairing.

**6. Live generation progress.** While a block streams in (hidden by the tail
cut — previously a static "Thinking…" for up to a minute) `describeStreamingSnapshot`
counts the spec titles started inside the open fence and
`BuilderGenerationProgress` renders "Writing the Milestone-1 specs… · spec N"
with a soft progress bar (specs ÷ cap, capped at 95% until the block closes),
switching to the repair label during a repair turn. Used in the day-0 thread
and the M2+ shell.

**M2+ (`MilestoneGenerateShell`)** rides `ChatManager`, which has no
app-driven repair turn; it gets the tolerant parser + rejection diagnostics +
the same readiness surface for free, and its repair button sends a localized
user message (`builder:prompts.repairSnapshot`) instead.

**WS contract.** `blueprint.done` += `snapshot` (see `BlueprintDoneMessage`);
new `blueprint.repairing`. i18n: `builder` namespace gained `generation.*`,
`readiness.*`, `snapshot.*`, `recent.*`, `quality.*` (×8, parity-tested).

## blueprint-draft protocol

**Fence tolerance (bug fix, 2026-09-04).** Models mirror the schema example
and Sonnet emitted the whole snapshot inside a ```` ```json ```` fence: the
parsers only knew ```` ```blueprint-draft ````, so the raw JSON landed in the
chat, no snapshot was accepted (no rejection either) and the panel stayed at
0/5 dimensions. Two-sided fix: the prompt's example is now fenced
`blueprint-draft` with an explicit rule ("the fence language is EXACTLY
`blueprint-draft` — a json or bare fence is NOT a snapshot"), and both parsers
run `promoteJsonBlueprintFences` first — a CLOSED ```` ```json ```` / bare
fence whose body is a `{…}` object with an integer `blueprintVersion` is
promoted to a blueprint-draft block (outside proper blocks only; ordinary json
fences and invalid payloads are untouched), and an OPEN one is reported
`truncated` / hidden from the live stream (`cutUnterminatedBlock`,
`describeStreamingSnapshot`).

Fenced ` ```blueprint-draft ` JSON blocks. FULL snapshots, LAST syntactically
valid block wins, streaming tail cut (unterminated trailing fence never
parsed/shown — `cutUnterminatedBlock`). Unknown keys dropped; missing or
non-integer `blueprintVersion` rejects the block. Parser pair:
`server/blueprint-draft-parser.ts` ⇄ `client/src/lib/blueprint-draft.ts` (keep
coercion rules in sync). Schema types in `server/blueprint-types.ts`:
`product{name,pitch,audience}`, `coreFlow`, `platform`,
`stack{language,framework,db,notes?}`, `assumptions[]`,
`milestones[]{id,title,goal,status: planned|committed|done, plannedSpecs[],
ticketIds?}` (ticketIds ADVISORY only), `specsComplete`, and detailed
`m1Specs[]{kind,title,shortSummary,description,acceptanceCriteria[],priority,
labels[],dependsOnIndex?}`. `kind` is `scaffold|feature|verification`; priority
is `low|medium|high|critical`. After approval, detailed M1 generation arrives
as one complete 5–10-spec snapshot with an explicit scaffold first. M2+
milestones carry `plannedSpecs` titles only until that milestone is explicitly
generated, at which point the target milestone's entire detailed set likewise
arrives in one assistant response/snapshot. The version stays 1: legacy
snapshots default missing `specsComplete=false`, `kind='feature'`,
`shortSummary=''`, criteria to `[]`, and missing/invalid priority to `medium`
on read. Those defaults preserve readability only; newly committed batches
must pass the strict quality gate.

Parsing deliberately retains two representations of the LAST valid block:
`blueprint` is the compatibility-normalized `Blueprint` used by preview/read
surfaces, while `rawBlueprint` is the exact parsed JSON before enum defaults,
dependency drops, or missing-field defaults. `blueprint.done` carries both;
the client mirrors the pair, derives readiness from the raw value, and sends
that raw value to M1/M2+ commit. Therefore an invalid `kind`, `priority`,
`dependsOnIndex`, or required field cannot disappear/default during rendering
and then pass the mutation gate. Persisted legacy files are a different read
boundary: `readBlueprint()` calls `coerceBlueprint()` server-side so old v1
files remain readable (and returns null for missing/corrupt input).

## Canonical rich-spec contract (M1 and generated M2+)

There is no Builder-specific “lite spec” format. Every detailed Builder spec
uses the normal Specrails contract, and since premium-milestone-progress the
prose that teaches it lives in ONE module — `server/spec-contract-prompt.ts`
(`premiumSpecContract(mode)`, `premiumSpecContractCompact(mode)`,
`PREMIUM_SCAFFOLD_EXAMPLE`, `SPEC_DEPTH_FLOORS`) — consumed by the Builder
operator prompt, `ChatManager._buildMilestoneSystemPrompt` (M2+) and the
agent's super-spec section, so the three authors never drift. `mode` selects
the grounding hook: `day0` (no repo — every module/path/route is labelled
*planned*) vs `verified` (only paths that were inspected).

1. `kind`: `scaffold`, `feature`, or `verification`
2. an English, action-oriented, unique `title`
3. a one-sentence `shortSummary` no longer than 240 characters
4. `description` with exactly these `##` headings, once and in this order:
   `Problem Statement`, `Proposed Solution`, `Out of Scope`,
   `Technical Considerations`, `Estimated Complexity`
5. a separate `acceptanceCriteria[]` containing **6–10** independently
   testable outcomes (each ≥ 20 chars, covering the happy path, at least one
   failure/edge case and an automated verification); `description` MUST NOT
   contain `## Acceptance Criteria`
6. a catalog-valid `priority`, non-empty domain labels, and an optional
   `dependsOnIndex` that points strictly backward (the M1 scaffold omits it)

**Depth floors (`SPEC_DEPTH_FLOORS`, enforced by the deterministic gate on
both sides):** Problem Statement ≥ 200 chars of narrative (who, what breaks
today, why now, what good looks like); Proposed Solution ≥ 500 chars — a
numbered user journey followed by the five `###` sub-blocks *User
experience · Data model · Interfaces & contracts · Planned modules · Key
decisions*; Out of Scope ≥ 3 bullets, each naming WHERE the exclusion goes
(a later milestone / never); Technical Considerations ≥ 5 labelled bullets
(**Architecture**, **Data & contracts**, **Failure handling & edge cases**,
**Security & privacy**, **Testing strategy**, **Dependencies**, **Risks &
mitigations**); Estimated Complexity = a reasoned estimate naming the main
uncertainty. `PREMIUM_SCAFFOLD_EXAMPLE` is the mandatory first spec written
at that depth; "shorter is a defect, not a style". The floors were raised
because the old minima ("at least two bullets", 4–10 criteria) became the
ceiling the model aimed at (design D6/D8). Test fixtures that need a
gate-valid spec use `server/blueprint-spec-fixtures.ts` ⇄
`client/src/lib/__tests__/premium-spec-fixture.ts`.

`server/blueprint-spec-quality.ts` is the shared deterministic authority. It
validates `specsComplete=true`, the complete-set size, all fields/sections
above (including the depth floors — issue codes `section_depth` carries the
heading + min chars, `section_bullets` the min, `criteria_count` the 6–10
bounds, `criterion_short` the 20-char floor), unique titles, the M1
first-item `kind='scaffold'` rule, and backward-only dependencies. Both
commit paths run it before any filesystem, registry, blueprint, milestone,
or ticket-store mutation and return a stable spec/field-oriented detail when
it rejects. A prompt is a generation aid, never the integrity boundary.
Validation receives the exact raw generated payload; normalized
compatibility views are not commit evidence.

### App-driven batched generation (premium-milestone-progress D7)

"Emit all 5–10 specs complete in ONE reply" capped every spec's depth by the
output budget (ten premium specs do not fit) and the old `truncated` repair
told the model to *tighten* — institutionalising thin specs. Generation is
now driven by the app, in turns on the SAME session (`server/blueprint-
generation.ts` + the drive closure in `BlueprintChatManager._runTurn`):

1. **Outline.** After approval the Builder emits ONE `blueprint-draft` FULL
   snapshot with every spec's `kind/title/shortSummary/priority/labels/
   dependsOnIndex` decided but `description: ""`, `acceptanceCriteria: []`,
   `specsComplete: false`. `isOutlineSnapshot` (≥ `M1_SPECS_MIN` specs, every
   body empty) on a resumable session (`capabilities.nativeResume` + a session
   id) starts the drive; the outline is broadcast as the first
   `blueprint.done { continuing: true }` frame so the panel lists the specs
   immediately.
2. **Detail turns.** `APP CONTINUE` names `SPECS_PER_DETAIL_TURN = 2` specs
   by index + title; the model answers with one fenced `spec-detail` block
   per spec — `{ "index": n, "spec": { …complete premium spec… } }` — and
   nothing else. `parseGenerationBlocks` extracts/strips them (tolerant JSON,
   `truncated` on an open fence), `mergeSpecDetails` merges by index (an
   omitted key keeps the outline's value, out-of-range indexes are ignored).
   A range that is still unfilled gets ONE `APP CHECK` re-ask
   (`buildDetailRepairPrompt`); still unfilled ⇒ the drive **halts**
   (`blueprint.done { snapshot.generationHalted: true }`, `specsComplete`
   forced false, the outline/partial snapshot persisted — nothing is lost).
3. **Audit turn.** `APP AUDIT` asks for one `spec-audit` block
   `{ specsComplete, issues[], fixes[{ index, spec }] }`. Fixes merge like
   details; a verdict with zero fixes still applies (`specsComplete`). A
   verdict of `false` WITH issues gets ONE corrections turn
   (`buildAuditIssuesPrompt` — `spec-detail` blocks for the affected specs
   only); a reply without any block lets the deterministic gate judge.
4. **Quality repair.** The pre-existing repair tail runs unchanged after the
   audit (`planSnapshotRepair` → `quality` when the model claims complete and
   the gate disagrees); the repair reply may now be `spec-detail` patches
   instead of a whole snapshot (`applyReply`).

Bounds: `MAX_GENERATION_TURNS = 8` (outline + 5 detail turns for 10 specs +
audit + one repair); every turn persists its snapshot (`saveBlueprintSnapshot`)
and records its own `agent_invocations` row; generation fences are stripped
from the transcript exactly like `blueprint-draft` blocks (the raw reply
survives in `raw_content`). Wire: `blueprint.generating { phase:
outline|details|audit|repair, from, to, total, turn, totalTurns }` announces
each phase; every intermediate `blueprint.done` carries `continuing: true` +
`snapshot.generation` (the client keeps `busy`, appends no bubble, refreshes
the panel); the final frame carries the descriptor without `continuing`.
**Resume:** `POST /conversations/:id/repair-snapshot` now also resumes a
halted drive — when no rejection is pending and the persisted snapshot still
has unfilled specs it answers `202 { kind: 'resume' }` and continues from
the next unfilled range (turn ordinal re-derived from what is already
written), which the readiness panel exposes as **Continue generating**
(`snapshot-halted` notice: "N of M specs written in full"). Providers without
`nativeResume` get the `GENERATION MODE: single response` line appended to
each user turn and keep the single-snapshot behaviour (never driven).

Client: `BuilderSnapshotState` gains `{ status: 'generating', generation }`
and `accepted.generationHalted`; `BuilderGenerationProgress` renders the
phase label ("Writing specs 3–4 of 8 in full…"), a `turn x/y` pill and a REAL
ratio from the descriptor (falls back to the streaming spec count for
single-response providers); `BuilderConversation` keeps that progress chip
between batched turns instead of the generic thinking chip; readiness
`specs` step params carry `written` (specs with a body). **Honest audit
during the drive:** an outline's empty bodies are NOT audit failures — while
`snapshot.status === 'generating'` `deriveReadiness(…, { generating })` puts
the specs + audit steps in the `writing` state ("2 of 8 written" / "after the
specs are written", spinner, batch hint) and lists NO issues; a halted partial
batch keeps only the issues of WRITTEN specs (the unwritten tail simply waits);
the panel's spec card shows "writing…" / "not written yet" instead of
"0 acceptance criteria" for an unwritten entry. i18n `builder:generation.*`,
`builder:snapshot.halted.*`, `builder:readiness.*.writing`,
`builder:panel.specWriting|specPendingBody` ×8.

## Orchestrated commit (register-project-LAST)

`POST /api/blueprint/commit` → sync validation (named errors: `invalid_name`,
`invalid_location`, `providers_required`, `unknown_provider`,
`invalid_blueprint`, `m1_specs_required`, `m1_specs_over_cap`,
`bundled_framework_missing`, `location_not_empty`,
`location_already_registered`; rich-spec failures include actionable spec/field
detail) → 202 `{commitId}` → per-step
`blueprint.commit_progress` → terminal `blueprint.commit_done{projectId}` /
`commit_failed{step,error}`. Orchestrator: `server/blueprint-commit.ts`
`createBlueprintCommitRunner` (DI IO bag — every step fail-injectable in
tests). Step order:

1. `create-dir` — mkdir target
2. `git-init` — `git init -b main` + deterministic README (no AI call,
   `renderReadme`) + initial commit (pinned committer identity)
3. `assemble` — registry mirror + framework materialize + one core
   `init --from-config` per provider (`server/offline-assemble.ts`
   `assembleProjectOffline`, extracted from `SetupManager`): PREFERS the
   bundled core (offline `node <bundled-cli> init`, `spawnBundledCoreInit`),
   falls back to `npx specrails-core` (`spawnNpxCoreInit`) when no bundle —
   so `npm run dev` and runtimes-less builds work. `canAssembleProject()` is
   the validation gate: true when the bundle is present OR
   `SPECRAILS_IS_DESKTOP !== '1'`; only a packaged desktop build with a
   missing/corrupted bundle returns false → `bundled_framework_missing`
   ("reinstall the app"). Verifies the workspace exists afterwards.
4. `blueprint` — `writeBlueprintPair` into `<workspace>/.specrails/`
   (`blueprint.json` source of truth + deterministic `blueprint.md`,
   `server/blueprint-render.ts`; repo stays pristine)
5. `tickets` — `mutateStore` on the workspace `local-tickets.json`: `todo`,
   label `M1`, `source='project-builder'`, `created_by='project-builder'`, spec
   order preserved, generated priority/short summary/domain labels retained,
   structured criteria folded once via the normal
   `formatDescriptionWithCriteria` helper, `dependsOnIndex` → `prerequisites`,
   advisory ids written back to milestone m1 (+ `status='committed'`) and the
   pair re-rendered
6. `register` — `ProjectRegistry.addProject` with the pre-generated id/slug
   (LAST mutation; broadcast `desktop.project_added`)
7. `github` — best-effort, never aborts. A server-side pre-flight
   (`gh auth token`) runs first as defence against a stale client cache: a
   spawn error (gh not on PATH) → warning `gh_not_installed`; a non-zero exit
   → warning `gh_not_authenticated`, both WITHOUT spawning the create. Then
   `gh repo create <slug> --private --source . --push`; a failure is
   classified by `classifyGhCreateError` (`gh_scope` for 403/scope,
   `gh_repo_exists`, `gh_network`, else `gh_failed`). Every warning rides the
   `blueprint.commit_progress` payload's additive `code` field so the client
   renders an i18n message (`builder:progress.githubErrors.*` ×8, raw stderr
   tail kept as tooltip) and fires ONE non-blocking `toast.warning` per commit
   attempt (`useBuilderSession` `ghWarnedRef`).

**Checkbox gating** (`BlueprintCommitForm`): the "Create private GitHub
repository" option renders ONLY when gh is installed+executable
(`usePrerequisites()` gh entry); installed-but-unauthenticated shows it
disabled with the actionable `commit.githubAuthHint` («gh auth login»). gh
absent ⇒ the checkbox does not exist. Submit force-clears the flag unless gh
is fully ready (installed + authenticated).

**Crash posture**: a crash before step 6 leaves an orphan dir + registry entry
but NO project row (invisible; re-run rejects `location_not_empty`). After
step 6 it is an ordinary project missing only the remote.

## Milestone lifecycle

Generating detailed M2+ specs uses the same pure-output capability gate as
day-0 blueprint generation. Kimi cannot be selected for that generation turn.
Launching the already committed M1/M2+ tickets is ordinary Batch rail
execution and can use Kimi.

- **Launch Milestone N is SERVER-owned** (premium-milestone-progress D3):
  `POST /api/projects/:id/blueprint/milestones/:n/launch { mode }`
  (`client/src/lib/milestone-launch.ts` `launchMilestone` is one POST; the
  old browser-local `MilestoneSequencerContext` + its `localStorage` plan are
  GONE — `dropLegacySequentialPlans()` forgets the leftover key on load).
  `server/milestone-chain.ts` `MilestoneChainManager` gathers the `M<n>`
  `todo` tickets, chunks them (≤3, `chainRailName` → `M<n>` / `M<n> · k`),
  persists ONE `milestone_launch_chains` row (`server/milestone-chain-store.ts`,
  migration 58, partial unique index = one non-terminal chain per milestone;
  CAS `updateChain`) and launches chunk 1 through the app's OWN rails launch
  route over loopback (`server/internal-api.ts`, lifted from the MCP tools'
  `apiCall`) so every existing guard applies and each 4xx becomes a typed
  `pause_reason` (`launch_rejected:<error>`). **Sequential (default)** chains
  the next chunk when the in-flight chunk's DELIVERY settles — the manager taps
  the project's bound broadcast for `rail.pr_state` (the engine's
  `onLoopRunFinished` fires BEFORE the delivery row leaves `building`, so it is
  only the delivery-less shared-cwd fallback, recording `last_run_outcome` to
  name the pause reason) — and **STACKS** it: chunk k+1 launches with
  `baseBranch = chunk k's delivered branch` (the rails launch route's new
  `baseBranch` param → `resolveIntegrationBranch({ explicit })`, recorded as
  the delivery's `base_branch`, so a walking skeleton accumulates without
  waiting for a merge). `no_changes` keeps the previous head; failure /
  stall / stop / launch refusal / missing head / discarded head / lost run
  PAUSE the chain (`chunk_failed | chunk_stalled | chunk_stopped |
  launch_rejected:<e> | head_missing | head_discarded | run_lost`) — never
  skip ahead. `POST …/blueprint/chains/:id/resume` **retries the chunk that failed**
  (the row remembers it in `retry_chunk`, set by every chunk-failure pause:
  `chunk_failed | chunk_stalled | chunk_stopped | provider_limit | run_lost`;
  `launch_rejected` / `head_missing` keep launching the NEXT chunk) from the
  current head (409 `head_missing` when the branch is gone) — run 10dedd5a
  showed the old resume skipping to tickets 4–6 while 1–3 had failed. The
  retry REUSES the failed attempt's rail when no undecided delivery sits on
  it any more (`activeDeliveryForRail` null — e.g. after Discard), else takes
  a fresh rail so the failed delivery stays reviewable; the launched entry
  for that chunk is replaced (delivery rows keep the history). A NEW chain for
  the same milestone likewise reuses a rail already named for the chunk
  (`io.findRailByName` → `rails-store` `getRails`) when it holds no undecided
  delivery, so relaunching M1 never piles up duplicate "M1 · 1" rails;
  `…/cancel` stops the chain and leaves in-flight rails alone. Startup
  recovery (`recoverOnStartup`, run once the HTTP server listens) replays a
  chunk that settled while the server was down exactly once.
  **Wave checkpoints (D9).** The row carries `auto_advance` (default 1 for
  API callers; the UI sends the user's stored preference
  `localStorage['specrails-desktop:milestone-auto-advance']`, default OFF)
  and a non-terminal status `awaiting_approval`. When a chunk's delivery
  settles successfully and auto-advance is off (and chunks remain), the
  manager records the head and parks the chain at `awaiting_approval`
  (`afterChunkSuccess`) instead of launching — a HEALTHY decision point, unlike
  `paused` whose Resume retries the SAME chunk. `…/chains/:id/resume` launches
  the NEXT chunk from `awaiting_approval` too; `PATCH …/chains/:id
  { autoAdvance }` (`setAutoAdvance`) flips the flag on any active chain and,
  when turning it on at a checkpoint, launches immediately. `awaiting_approval`
  counts as active (one non-terminal chain per milestone, cancellable) and is
  ignored by startup recovery (waiting for the user is the point); a failure
  always PAUSES regardless of the flag (checkpoints are reached only by
  success). Client: `launchMilestone(projectId, n, mode, { autoAdvance })`,
  `setChainAutoAdvance`, `readMilestoneAutoAdvance`/`saveMilestoneAutoAdvance`
  (`milestone-launch.ts`); `chainAtCheckpoint` + `isMilestoneLaunchable`
  excludes a checkpoint (`milestone-progress.ts`). **Parallel**
  launches every chunk at once from the integration branch (row recorded
  `completed` so the progress model still orders the rails). Kill switch
  `SPECRAILS_MILESTONE_CHAIN=false` ⇒ parallel, no row. Merging a STACKED
  chunk sweeps its merged ancestors (`sweepMergedChainAncestors` in
  `rail-pr-decision.ts`: chain-local, `git merge-base --is-ancestor`, same
  CAS + ticket effect + Jira hook) and merge-local integrates into the CHAIN's
  integration branch, never the feature base (`mergeLocalTargetBranch`);
  discarding a delivery a later chunk was built on pauses its chain
  (`pauseChainsForDiscardedHead`) and the decision surfaces warn first
  (`discardStackedNote` ×3 namespaces). Offered on the Builder done screen and
  the sidebar entry with the Sequential | Parallel toggle.
- **Milestone progress is SERVER-derived** (premium-milestone-progress D2):
  `server/milestone-progress.ts` `deriveMilestoneProgress` builds, per
  milestone, counts by spec state (`total/done/onReview/inProgress/todo/failed`
  — `failed` = specs back at `todo` whose NEWEST delivery unit failed), the
  milestone's rails (active runs + non-terminal deliveries, chunk-ordered), the
  chain snapshot and a derived `state`
  (`done` ⇐ every spec done · `delivered` ⇐ nothing pending, ≥1 on_review ·
  `running` ⇐ in-progress or a live chain · `committed` · stored status).
  `GET /:id/blueprint` returns `{ blueprint, progress }`;
  `MilestoneProgressBroadcaster` (tapped from the bound broadcast on
  ticket/rail/delivery/run/chain messages, 150 ms debounce, memoized "no
  blueprint") re-broadcasts `blueprint.milestone_progress` and persists
  `status:'done'` once via `markMilestoneDone` (+ `blueprint.milestone_completed`).
  Display ALWAYS uses the derived state — a delivered milestone reads
  "8 of 8 delivered · 0 done", never done/complete.
- **Sidebar re-entry** (`BuilderSidebarEntry`, mounted in
  `ProjectRightSidebar` + `AgentWorkspaceSidebar`): visible iff
  `GET /api/projects/:id/blueprint` returns a blueprint (404 = hidden).
  Reads `useMilestoneProgress(projectId)` (cached per project, live over WS —
  NO board fetch on open) and renders one `MilestoneCard`
  (`MilestoneProgressCard.tsx`: segmented bar done/in review/in progress/
  failed/pending, honest counts, state pill, per-rail rows with decision pill +
  elapsed + Review → `/review/:prDeliveryId`, chain row with k of n / waiting /
  paused reason + Resume / Cancel, and at a wave checkpoint "Rail k of n
  delivered — launch rail k+1?" with **Launch next rail** + the chain-level
  **Continue automatically** switch (`MilestoneAutoAdvanceToggle`, PATCH; also
  saves the preference) + Cancel; a running auto-off chain notes "stops after
  this rail") per milestone in a 320 px flyout. Actions: Launch M1 (while
  `isMilestoneLaunchable`) with the mode toggle and, for sequential mode, the
  same auto-continue switch (stored preference, default OFF — the launch toast
  then says "you'll be asked before each next rail") + Generate M<next> (first
  `planned` milestone > 1). The Builder done screen shows the same live card
  after Launch (`BuilderDoneMilestone`) and the auto-continue switch next to
  Launch M1 — "Open the project" stays the exit. **Review in Mission mode:**
  every Review button navigates to `/review/:prDeliveryId`, a Board ROUTE
  that Mission mode never renders (the button "did nothing"); the route is
  now a third `modalize` surface (`global-route-mode-transition.ts`
  `reviewDeliveryIdForPath`) — `App.tsx` opens the SAME `ReviewPacketPage`
  embedded in a mission modal (`prDeliveryId` + `onClose` props, no New
  Mission reset), and switching back to Board routes to the page. App-level toasts
  (`useMilestoneNotifications`): later chunk launched, chain paused
  (+ Resume), wave checkpoint (once per rail: **Launch next rail** +
  **Auto-continue** actions), milestone delivered (+ Review), milestone
  complete. i18n `builder:milestoneProgress.chain.*` / `toast.*` ×8.
- **Board classification**: new Builder tickets use
  `source='project-builder'` + `created_by='project-builder'`. For projects
  created before that source existed, `DashboardPage` also treats
  `source='manual'` + `created_by='project-builder'` as specs; existing tickets
  appear after reload without rewriting the user's ticket store.
- **Generate M2+** (`MilestoneGenerateShell`): PROJECT-level conversation
  `kind='milestone'` through the existing ChatManager. The milestone id rides
  `context_scope` as `{milestone:'m2'}` (`POST /chat/conversations` body
  `{kind:'milestone', milestone}`); `ChatManager._buildMilestoneSystemPrompt`
  seeds the prompt with the workspace `blueprint.json`, the target
  `plannedSpecs`, the complete canonical rich-spec/quality contract, and the
  code-grounding rules. It instructs the agent to return every detailed spec
  for the target milestone in one assistant response and one complete snapshot,
  never an incrementally committable subset. Claude receives it through the
  system prompt; adapters without that argument receive the same dynamic
  instructions and blueprint context in the effective user turn, so Claude,
  Codex, and Gemini receive equivalent authoring/context instructions.
  Generation itself is read-only: the prompt forbids repository/workspace/
  ticket/config/git mutation, write-capable shell/tool actions, builds, and
  tests. `toolPolicy='read-only'` maps Claude to `--permission-mode plan`
  + `--safe-mode` + only `Read,Grep,Glob`; Codex fresh turns use
  `--sandbox read-only` and resumes carry `sandbox_mode="read-only"`; Gemini
  uses `--approval-mode plan` and never `--yolo`. Gemini CLI does not expose a
  selectable filesystem sandbox comparable to Codex, so its protection is the
  native plan/policy layer plus the prompt—not an OS/filesystem sandbox. If a
  CLI version rejects an incompatible safety flag, the turn fails closed; it
  is never retried with a mutating/yolo policy. For relocated projects the
  prompt identifies the absolute real repo, its `./project` mount, and
  `SPECRAILS_REPO_DIR`; it explicitly warns Read/Grep/Glob not to receive
  literal shell-variable expressions, preventing grounding against the empty
  workspace. Grounded specs name only verified paths/identifiers and require
  behavioral, failure/edge-case, and testing criteria. Accounting records
  `surface='explore-spec'` (no new surface value). Committing calls
  `POST /api/projects/:id/blueprint/commit-milestone {milestoneId, specs[]}` —
  atomically validates the complete batch before any write, then inserts
  `M<n>`-labeled `todo` tickets with Builder source/provenance and the same
  priority/summary/criteria/labels/prerequisite ticket-materialization rules as M1
  (broadcasting `ticket_created` per row), flips the milestone to `committed`,
  and re-renders the pair. These tickets are the authoritative detailed M2+
  representation: their descriptions contain the folded criteria and they
  retain priority, short summary, domain + `M<n>` labels, and prerequisites.
  `blueprint.json` deliberately stores only the existing milestone skeleton
  with `status='committed'` and advisory `ticketIds`; it has no detailed-M2-
  per-milestone schema. On 201 the shell calls `onCommitted`, refreshes the live
  milestone-progress cache (no-store refetch), closes, and the next CTA
  resolves to the first later milestone still `planned`. Jira-connected
  projects ride the existing machinery on the store mutation.

## Tests

`server/blueprint-{draft-parser,render,store,chat-manager,commit,router}.test.ts`,
`server/json-tolerant.test.ts`, `server/offline-assemble.test.ts`,
`server/project-router.test.ts`, `server/desktop-db.test.ts` (migration 23);
client `src/lib/__tests__/{blueprint-draft,blueprint-readiness,milestone-launch}.test.ts`,
`src/hooks/__tests__/useBuilderSession.test.ts`,
`src/components/__tests__/{ProjectBuilder,BuilderSidebarEntry,MilestoneGenerateShell}.test.tsx`,
and `src/pages/__tests__/DashboardPage.test.tsx`.
Locale parity covers the `builder` namespace ×8.

## Deferred (v2)

Minimize-to-dock for Builder conversations (no `projectId` to tag — resume is
now the hero list instead), an orphan-dir startup sweeper, non-GitHub remotes,
editing an existing blueprint via the day-0 Builder, a live side-panel draft
during M2 generation, an app-driven repair turn for M2+ (ChatManager path).
