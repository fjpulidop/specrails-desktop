# Spec Delta

## Purpose

Let people diagnose and inspect individual job runs through compact, accessible navigation shared by the routed Job Detail page and mission modal.

## ADDED Requirements

### Requirement: Failure navigation is conditional and initially selected
The Job Detail page and modal SHALL show Failure reasons and Log tabs when a failed or canceled job has a failure diagnosis. Failure reasons SHALL initially be selected. An answerable pending question SHALL also make Failure reasons available, even without a diagnosis; otherwise only Log SHALL be available. Failure reasons SHALL never be an empty or disabled control. No separate cause summary SHALL appear above these tabs.

#### Scenario: Diagnosed failure or cancellation opens
- **WHEN** either surface opens a failed or canceled job with a diagnosis
- **THEN** Failure reasons is selected next to Log and contains the diagnosis cause and available remedies
- **AND** neither diagnosis nor a separate cause summary appears above the tabs

#### Scenario: Other jobs open directly on Log
- **WHEN** either surface opens a queued, running, completed, skipped, or zombie-terminated job, or a failed/canceled job without a diagnosis, and there is no answerable pending question
- **THEN** only Log is available and selected, even if a non-failure job carries a stale diagnosis

#### Scenario: Both surfaces agree
- **WHEN** the same diagnosed failed job is opened on the page and in the modal
- **THEN** the tab structure, diagnosis, and Details content are equivalent, with only surface chrome and already-supported actions differing

### Requirement: Failure information cannot displace navigation
Failure reasons SHALL contain the existing cause and remedies when an eligible failure diagnosis exists, and the Details disclosure inside a bounded internally scrollable panel. Expanding Details SHALL retain its real metrics, modified files, and runtime continuation content while leaving navigation reachable without scrolling the page. Diagnosis wording and remedy behavior SHALL remain unchanged.

#### Scenario: Expand large Details content
- **WHEN** the user expands Details with long modified-file lists and runtime evidence
- **THEN** the panel scrolls within the available run-detail height and the top-level navigation remains outside that scroll region
- **AND** the same metrics and continuation controls remain accessible

### Requirement: Log offers graph and detail navigation
Log SHALL offer Execution graph and Log detail sub-sections for loop jobs, each occupying the remaining content height and reachable in one click from Log. Non-loop jobs SHALL show Log detail alone with no graph control or empty graph panel. Loading, empty, error, and retained-tail indications SHALL remain accurate within Log.

#### Scenario: Loop evidence views
- **WHEN** the user selects either Log sub-section on a loop job
- **THEN** that section uses the remaining height with its own scrolling and the other section remains one click away

#### Scenario: Non-loop job
- **WHEN** a non-loop job opens with an old stored graph preference
- **THEN** Log detail is shown and no Execution graph control or empty graph appears

#### Scenario: Incomplete or absent evidence
- **WHEN** loading, empty, failed-loading, or retained-tail conditions apply
- **THEN** Log preserves the existing applicable notices and states without displaying a blank Failure reasons panel

### Requirement: View preferences preserve surface independence
The Log sub-section and Details open state SHALL be remembered independently for page and modal visits. The top-level selection SHALL be initialized from diagnosis eligibility on each visit. Unavailable, malformed, or unsupported stored preferences SHALL not prevent inspection. Graph exploration state and log scroll position SHALL survive switching sections during a visit.

#### Scenario: Revisit each surface
- **WHEN** a user chooses Log detail on the page, Execution graph in the modal, and different Details states, then revisits each surface
- **THEN** each surface restores its own sub-section and Details state
- **AND** a diagnosed failed job still initially selects Failure reasons

#### Scenario: Invalid preferences
- **WHEN** browser storage is unavailable or contains malformed or unknown selections
- **THEN** the view uses safe defaults and remains usable with session-local choices

#### Scenario: Explore and return
- **WHEN** the user expands a graph step and pauses log following at an earlier scroll position, switches away, and returns
- **THEN** the graph exploration choices and paused log scroll position are preserved

### Requirement: Live diagnosis respects explicit user selection
When a displayed job gains an eligible failure diagnosis, the view SHALL select that tab once unless the user explicitly chose Log during the visit. Automatic selection SHALL not move keyboard focus. When neither diagnosis eligibility nor an answerable pending question remains, an active Failure reasons view SHALL return to Log. A different job SHALL receive fresh transient navigation state.

#### Scenario: Failure arrives asynchronously
- **WHEN** a running job fails and its diagnosis arrives after the status update, without an explicit Log choice
- **THEN** Failure reasons appears and becomes selected once, without moving focus

#### Scenario: User chose Log
- **WHEN** the user explicitly chooses Log before diagnosis arrives or chooses it after the failure
- **THEN** subsequent failure/diagnosis updates do not override that choice or move focus

#### Scenario: Eligibility disappears or job changes
- **WHEN** both diagnosis and pending-question eligibility are lost, or another job is displayed in the same surface
- **THEN** no unavailable tab remains selected and transient choices do not leak to the other job

### Requirement: Remedies reveal evidence before navigating to it
The diagnosis open-logs remedy SHALL select Log and Execution graph for loop jobs, or Log detail for non-loop jobs, before locating the failure. It SHALL target the current surface and retain the existing not-found feedback and reduced-motion behavior. Navigation SHALL preserve existing supported retry, resume, and edit-spec actions and their busy/disabled states.

#### Scenario: Loop failure remedy
- **WHEN** the user activates open logs from Failure reasons
- **THEN** Log and Execution graph become visible before the last failed/stalled step is brought into view
- **AND** a second open page or modal cannot receive that navigation

#### Scenario: Plain or missing evidence
- **WHEN** the remedy targets a non-loop job or no failed step exists
- **THEN** Log detail or the existing visible evidence fallback is revealed, and existing not-found feedback is used only if no target exists

### Requirement: Pending questions reveal the answer form
Activating the question-pending affordance SHALL select Failure reasons, open Details, and reveal the existing answer field and answer/resume behavior. The answer draft and action error behavior SHALL survive ordinary panel navigation.

#### Scenario: Pending question without a diagnosis
- **WHEN** an answerable pending question exists on a job with no eligible failure diagnosis
- **THEN** Failure reasons is available with Details/question content and no fabricated diagnosis
- **AND** activating the question-pending affordance selects it and opens Details regardless of job status

#### Scenario: Question settles without diagnosis
- **WHEN** the question is answered and no eligible diagnosis or answerable pending question remains
- **THEN** Failure reasons disappears and the view selects Log without moving focus
- **AND** existing metrics and continuation Details remain accessible there

#### Scenario: Pending question navigation
- **WHEN** a run has an answerable pending question and the user activates its header affordance
- **THEN** Failure reasons is selected, Details is expanded, and the answer field is visible
- **AND** an empty answer remains disabled and submitting a valid answer uses the existing continuation action

### Requirement: Both navigation levels are keyboard accessible
Both levels SHALL expose named tablist, tab, and tabpanel roles with selected state, linked tab/panel identifiers, and roving focus. Left/Right arrows SHALL select and focus the adjacent available tab with wrapping; Home/End SHALL select the first/last. Switching tabs SHALL retain focus on the selected tab, except explicit evidence/question navigation actions.

#### Scenario: Keyboard selection
- **WHEN** the user navigates either tablist using Left/Right, Home, or End
- **THEN** selection, aria-selected, tab order, and panel relationships update together and focus remains on the selected tab

#### Scenario: Concurrent surfaces
- **WHEN** the page and modal are mounted at the same time
- **THEN** their tab/panel identifiers are distinct and hidden panels are unavailable to keyboard and accessibility navigation
