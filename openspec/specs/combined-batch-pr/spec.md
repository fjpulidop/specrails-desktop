# combined-batch-pr Specification

## Purpose
TBD - created by archiving change safe-pr-workflow. Update Purpose after archive.
## Requirements
### Requirement: A multi-ticket batch produces one combined draft PR
When a batch launches multiple tickets at once, the platform SHALL deliver the result as a single combined draft pull request rather than one PR per ticket, assembling the ticket branches onto one integration branch (`sr/<slug>/batch-<id>`) branched from the designated base.

#### Scenario: N tickets yield one PR
- **WHEN** a batch of N tickets completes successfully
- **THEN** the platform opens exactly one combined draft pull request
- **AND** that PR's branch contains the assembled work of all N ticket branches

### Requirement: The combined PR makes per-ticket changes clear
The combined pull request SHALL make explicit which changes were implemented as part of it: its body SHALL list each ticket with its title and a plain-language summary, and per-ticket commit history SHALL be preserved (not squashed) so attribution is visible in the commit log.

#### Scenario: PR body enumerates the tickets
- **WHEN** the combined draft PR is opened
- **THEN** its body lists each ticket (title + plain-language what-changed) as a checklist
- **AND** the commit history retains each ticket's commits with their identity

### Requirement: The AI merge-resolver assembles branches with a safe failure mode
The platform SHALL use the AI merge-resolver to combine the ticket branches into the batch integration branch, keeping it clean. If the branches cannot be combined cleanly, the platform SHALL fall back to separate per-ticket PRs or flag that a human is needed to combine — and SHALL never modify the base branch.

#### Scenario: Clean combine yields one PR
- **WHEN** the ticket branches combine without conflict
- **THEN** one combined draft PR is opened from the batch integration branch

#### Scenario: Unresolvable combine degrades safely
- **WHEN** the ticket branches cannot be combined cleanly
- **THEN** the platform falls back to separate per-ticket PRs or flags "needs a human to combine"
- **AND** the designated base branch is never modified
