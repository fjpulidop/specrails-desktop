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
uses the normal Specrails contract:

1. `kind`: `scaffold`, `feature`, or `verification`
2. an English, action-oriented, unique `title`
3. a one-sentence `shortSummary` no longer than 240 characters
4. `description` with exactly these `##` headings, once and in this order:
   `Problem Statement`, `Proposed Solution`, `Out of Scope`,
   `Technical Considerations`, `Estimated Complexity`
5. a separate `acceptanceCriteria[]` containing 4–10 non-empty, independently
   testable outcomes; `description` MUST NOT contain `## Acceptance Criteria`
6. a catalog-valid `priority`, non-empty domain labels, and an optional
   `dependsOnIndex` that points strictly backward (the M1 scaffold omits it)

Every named description section has a non-empty body. `Out of Scope` and
`Technical Considerations` each contain at least 2 bullets; Estimated
Complexity includes a reasoned estimate. Day-0 technical considerations name
the selected stack, planned components/contracts, risks, and inter-spec
dependencies but never fabricate repository paths. Generated M2+ specs first
inspect the real project and may name only verified existing paths and
identifiers; their criteria cover behavior, failure/edge cases, and tests.

`server/blueprint-spec-quality.ts` is the shared deterministic authority. It
validates `specsComplete=true`, the complete-set size, all fields/sections
above (including both 2-bullet minima), unique titles, the M1 first-item
`kind='scaffold'` rule, and backward-only dependencies. Both commit paths run
it before any filesystem, registry, blueprint, milestone, or ticket-store
mutation and return a stable spec/field-oriented detail when it rejects. A
prompt is a generation aid, never the integrity boundary. Validation receives
the exact raw generated payload; normalized compatibility views are not
commit evidence.

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

- **Launch Milestone 1** (`client/src/lib/milestone-launch.ts`
  `launchMilestone`): gather `M1`-labeled `todo` tickets → chunk into groups
  of ≤ `MAX_TICKETS_PER_RAIL` (3) → per chunk: `POST /rails` (server allocates
  the lowest free index; rails named `M1 · <k>` when the milestone needs more
  than one) → `PUT /rails/:i/tickets` → `POST /rails/:i/launch
  {mode:'batch-implement'}` (the server maps the bare mode to the batch
  factory loop: worktree isolation + ask-first PR). The launch route rejects
  any rail carrying more than 3 specs (`rail_ticket_cap_exceeded`), so the cap
  holds for every launch door. A failure before anything launched surfaces as
  a typed reason; a mid-batch failure keeps the launched rails and reports the
  skipped rest (`skippedCount` → partial-launch toast). Offered on the Builder
  done screen and the sidebar entry; existing 409 guards surface as toasts.
- **Sidebar re-entry** (`BuilderSidebarEntry`, mounted in
  `ProjectRightSidebar` + `AgentWorkspaceSidebar`): visible iff
  `GET /api/projects/:id/blueprint` (project-router) returns a blueprint
  (404 = hidden). Progress derives LIVE from board tickets by `M<n>` label —
  never from stored ticket ids. Actions: Launch M1 (while launchable) +
  Generate M<next> (first `planned` milestone > 1).
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
  per-milestone schema. On 201 the shell calls `onCommitted`, increments the
  sidebar blueprint refresh key (no-store refetch), closes, and the next CTA
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
