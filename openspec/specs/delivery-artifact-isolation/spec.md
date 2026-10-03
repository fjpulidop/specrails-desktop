# delivery-artifact-isolation Specification

## Purpose
Preserve failed work for recovery while isolating fresh launches and preventing unrelated planning artifacts or machine-specific overlay links from reaching automated delivery.
## Requirements
### Requirement: Fresh launches preserve and isolate unfinished work

A new launch without an exact recorded delivery continuation SHALL allocate a distinct worktree and new collision-free branch from the selected base. It MUST preserve prior committed and uncommitted work. Same-run recovery SHALL retain its frozen checkout.

#### Scenario: Failed attempt followed by a new launch
- **WHEN** a failed attempt leaves source edits and an active change in its mount
- **THEN** a new launch starts from the selected base in a different mount and branch
- **AND** the failed attempt's files remain available for recovery

#### Scenario: Recorded continuation
- **WHEN** a launch continues an exact delivered branch or open PR
- **THEN** allocation retains that branch and validates its recorded commit

### Requirement: Automated delivery rejects planning residue and external links

Before staging, settlement SHALL reject active OpenSpec changes newly introduced relative to the frozen allocation baseline. Index audits MUST reject deliverable symlinks with absolute destinations outside the checkout. Rejected work SHALL remain recoverable and MUST NOT be published.

#### Scenario: Foreign active change survives implementation
- **WHEN** a successful loop archives its own change but leaves a new second active change
- **THEN** settlement blocks commit and names the active directory

#### Scenario: Existing base change and new archive
- **WHEN** an active change already exists in the selected baseline and the run adds an archived change
- **THEN** these paths alone do not block delivery

#### Scenario: Unrecorded overlay link
- **WHEN** an external absolute symlink is staged but absent from overlay exclusions
- **THEN** the index audit blocks commit while retaining the working files

#### Scenario: Agent has already committed an external link
- **WHEN** the candidate branch contains a new external absolute symlink already committed by an agent
- **THEN** settlement blocks delivery even if that path appears in current overlay exclusions

### Requirement: Stable delta identity and truthful revision admission

Equivalent revision or addendum retries SHALL use a stable readable lowercase kebab-case change name of at most 64 characters independent of runId. An active declared change SHALL be reused. Revision semantics MUST require durable delivered work; addenda on a failed generation with no delivered work SHALL be claimed for a fresh full-spec launch.

#### Scenario: Equivalent retry
- **WHEN** runId changes but durable revision/addendum identity and body do not
- **THEN** the seeded change ID remains identical

#### Scenario: Failed generation with open addenda
- **WHEN** an addendum launch targets a failed generation with no delivered branch or PR
- **THEN** it receives the full frozen addenda without claiming the previous work was delivered

### Requirement: Overlay exclusions survive provider changes

Provider switching SHALL preserve authenticated prior overlay exclusions across supported provider namespaces. Commit-exclusion ownership MUST remain independent of cleanup permission for modified copies.

#### Scenario: Codex overlay followed by Claude
- **WHEN** a retained checkout's Codex overlay is followed by a Claude overlay
- **THEN** both providers' authenticated overlay paths remain excluded from commits
- **AND** modified copies remain ineligible for automatic cleanup
