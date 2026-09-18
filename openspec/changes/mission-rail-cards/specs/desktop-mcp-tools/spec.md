## ADDED Requirements

### Requirement: Runtime run controls are exposed to the agent
The jobs facade SHALL expose runtime-run reads (runs, evidence) at the read tier and runtime controls (resume, recover, approve, settle, dismiss) at their declared tiers, so the agent can explain a failure and act on user confirmation.

#### Scenario: Read recovery state
- **WHEN** the agent calls the runtime runs action for a job
- **THEN** it receives the run status, current step, `canResume`, `recoverableSteps` and `pendingApproval`

#### Scenario: Resume on confirmation
- **WHEN** the agent calls resume for a resumable run with the AI-spawn tier enabled
- **THEN** the runtime-controls route is invoked and the result is returned; with the tier disabled the refusal names the tier

### Requirement: Rails report availability
The rails list action SHALL include per-rail availability (`free`, `busy`, `pending_decision`, `on_review`) so proposals can target a usable rail.

#### Scenario: Prefill picks a free rail
- **WHEN** the agent lists rails before proposing
- **THEN** each rail carries its availability and current specs
