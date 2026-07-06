## Why

The Loop Builder shipped with **8** Specrails-owned starter templates and a small `{{cmd:*}}` catalog (`implement`, `batch`, `freestyle`, `fix`, `verify`). That is enough to prove the pattern but too thin to be a real library: a user opening the gallery sees a handful of CI/test loops, has no way to search or filter them, and authoring a new loop means re-typing the same verify/commit/PR/anti-gaming prose into every step.

Public closed-loop directories (e.g. loops.elorm.xyz) demonstrate the breadth users expect — ~40 loops spanning testing, CI, security, docs, migrations, performance, review and more, each tagged and categorised, each carrying a hardened set of **anti-gaming guardrails** so the agent cannot cheat its own exit condition. We want that breadth, expressed entirely in **Specrails-owned text** and native authoring primitives (`{{spec.*}}`, `{{cmd:*}}`, `{{const:*}}`, the Loop Decider), plus the discovery UX (search + category chips) that makes a large library usable.

This change grows the library to a categorised, searchable catalog; distills the repeated step prose into reusable provider-aware magic commands (including a new `{{cmd:loop}}` that maps to Claude's `/loop` and Codex's `$goal`); and adds a read-only `{{const:GUARDRAILS}}` anti-gaming contract injected by the templates — making the Loop Builder both broader and harder to misuse.

## What Changes

- **Categorised template catalog.** `LoopTemplate` gains a `category` field (one of a fixed 15-value taxonomy: `API, Automation, CI, Database, Debugging, DevOps, Docs, Git, Maintenance, Performance, Planning, Quality, Review, Security, Testing`). The existing 8 templates are categorised; the catalog grows to **~40+** Specrails-owned templates covering the taxonomy, each with `category` + `tags` + a publishable, validated graph. Templates are **authored from patterns, not copied** — original Specrails naming and prompt text; no third-party content is bundled.
- **Template discovery UI.** The `/loops` gallery gains a **search bar** (matches name, description, tags, category) and a row of **category chips** (multi-select filter, derived from the catalog with per-category counts). Each template card shows its category badge + tags. An empty-state renders when filters match nothing.
- **Provider-aware `{{cmd:loop}}`.** A new magic command that resolves to the agent-native autonomous-loop entry point per provider: Claude `/loop`, Codex `$goal`, and a self-contained "keep iterating until the goal is met" prompt fallback for providers without one (e.g. Gemini). Invocable inside any AI Step.
- **Distilled common magic commands.** New provider-invariant `{{cmd:*}}` building blocks lifted from the recurring steps across the catalog: `test`, `lint`, `typecheck`, `build`, `coverage`, `format`, `commit`, `push`, `pr`, `ci-status`, `audit`, `docs-sync`, `review`. Templates compose these instead of duplicating prose — one edit updates every loop that uses them.
- **`{{const:GUARDRAILS}}` anti-gaming constant.** A new read-only built-in constant carrying the canonical hardened guardrails (do not weaken/skip tests, do not edit the check/exit to force success, stop and report blockers instead of gaming metrics, prefer fixing production code over patching tests). Mutating templates inject it so no ported loop can quietly cheat its exit.
- **All new user-facing strings** ship in the 8 supported locales (`loops` namespace extension + new `categories.*` / `gallery.*` keys); the key-parity test enforces it.

Not breaking: the template endpoint stays additive (`category` is a new optional field, defaulted), the command/constant catalogs are append-only, and a project that never opens Loops is unaffected. Existing template ids, command names, and the two `VERIFICATION_*` built-ins are preserved.

## Capabilities

### New Capabilities
- `loop-template-catalog`: the categorised, expanded Specrails-owned template library — the `category` field + 15-value taxonomy, the ~40+ templates, the deterministic spec→graph porting transform, and the dedup/ownership rules.
- `loop-template-discovery`: the gallery search bar + category chips + card badges + empty state + their locale coverage.
- `loop-magic-commands`: the provider-aware `{{cmd:loop}}` (Claude `/loop` / Codex `$goal` / prompt fallback) and the distilled common-command catalog, plus their per-provider expansion.
- `loop-constants-guardrails`: the read-only `{{const:GUARDRAILS}}` built-in and its injection contract.

### Modified Capabilities
<!-- The loops-library / loop-builder-canvas capabilities introduced by the `loop-builder` change are not yet archived into openspec/specs/, so the additions here are expressed as new capabilities rather than MODIFIED deltas against an unpublished base. -->

## Impact

- **Server (modified)**: `loop-templates.ts` (+`category`, the porting helper, ~40 templates), `loop-command-catalog.ts` (+`providerNative` field, `{{cmd:loop}}`, the distilled commands, per-provider expansion), `loop-constants.ts` (+`GUARDRAILS` built-in), `loops-router.ts` (template payload carries `category`). All append-only / additive.
- **Server (tests)**: `loop-templates.test.ts`, `loop-command-catalog.test.ts`, `loop-constants.test.ts` extended (template count + category validity, new command resolution per provider, `{{cmd:loop}}` fallback, `GUARDRAILS` presence/read-only).
- **Client (new)**: a `TemplateGalleryFilter` (search + chips) extracted within `LoopsPage`; pure filter logic in a testable module.
- **Client (modified)**: `LoopsPage.tsx` (filter state, category chips, card badges, empty state), `loops-api.ts` (`LoopTemplateSummary.category`), `TemplatePreviewModal.tsx` (category badge).
- **i18n**: `loops` namespace gains `gallery.*` + `categories.*` keys across all 8 locales; key-parity test must pass.
- **Database**: none — templates/commands are code-bundled; `GUARDRAILS` is a code built-in (no migration). Existing seeded `loop_constants` rows are untouched.
- **specrails-core**: ZERO coupling — loops remain raw-prompt; `{{cmd:loop}}` targets the providers' own CLIs, not core.
- **Coverage**: all new logic (porting transform, command expansion, constant injection, gallery filter) is pure and unit-tested to keep server ≥80% and client ≥80%.
