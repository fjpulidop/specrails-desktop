## ADDED Requirements

### Requirement: The packet opens with the reviewer's risk brief

When the active Core announces `reviewBrief: 1`, the platform SHALL harvest the reviewer's risk brief at settle into the delivery's durable settle evidence and SHALL render it as the first section of the review packet ("What to look at"), before the measured facts, in a fixed order: risks (high first), behaviour changes, invariants touched, untested paths, human checks. The brief SHALL be labelled as advisory AI output and SHALL NOT influence any decision.

#### Scenario: Run with a brief

- **WHEN** a delivery settles with a reviewer brief recorded by a Core that announces `reviewBrief: 1`
- **THEN** the packet SHALL open with "What to look at" listing the risks ordered high, medium, low with their file references

#### Scenario: Partial or malformed brief

- **WHEN** the brief misses sections or carries entries that break the contract
- **THEN** the packet SHALL show the valid entries, skip the invalid ones and state how many were skipped, and the harvest SHALL NOT fail

#### Scenario: Brief dropped

- **WHEN** Core dropped the brief after its repair turn or the record cannot be read
- **THEN** the packet SHALL show a note that the reviewer's brief could not be used

#### Scenario: No brief

- **WHEN** the active Core does not announce `reviewBrief: 1`, or the run recorded no brief
- **THEN** the settle evidence SHALL be unchanged and the packet SHALL render exactly as before, without the section

### Requirement: PR body and cards summarize the brief

The PR body composed at create-pr time SHALL carry a short block under its summary listing high and medium risks, untested paths and human checks when a brief exists, keeping the cost footer; delivery snapshots and mission cards SHALL carry a risk summary whose top risk the mission card and dashboard strip show as one line.

#### Scenario: PR with a brief

- **WHEN** a PR is created for a delivery whose evidence carries a brief with high or medium risks
- **THEN** the body SHALL contain a "What to look at" block under the summary and the cost footer SHALL remain last

#### Scenario: PR without a brief

- **WHEN** the delivery has no brief
- **THEN** the PR body SHALL be identical to the body composed before this change
