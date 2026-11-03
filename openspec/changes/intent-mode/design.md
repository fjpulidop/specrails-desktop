## Context

Flow (OpenSpec change `flow-mode`, implemented, smoke pending) is an interactive coding mode inside a mission. A person builds code with an agent in an isolated worktree. "This is it" hands the worktree to the `factory:flow-spec` rail, which derives the OpenSpec change (`derive-change` in Core), verifies, reviews and settles: the spec is rewritten, the change archived and Jira updated. The person's starting point is a free-text idea that becomes a placeholder spec title and description.

The other doors into Specrails still start from a solution:

- **Mission operator:** emits a `problem-frame` (two readings and a discriminator), then a `spec-draft`.
- **Add Spec modal:** Quick, Explore and Raw.

The intent practice asks for the opposite. The person states the problem, the outcome, who is affected, the constraints and the open questions. The AI writes the spec, and the person reviews it.

User decisions (2026-11-01):

1. Full evolution, not a rename.
2. The intent ends as `intent.md` in the OpenSpec change.
3. Intent is the default door for every new spec; direct specs stay possible.
4. Flow and Implement stay equal paths.
5. Persisted contracts are frozen.

## Goals / Non-Goals

**Goals:**
- An intent artifact with a pure domain model, a canonical Markdown form, storage on the spec, and a view and editor.
- The intent as the default door: mission interview (`intent-draft`) and the Add Spec Intent mode.
- Explore (Intent session) and Delegate (rail) from any intent, with equal weight.
- The intent reaches every agent, the reviewer judges against outcome and success signals, and `intent.md` lands in the delivered change.
- Flow → Intent in every person- or contributor-facing name, with frozen wire and storage identifiers.

**Non-Goals:**
- Core changes. Core keeps `derive-change`, `summaryPath` and the role prompts; the intent travels as Desktop-authored context.
- Companion app and website docs: they mention Flow and are follow-ups in their own repositories.
- Day-0 Project Builder milestones keep their own generation; an intent per milestone is a later change.
- Renaming persisted data (tables, surfaces, sources, loop ids).

## Decisions

### D1. The intent is a field on the spec, materialised as `intent.md` at delivery

Before a worktree exists there is no change directory to write to, and a spec can be launched many times. The intent therefore lives on the ticket as `intent: IntentDocument`, an additive field with a store schema bump and no migration. When a delivery commits work, Desktop renders the intent into the run's change directory (`openspec/changes/<id>/` or its archive directory), right before the commit it already owns (`SPECRAILS_GIT_AUTO=false`).

*Rejected:* pre-creating `openspec/changes/<id>/intent.md` in the worktree at launch.
- For Flow, the change would exist at the reservation base, so `flowChangeHolder` reads it as `taken` and Flow derivation renames the change.
- For Implement, the architect's `openspec new change` collides with an existing directory.
- Both cases would need Core prompt changes.

Writing at delivery is deterministic, provider-agnostic and needs no Core change. The delivery path guards treat `intent.md` as part of the run's own change.

### D2. `intent-draft` replaces `problem-frame` as the framing artifact

One card, not two:

- **Kept from the frame:** the two-readings discipline (`readings.restated`, `readings.alternative`, `readings.discriminator`), now about the problem and outcome. The `touches` lists are dropped, because surfaces are solution-shaped.
- **Gate:** `commit_draft` accepts an answered `intent-draft` or a legacy `problem-frame`, so in-flight conversations keep working.
- **Attachment:** the newest answered `intent-draft` is attached to the committed spec by the server, deterministically. The agent does not have to copy it into the call.
- **Retention bar:** the existing framing retention criterion applies to the intent step unchanged.

The operator prompt stays a static constant, so caching is preserved.

### D3. Add Spec Intent mode is a single generation with two outputs

`generate-spec` with `intent: true` uses one model call. The model returns a fenced `intent` JSON block followed by the spec in the existing premium format, and the server parses both. An invalid intent falls back to the spec without an intent and a toast notes it. One call keeps cost and latency equal to Quick mode. The interview variant is the mission door; Explore mode stays as is.

