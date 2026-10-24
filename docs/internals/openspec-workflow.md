# OpenSpec (opsx) Workflow

> **Note:** The OpenSpec Changes UI (the `/changes` route in the dashboard) was removed in the SPEA-341 redesign. There is no dashboard surface for the `opsx:*` workflow — you drive it from a Claude Code conversation, not from the app UI.

OpenSpec is the structured change-management workflow this repository uses to evolve itself. Every feature, fix, or refactor goes through a lifecycle of **artifacts** — from a proposal to an archived implementation — so that whoever (human or AI) picks up the work always has the full context.

This is a **contributor** workflow: it manages the app's _own_ changes under `openspec/`. It is not a per-project end-user feature exposed in the dashboard.

---

## How it works

The `opsx:*` commands are **Claude Code slash commands** (defined in `.claude/commands/opsx/`). When you type one in a Claude Code conversation, the assistant drives the standalone **`openspec` Node CLI** to scaffold change directories, read artifact templates, and report status — then does the actual artifact authoring, code edits, and verification **directly in the conversation**.

Two consequences worth internalizing:

- **They do not require the specrails-desktop server.** `opsx:*` is independent of the app process; nothing is queued, no rail is launched, and nothing streams to the Dashboard.
- **They are distinct from `/specrails:implement`.** The Architect → Developer → Reviewer agent pipeline is a _separate_ flow (`specrails-desktop implement`, backed by the `sr-architect` / `sr-developer` / `sr-reviewer` agents). `opsx:apply` does **not** spawn those agents — it implements tasks itself, in the same conversation.

Under the hood the assistant calls the `openspec` binary for state, e.g.:

```bash
openspec list --json                          # active + recent changes
openspec new change "<name>"                  # scaffold a change directory
openspec status --change "<name>" --json      # artifact graph + progress
openspec instructions <artifact-id> --change "<name>" --json   # template + context
openspec instructions apply --change "<name>" --json           # apply context files
```

You normally won't run these by hand — the slash command orchestrates them for you.

---

## Where changes live

Changes are scaffolded under your project's `openspec/` directory:

```
openspec/
  config.yaml                 # selects the workflow schema (here: spec-driven)
  changes/
    <name>/                   # an active change
      proposal.md
      design.md
      tasks.md
      specs/<capability>/spec.md
      ...
    archive/                  # completed changes, date-prefixed
      2026-04-20-pipeline-telemetry/
      2026-04-24-add-agents-profiles/
      ...
  specs/                      # main (synced) capability specs
```

Archives land under `openspec/changes/archive/` (singular `archive`) with a `YYYY-MM-DD-<name>` directory name.

---

## Artifacts are schema-driven

There is **no fixed list** of artifact filenames. The set is determined by the **workflow schema** declared in `openspec/config.yaml` (`schema: spec-driven` in this repo). The assistant reads the live artifact graph from `openspec status --change <name> --json` and never assumes specific names.

For the default **`spec-driven`** schema the artifacts are:

| Artifact | Purpose |
|----------|---------|
| `proposal.md` | Why / What changes / Capabilities / Impact |
| `specs/<capability>/spec.md` | One delta spec per capability listed in the proposal |
| `design.md` | Technical decisions, architecture, implementation approach |
| `tasks.md` | Checkboxed implementation tasks (`- [ ]` / `- [x]`) |

Some changes also carry `context-bundle.md` and a `.openspec.yaml` marker. Other schemas define a different artifact set entirely — always trust the CLI status output, not a hardcoded list.

---

## The change lifecycle

```
opsx:explore        (optional) think through the idea first — no code
   │
   ▼
opsx:new            scaffold the change, show the first artifact template
   │
   ▼
opsx:ff             generate all apply-ready artifacts in one pass
   │   (or opsx:continue to create one artifact at a time and review each)
   │
   ▼
opsx:apply          implement the tasks in-conversation, flipping - [ ] → - [x]
   │
   ▼
opsx:verify         in-conversation Completeness / Correctness / Coherence report
   │
   ▼
opsx:sync           (when needed) merge delta specs into openspec/specs/
   │
   ▼
opsx:archive        move the change to openspec/changes/archive/YYYY-MM-DD-<name>/
```

