# First engine v2 release — preparation (not published)

28 September 2026. Status: **prepared, nothing published.** The owner asked on
28 September to prepare the first release without publishing it. Every step
below that publishes, tags or deploys is marked **(owner)** and has not been
run.

## What ships

| Repository | Integration PR chain | Expected version | Why that version |
| --- | --- | --- | --- |
| specrails-core | `main` ← #385 (C0) ← #389 (engine v2) | **6.1.0** | release-please on merge commits: 7 `feat`, 15 `fix`, no `!` or `BREAKING CHANGE` |
| specrails-desktop | `main` ← #706 (D0) ← #708 (Desktop v2) | **2.58.0** | 20 `feat`, 10 `fix`, no breaking markers; one `wip` commit is ignored by release-please |
| specrails-web | `main` ← #218 | deploy only | documentation site |

Contract: integration schema stays **5.1**; `runtime api` stays API 1 with
additive fields (`engineVersion`, `nodeKinds`, `engines: [1, 2]`, engine-v2
capabilities). `SUPPORTED_CORE_MAJORS` stays `[4, 5, 6]`. Engine 1 keeps
running, and legacy loops keep working. Core 7 and the legacy removal are later
gates (Core 11.x, Desktop 10.1/10.4).

## Release notes (drafts)

**Core 6.1.0.** Workflow definitions run on a durable LangGraph engine with
SQLite checkpoints and leases. A 17-piece catalog adds nested implementation,
ticket maps, typed assignments, human questions and approvals, resume, fork,
steering and cancellation inboxes. Recovery never repeats committed work.
Interrupted writes need explicit recovery, and abandoned provider calls settle
once with unknown usage. `runtime api` advertises the engines it can launch.
Windows `cmd` shell lines are passed verbatim. The built-in implementation
workflow and its identities (workflow 7, instructions 10) are unchanged.

**Desktop 2.58.0.**
- The loop builder authors Core workflows with typed pieces, nested graphs,
  Agent Studio roles and localized templates.
- Runs show Core steps, verification evidence, per-invocation accounting and
  steering receipts. Resume, cancel and fork keep the original Core package.
- Saved legacy loops convert explicitly into reviewable drafts, and a read-only
  migration check lists what needs attention.
- Optional runtime history retention is off by default, with preview and
  crash-safe quarantine.
- Converted Batch runs one isolated implementation per ticket (owner decision).

## Order of operations

1. **Pre-flight (done unless noted).**
   - CI is green on #389 and #708 at their heads, checked again after the latest
     pushes.
   - `check-core-compat` passes against the current Core.
   - Web guide freshness and tests pass.
   - OpenSpec tasks list only release-dependent or real-data items as open.
2. **Core to main (owner).**
   - Merge #385 into `main`, retarget #389 to `main`, and merge it with a merge
     commit.
   - `release.yml` requires green CI on that `main` commit, then release-please
     opens `chore(main): release 6.1.0`. Review its CHANGELOG.
3. **Publish Core (owner).** Merging the release PR tags `v6.1.0` and publishes
   npm. This is the first publishing step.
4. **Pair Desktop with the published Core** (a PR on the Desktop chain):
   - Set `CORE_BUNDLE_VERSION: "6.1.0"` in `desktop-release.yml`.
   - Regenerate `scripts/assemble-bundled-core.lock.json` with the repository's
     tooling (never by hand).
   - Move the CI paired pin from a branch commit to the `v6.1.0` commit.
   - Run `npm run check-core-compat`, `npm run check:package` and the paired CI
     job.
   - Close Desktop 1.6 and Core 5.5 with the published-package evidence.
5. **Desktop to main (owner).** Merge #706, then #708 (retargeted), with merge
   commits. Optionally dispatch `Desktop Release` with `validation_only: true`
   first: it builds, signs and tests without publishing.
6. **Publish Desktop (owner).** Merge the release PR, and `v2.58.0` builds the
   native artifacts.
7. **Web (owner).** Merge #218 once Desktop 2.58.0 is public, so the guide
   describes shipped behavior. Web's `release.yml` also runs release-please on
   `main`, and the verified build is deployed through that release path.
8. **After release.**
   - Start the two-release zero-legacy-use window (Desktop 10.1).
   - Validate the migration check against real saved loops (10.2/10.3).
   - Keep Core 11.x blocked until that window and D8 are complete.

## Known limitations carried into the release

- Real paid-provider evaluation (`runtime evaluate --real`) has not been run; no
  cost or quality improvement is claimed.
- Parity against user-saved loops from real projects is unproven because none
  were available. The migration check exists to surface them.
- Converted Batch costs about 2× the invocations of the legacy combined pipeline
  for two tickets, by decision.
- Seven loops/rails router tests fail only locally when a sibling
  `../specrails-core/dist` exists; CI is unaffected (tracked separately).