### D4. Open questions are answered deterministically at settlement

The `rewrite-spec` settlement effect already rebuilds the spec from what was built. Its prompt gets the intent and asks for an `intent-answers` JSON block of `{ index, answer }` entries. Desktop merges an answer only into an existing question, matched by index with the question text checked, and never edits the problem, outcome or constraints. A missing or invalid block leaves the intent unchanged.

### D5. The intent reaches agents as briefing text

- **Explore first turn:** the intent comes first in `buildSpecSeedBriefing` and in the placeholder-spec briefing, within the 24 KB bound.
- **Flow → Spec deriver:** the intent comes first in `flow-summary.md`, within the 32 KB `FLOW_SUMMARY_LIMIT_BYTES`; the conversation summary is trimmed first.
- **Implement:** the intent goes into the briefing appended to the spec description (the same channel as addenda), followed by a reviewer instruction to judge against the outcome and success signals.

These are all Desktop data channels Core already reads.

### D6. Rename strategy: names move, wire/storage identifiers freeze

`git mv` `server/modules/flow` → `server/modules/intent` and `client/src/features/flow` → `client/src/features/intent` (file names follow: `FlowX.tsx` → `IntentX.tsx`, `flow-api.ts` → `intent-api.ts`); boundary manifests and architecture rules follow in the same commit. Capitalised identifiers (types, classes, React components: `FlowSession` → `IntentSession`, the client `Flow` read model → `IntentSession`) are renamed. lowerCamel identifiers (`flowId`, `startFlow`, `flowApi`) keep their stem, because most mirror wire fields (`flowId`, `flowDerivation`, `metadata.flow`) and renaming half of them would blur what is frozen; i18n keys stay as they are (internal) while every value changes. Frozen: `flow_sessions`, `flow_effects`, `surface='flow'`, `factory:flow-spec` and Core's reference texts, `source:'flow'`, `metadata.flow`, `flowSessions`, `flow:<id>`, `flow-*` fences, `flow.state`, `flow_*` error codes, `[flow]` log prefixes — listed once in `server/modules/intent/README.md` ("Frozen identifiers"). HTTP `/intent/*` answers with the same handlers as `/flow/*`. The MCP surface has no Flow-named operation (Intent sessions are driven by mission fences), so it needs no alias; its descriptions change copy only. "Flow" disappears from user-visible copy in eight locales and docs (`8-flow-mode.md` → `8-intent-mode.md`, `docs/internals/flow-mode.md` → `intent-mode.md`).

### D7. OpenSpec bookkeeping

`flow-mode` is archived first, with its smoke task 6.3 carried by this change's smoke task, so its spec becomes canonical. That canonical folder is then renamed `intent-sessions`, with its requirement text reworded to Intent, and is referenced from `intent-mode`. This change archives later as usual.

## Risks / Trade-offs

- **Very large rename diff (~180 files)** → done as one mechanical commit first, with gates green before any behaviour change, so review can separate rename from feature.
- **The intent-draft is heavier than problem-frame** → required lists may be empty; the card collapses empty sections.
- **`intent.md` in archive directories** → OpenSpec tolerates extra files in a change and `archive` moves the directory whole. Validation runs before materialisation, so the file cannot fail a run.
- **Model answers open questions wrongly** → answers are stored as answers, never edit other sections, are visible and editable in the spec detail, and are covered by the reviewer.
- **External MCP clients using Flow names** → aliases kept; removal needs a later deprecation.

## Migration Plan

1. Archive `flow-mode` and rename its canonical spec to `intent-sessions`.
2. Make the mechanical rename commit, with aliases.
3. Add the intent domain and the ticket field.
4. Add the doors: mission card, Add Spec Intent mode.
5. Add the paths and the agent briefings.
6. Add the `intent.md` materialisation.
7. Update the docs in all locales.

Rollback is a plain revert. The data stays readable because the only storage change is an additive optional field.

## Open Questions

- None blocking. The intent per Project Builder milestone, the Companion and website copy, and removing the `/flow` aliases are follow-ups.