---

## Commands reference

Run these as Claude Code slash commands inside a conversation in the repo.

### `opsx:explore` — Think before you build

A thinking-partner mode for shaping an idea, investigating the codebase, or comparing approaches. It reads files and draws diagrams but **never writes application code**. It may capture decisions into OpenSpec artifacts if you ask, but it won't implement.

```
/opsx:explore real-time collaboration
```

Use it when the problem is still fuzzy. When things crystallize, it can flow straight into a proposal.

---

### `opsx:new` — Start a new change

Scaffolds the change directory and **shows the first artifact's template and instructions** — then stops and waits for your direction. It deliberately creates **no artifacts yet**.

```
/opsx:new add-user-auth
```

You can also pass a description instead of a name and let the assistant derive a kebab-case name.

---

### `opsx:ff` — Fast-forward artifact creation

Generates every artifact required to start implementation in one pass (in dependency order, reading each upstream artifact for context). Best when the task is well-defined and you want to go straight to `opsx:apply`.

```
/opsx:ff add-user-auth
```

The assistant loops the schema's artifacts, creating each one until everything `apply.requires` is done.

---

### `opsx:continue` — Create the next artifact, one at a time

Creates exactly **one** artifact per invocation — the next one whose dependencies are satisfied — then stops. Use it when you want to review and adjust each artifact before the next is drafted.

```
/opsx:continue add-user-auth
```

Run it repeatedly until all artifacts exist, then move on to `opsx:apply`.

---

### `opsx:apply` — Implement the change

Reads the change's context files (via `openspec instructions apply --json`), then **implements the tasks directly in the conversation** — making the code edits and marking each task `- [ ]` → `- [x]` in the tasks file as it goes. It loops until all tasks are complete or it hits something that needs your input.

```
/opsx:apply add-user-auth
```

> **Not the app pipeline.** `opsx:apply` does the work itself, in-conversation. It does **not** queue a server job, spawn Architect/Developer/Reviewer agents, or stream to the Dashboard. For the agent pipeline, use `specrails-desktop implement` instead.

---

### `opsx:verify` — Verify the implementation

Reads the artifacts and builds an in-conversation **verification report** across three dimensions:

- **Completeness** — are all `tasks.md` checkboxes done? Are all spec requirements implemented?
- **Correctness** — does the implementation match the requirements and cover the scenarios?
- **Coherence** — does the code follow the decisions in `design.md` and the project's patterns?

```
/opsx:verify add-user-auth
```

Issues are graded CRITICAL / WARNING / SUGGESTION with file/line references. Resolve any CRITICALs (manually or by re-running `opsx:apply`), then verify again before archiving.

---

### `opsx:sync` — Sync delta specs to main specs

When a change adds, modifies, removes, or renames requirements, `opsx:sync` merges those delta specs (`openspec/changes/<name>/specs/`) into the main specs at `openspec/specs/<capability>/spec.md`. It's an **agent-driven intelligent merge** — it can add a single scenario without rewriting the whole requirement, and is idempotent. The change stays active; archive it once implementation is done.

```
/opsx:sync add-user-auth
```

---

### `opsx:archive` — Archive a completed change

Moves the change to `openspec/changes/archive/YYYY-MM-DD-<name>/`. Before moving, it checks artifact and task completion (warning if anything is incomplete) and, when delta specs exist, offers to sync them first.

```
/opsx:archive add-user-auth
```

---

### `opsx:bulk-archive` — Archive several changes at once

Archives multiple completed changes in a single operation, checking the codebase to resolve spec conflicts intelligently. Use it when you've finished a batch of parallel changes.

```
/opsx:bulk-archive
```

---

### `opsx:onboard` — Guided walkthrough

