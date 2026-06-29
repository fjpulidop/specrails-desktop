## Why

Driving a Specrails ticket all the way through the OpenSpec lifecycle (scaffold → generate artifacts → implement → verify → archive) is today a manual, multi-command chore. The loop engine already has every primitive needed to automate it — an app-driven runner, an AI decider that judges completeness against the ticket, bounded loop-back, and provider-aware magic commands — but there is no template that wires them into a single-agent, ticket-to-archive lifecycle, and no `opsx:*` commands in the magic-command catalog. This change ships that template so a user can launch one rail and walk away.

## What Changes

- **New loop template `opsx-lifecycle`** in the catalog (category `Automation`): a hand-authored `LoopGraph` that runs, per ticket, `opsx:ff` → `opsx:apply` → `opsx:verify` → decider; on a FAIL verdict it loops back to `opsx:ff` (amending the same change with the gaps `verify` reported); on PASS it runs an unattended `openspec archive <id> -y` shell node, then ends. Single agent, no multi-agent pipeline.
- **`opsx:verify` is the loop condition.** The `verify` step reads the real artifacts/tasks/code and produces the PASS/FAIL verdict; the decider node is a thin gate that routes that verdict. (Deliberately NOT a bare decider judging only `title`+`description`.)
- **Three new provider-aware magic commands** — `{{cmd:opsx:ff}}`, `{{cmd:opsx:apply}}`, `{{cmd:opsx:verify}}` — expanding to `/opsx:ff` (claude, gemini) and `$opsx:ff` (codex), with a template fallback for providers lacking the native command. (`archive` uses the `openspec` CLI directly via a shell node, so it needs no magic command.)
- **New run-scoped token `{{run.changeId}}`.** The engine captures the OpenSpec change id from the first `opsx:ff` step's output (regex on `openspec/changes/<id>`, the pattern `SpecLauncherManager` already uses) and exposes it to later prompts — used both in the loop-back `opsx:ff` prompt ("continue change `<id>`, address: …") and in the `openspec archive <id> -y` shell node. This is the only non-declarative addition.
- **Momentum override** baked into the step prompts so `opsx:ff`/`opsx:apply` never block on "unclear/design issue/error" in a headless run.
- **NOT** starting at `opsx:new` (it only scaffolds then stops; `opsx:ff` scaffolds + generates internally — chaining both risks the "change already exists" branch). **NOT** using `opsx:bulk-archive` (it is hard-wired interactive with no yes-to-all; one ticket → one change → single unattended `openspec archive`).

## Capabilities

### New Capabilities
- `opsx-lifecycle-loop`: the end-to-end behavioral contract of the `opsx-lifecycle` loop template — its graph shape, `verify`-as-verdict + decider-as-router semantics, FAIL→loop-back-amend and PASS→unattended-archive routing, iteration/timeout/cost bounds, and the claude-first provider scope.

### Modified Capabilities
- `loop-magic-commands`: the magic-command catalog gains the `opsx:ff`, `opsx:apply`, `opsx:verify` provider-native commands (claude/gemini `/opsx:`, codex `$opsx:`, plus template fallback).
- `loop-execution`: the runner gains a run-scoped capture variable surfaced as `{{run.changeId}}`, extracted by regex from a step's output and resolvable in subsequent ai-step prompts and shell-node commands.
- `loop-template-catalog`: the catalog exposes the `opsx-lifecycle` template under the `Automation` category and serves it for instantiation like any other starter template.

## Impact

- **Server**: `server/loop-command-catalog.ts` (3 new commands), `server/loop-templates.ts` (`LOOP_TEMPLATES` hand-authored graph), `server/loop-run-manager.ts` (`{{run.changeId}}` capture + resolution in ai-step prompts and shell commands).
- **Tests**: new unit tests for the three providers' command expansion, the template's graph validation/compilation/launch, the change-id capture + resolution, and the archive shell node. Must hold the mandatory coverage gates (80% server lines/functions/statements, 70% branches).
- **No client changes required** for v1 (the template appears in the existing gallery via `GET /loop-templates`; `Automation` is an existing category, so no taxonomy edit on client or server).
- **No `specrails-core` changes.** The `opsx:*` commands are installed by OpenSpec, not the specrails framework.
- **Open risk (tracked, not blocking)**: `opsx:ff/apply/verify` are OpenSpec-generated commands confirmed only for claude in framework 4.10.0 (codex/gemini ship only `opsx-diff`). The template is therefore **claude-first**; the template fallback only partially covers codex/gemini. Full multi-provider parity depends on OpenSpec's own multi-provider command generation and is out of scope here.
