# Spec Delta

## MODIFIED Requirements

### Requirement: Job status panel renders for running jobs

The Job Detail page SHALL render compact shared run chrome for running, completed, and failed jobs, showing status, elapsed time, activity/phase, supported actions, and pipeline chips. Status presentation SHALL update on terminal transitions. The metric grid and runtime Details SHALL live in bounded detail content rather than expanding the header inline; diagnosed failures SHALL place this content in Failure reasons.

#### Scenario: Running job shows status panel

- **WHEN** the user opens a job whose `status === 'running'` and that has no answerable pending question
- **THEN** the compact header renders running status, ticking elapsed time, current activity/phase and supported actions, with one pipeline chip row when phases exist
- **AND** live metrics remain accessible through bounded Details in the Log view without a Failure reasons tab

#### Scenario: Status transition refreshes the panel

- **WHEN** a running job receives a terminal status update over the WebSocket (`completed`, `failed`, `canceled`, `zombie_terminated`)
- **THEN** the header status presentation updates without remounting and the user's Details expand/collapse preference is preserved
- **AND** a failed/canceled run with a diagnosis exposes Failure reasons according to the run-detail navigation selection rules, including the answerable-pending-question visibility exception