A teaching mode that walks you through a complete OpenSpec cycle on real work in the codebase, narrating each step. Run it the first time you touch this workflow. (It checks that the `openspec` CLI is installed before starting.)

```
/opsx:onboard
```

---

## Use cases

### Feature implementation

```
/opsx:ff add-user-auth      # scaffold + generate all artifacts
# review the generated proposal / design / tasks
/opsx:apply add-user-auth   # implement the tasks in-conversation
/opsx:verify add-user-auth  # check completeness/correctness/coherence
/opsx:sync add-user-auth    # merge delta specs into main specs (if any)
/opsx:archive add-user-auth # archive
```

### Bug fix

For a well-understood bug, go straight to fast-forward:

```
/opsx:ff fix-token-refresh
# review the generated artifacts to confirm they describe the fix
/opsx:apply fix-token-refresh
/opsx:verify fix-token-refresh
/opsx:archive fix-token-refresh
```

### Refactor with careful artifact review

Use `opsx:explore` to think first, then create artifacts one at a time:

```
/opsx:explore the auth system is getting unwieldy
/opsx:new refactor-auth
/opsx:continue refactor-auth   # creates the proposal — review it
/opsx:continue refactor-auth   # creates the next artifact — review it
# ...repeat until all artifacts exist...
/opsx:apply refactor-auth
/opsx:verify refactor-auth
/opsx:archive refactor-auth
```

---

## Browsing changes via the app API

Although the dashboard `/changes` UI was removed, the server still **reads** the OpenSpec directory and exposes two read-only endpoints (per project):

| Endpoint | Returns |
|----------|---------|
| `GET /api/projects/:projectId/changes` | Active + archived changes (parsed from `openspec/changes/`) |
| `GET /api/projects/:projectId/changes/:changeId/artifacts/:artifact` | A single artifact's content (`proposal.md`, `design.md`, `tasks.md`, `delta-spec.md`, `context-bundle.md`) |

These are handy for tooling that wants to surface the artifact set without parsing the filesystem directly.

---

## Requirement traceability in CI

With a Core that announces `specTrace: 1` (contract 5.5), every OpenSpec requirement has a stable id `<capability>/<slug>` (from `### Requirement: <name>` in `openspec/specs/<capability>/spec.md`: accents removed, lowercase, every run of non-alphanumerics one `-`). A test claims a requirement with `[spec:<capability>/<slug>]` anywhere in its title, or a `// spec: <capability>/<slug>` comment (`# spec:` in Python and shell) on the line before it.

Add the check after your test suite so CI fails when a requirement the change adds, modifies or renames has no passing tagged test:

```jsonc
// package.json
{
  "scripts": {
    "test": "vitest run",
    "spec:check": "specrails-core pipeline trace --check --tests-passed"
  }
}
```

```yaml
# .github/workflows/ci.yml (job steps)
- run: npm ci
- run: npm test
- run: npm run spec:check   # exits 1 and names each touched requirement that is not demonstrated
```

- `--tests-passed` tells the scanner the suite already passed in this job (CI has no Specrails verification receipt). Run it only after the tests.
- Without `--check` the command only reports (exit 0, never fails), which is useful to see `Requirements demonstrated X/Y` locally: `npx specrails-core pipeline trace`.
- `--change <name>` limits the check to one change; `--tests <glob>` restricts which files count as tests; `--json` prints the report. Inside an installed project the same scanner ships as `node .specrails/runtime/trace.mjs --check --tests-passed`.
- `specrails-core` must be available to CI (a dev dependency or `npx specrails-core@<version>`).

In a run, Core writes the same report as `spec-trace.json` after each passing verification; the review packet shows it as **Requirements demonstrated X/Y** and loop economics sums it per loop. See [existing-project anchoring](existing-project-anchoring.md#requirement-traceability).

---

## Further reading

- [CLI reference](../cli.md) — the `specrails-desktop` CLI and its verbs
- [Architecture](architecture.md) — server modules and how the app is wired
- [Adding a provider](adding-a-provider.md) — extending the provider adapter contract
