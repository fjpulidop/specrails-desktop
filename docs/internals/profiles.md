# Profiles — Quick start

Profiles let you save a named combination of orchestrator model, agent
chain, per-agent models, and routing rules, and pick one per rail at
launch time. Different rails on the Dashboard can run different profiles
simultaneously — useful for batch runs where each feature needs a
different flavor of pipeline.

Requires **`specrails-core >= 4.1.0`** in the target project. Without
it, the app still lets you create/edit profiles but the pipeline runs in
legacy mode (a yellow banner on the Agents page tells you when this is
the case).

---

## 1. Open the Agents section

From any project, click **Agents** in the right sidebar (next to
Dashboard/Jobs/Analytics/Settings).

- **Profiles** tab — create and edit profiles.
- **Usage** tab — see which profiles are actually being used (backed by
  the `/analytics` endpoint covered in section 8).
- **Catalog** tab — read the upstream `sr-*` agents or author custom
  `custom-*` ones via the Studio.

When the project has no profiles yet, the empty state offers two entry
points:

- **Migrate from current agents** — reads your existing
  `.claude/agents/` frontmatter models and creates a `default` profile
  mirroring today's behavior (zero-loss). It requires the baseline trio
  `sr-architect`, `sr-developer`, and `sr-reviewer` to be present — the
  server rejects the migration if any is missing. On a project whose
  primary provider is **not** Claude (Codex or Gemini), the frontmatter
  model aliases aren't in that provider's catalog, so the migration stamps
  the project's `provider` onto the profile and substitutes that provider's
  default model — the resulting `default` profile still validates and is
  ready to edit (though it only takes effect on Claude rails — see
  [Multi-provider rails](#multi-provider-rails-claude-codex-and-gemini)).
- **Blank profile** — start from scratch.

## 2. Saved profiles vs selection

Two orthogonal concepts:

- **Saved profiles** — the set of profiles in the project (`.specrails/profiles/*.json`).
  Committed to git, shared with the team.
- **Selection** — which profile this particular invocation uses. Per-rail,
  per-launch.

Resolution order when no explicit selection is passed:

1. The profile named `default` (or `project-default`).
2. Legacy mode (no profile active).

## 3. Pick a profile at launch

Profiles are picked on the **Dashboard rails board**, not in a separate
wizard. Each rail header has a compact profile dropdown
(`RailProfileSelector`):

- Pick a profile once and it persists across launches of that rail
  (stored per rail; sent inline on `POST /rails/:i/launch`, or set on its
  own via `PUT /rails/:i/profile`).
- Concurrent rails can run different profiles at the same time, so a batch
  spread across rails can give each feature its own flavor of pipeline.
- The selector **self-hides** when the project has no profiles, so it never
  leaves an empty gap in the rail header.

The "No profile" option is always available — use it to run a
rail exactly as it did pre-4.1.0.

### Multi-provider rails (Claude, Codex, and Gemini)

**Profiles apply only to Claude rails.** specrails-desktop supports three
interchangeable AI providers — Claude, Codex, and Gemini — but agent
profiles are a Claude-only concept (Codex and Gemini have no equivalent).

When a rail's AI engine is **anything other than Claude** (Codex or
Gemini), the app force-nulls the profile and runs the rail in legacy mode.
The rails router enforces this server-side for *any* non-Claude engine, so
no profile env var is ever injected on a Codex or Gemini rail regardless of
what the UI shows.

> **Known UI limitation.** The client currently only hides the profile
> selector for **Codex** rails. On a **Gemini** rail the selector can still
> appear — but the server ignores any profile you pick there (it always
> falls back to legacy mode). Picking a profile on a Gemini rail therefore
> has no effect; treat it as a no-op until the selector is hidden for all
> non-Claude engines.

Provider availability itself is gated separately (both default-enabled): set
`SPECRAILS_CODEX_BETA=0` or `SPECRAILS_GEMINI_BETA=0` to disable a provider
app-wide. See [../codex.md](../codex.md) and [../gemini.md](../gemini.md).

## 4. Author a custom agent (Agent Studio)

From the Catalog tab, create a new custom agent via:

- **Template** — start from one of ~50 curated templates spanning many
  categories (engineering, product, data, security, …) — for example
  Security Reviewer, Performance Profiler, Data Engineer, or UI/UX Polisher.
- **Generate** — describe the agent in natural language; Claude drafts the
  full `.md` for you to review and edit before saving.
- **Blank** — start from a minimal template.
- **Duplicate** — copy any existing agent (upstream or custom).

Custom agents live at `.claude/agents/custom-*.md` and are never touched
by `specrails-core`'s installer/update scripts. Every save appends a new
version row; open **History** in the Studio to browse and restore.

Click **Test** in the Studio to run the current draft against a sample
task in an isolated `claude` invocation — no files are written, and you
see output, token count, and duration inline.

## 5. Observe

- A **profile badge** (themed with the `accent-primary` color) appears on
  each job row showing which profile it ran under.
- The **Usage** tab (the same `/analytics` data from section 8) shows
  usage per profile for the last 7/30/90 days: jobs, success rate, avg
  duration, avg tokens, and avg cost.
- The **diagnostic ZIP export** on a job includes `profile.json` with
  the exact snapshot that rail used.

## 6. Troubleshooting

- **Upgrade banner on Agents page** — run
  `npx specrails-core@^4.8.0 update` in the project to bring it up to date
  (profiles need ≥ 4.1.0; the version the app installs is `^4.8.0`).
- **Save disabled with "N issues to resolve"** — the live validator
  enforces the baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`)
  and routing ordering. Among the rules: a `default: true` routing rule (if
  present) must be the **last** entry in `routing` and must target
  `sr-developer`. Fix the listed issues and Save re-enables.
- **"agent 'xyz' already exists" (409)** — the name collides with an
  existing file in `.claude/agents/`. Pick a different name.
- **The whole Agents section is missing** — it can be disabled server-side
  with `SPECRAILS_AGENTS_SECTION=false`, which 404s the entire
  `/profiles` router. Unset it (or leave it at its default) to restore the
  section. This flag is read **once at server startup**, so changing it
  takes effect only after a server restart.

## 7. Reserved paths

`specrails-core`'s installer guarantees it will never touch:

- `.specrails/profiles/**` — your profile catalog.
- `.claude/agents/custom-*.md` — your custom agents.

Everything else under `.specrails/` (install-config, specrails-version,
setup-templates) is managed by the installer and may be overwritten on
update.

## 8. For developers

A few internals worth knowing if you're working on this surface:

- **Version gate.** Profile-aware spawns are gated by
  `projectSupportsProfiles()` (`server/queue-manager.ts`), which reads the
  project's `.specrails/specrails-version` and requires
  `specrails-core >= 4.1.0`. Below that, the rail spawns in legacy mode and
  no profile env var is injected. The same is true on any non-Claude rail:
  the rails router force-nulls the profile for Codex/Gemini engines, so the
  `SPECRAILS_PROFILE_PATH` injection below only ever takes effect on a
  Claude rail.
- **Snapshot per job.** When a rail launches with a profile, the resolved
  profile is written to
  `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json` (chmod `400`, so
  mid-run edits are impossible) before the `claude` process spawns. The
  spawn env then carries `SPECRAILS_PROFILE_PATH` pointing at that file.
  The same snapshot is persisted to the `job_profiles` table for the Usage
  analytics.
- **REST surface.** All profile operations live under
  `/api/projects/:projectId/profiles` — list/get/create/update/delete,
  `/:name/duplicate`, `/:name/rename`, `/resolve`, `/migrate-from-settings`,
  `/analytics`, `/core-version`, and the catalog routes under `/catalog`.
  The router 404s entirely when `SPECRAILS_AGENTS_SECTION=false`. See
  [api-reference.md](api-reference.md) for the full route list.
