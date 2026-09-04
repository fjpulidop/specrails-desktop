## ADDED Requirements

### Requirement: specrails-core implement is git-agnostic under desktop
When invoked by the desktop platform, specrails-core's `implement` command SHALL NOT create branches, commit, push, or open pull requests. It SHALL only write code and verify, then terminate (archiving the OpenSpec change and marking the ticket done). Desktop owns all version control.

#### Scenario: Implement performs no git writes under desktop
- **WHEN** desktop invokes `implement` for any provider (claude, codex, gemini)
- **THEN** the command does not run `git checkout -b`, `git commit`, `git push`, or `gh pr create`
- **AND** it leaves committed-by-desktop changes on the worktree's ticket branch for the platform to deliver

#### Scenario: Behavior is uniform across providers
- **WHEN** the same logical `implement` runs under claude versus codex versus gemini
- **THEN** all three exhibit the same git-agnostic behavior (no self-ship)

### Requirement: The suppression signal travels with the invocation
The platform SHALL suppress specrails-core's ship behavior via a provider-invariant signal that travels with the invocation (an explicit flag such as `--no-ship`, and/or the `SPECRAILS_GIT_AUTO=false` environment variable), parsed early in `implement` and short-circuiting the ship phase. The platform SHALL NOT rely solely on a config file, which does not survive into a freshly created worktree.

#### Scenario: Signal survives into a fresh worktree
- **WHEN** implement runs inside a newly created worktree that does not contain `.specrails/backlog-config.json`
- **THEN** the git-agnostic signal still reaches implement (via flag/env)
- **AND** the ship phase is short-circuited

#### Scenario: Desktop passes the signal on every invocation
- **WHEN** desktop launches any rail that invokes implement
- **THEN** the git-agnostic signal is included for all three providers and both `all`-scoped and per-ticket paths

### Requirement: Implement runs per-ticket isolated
The platform SHALL run the implement command per-ticket inside an isolated worktree so it is subject to the same isolation + draft-PR law as other mutating loops, rather than in a shared working directory.

#### Scenario: Implement obeys the isolation law
- **WHEN** an implement rail is launched for one or more tickets
- **THEN** each ticket's implement runs in its own isolated worktree
- **AND** its result is delivered as a draft PR by the platform, not by the agent

### Requirement: Desktop retires local merge-back on the mutating path
The platform SHALL NOT merge loop results into the locally checked-out branch. In place of the former local `git merge --no-ff` integration, the platform SHALL push the branch and open a draft PR.

#### Scenario: No local auto-merge occurs
- **WHEN** a mutating loop completes successfully
- **THEN** the platform does not merge the ticket branch into the local integration branch
- **AND** instead pushes the branch and opens a draft PR
