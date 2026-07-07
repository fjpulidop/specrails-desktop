# rail-view-log-button Specification

## Purpose
Define the running-rail View Log button visibility, navigation, and styling behavior.

## Requirements

### Requirement: View Log button appears when rail is running
The RailControls component SHALL display a "View Log" icon button when the rail's active job status is `running`. The button SHALL be positioned to the left of the Implement/Batch toggle. The button SHALL not be rendered when no job is active or when job status is not `running`.

#### Scenario: Button visible during running state
- **WHEN** a rail has `railJob.status === 'running'`
- **THEN** the View Log button is rendered and visible in the rail controls bar

#### Scenario: Button hidden when rail is idle
- **WHEN** `railJob` is null or `railJob.status` is not `'running'`
- **THEN** the View Log button is not rendered

#### Scenario: Button hidden after rail completes
- **WHEN** a running rail transitions to `completed`, `failed`, or `stopped`
- **THEN** the View Log button disappears from the controls bar

### Requirement: View Log button navigates to job detail page
The View Log button SHALL navigate the user to `/jobs/<jobId>` in the same browser tab when clicked, rendering the same view as clicking a job entry in the RecentJobs list.

#### Scenario: Click navigates to job detail
- **WHEN** the user clicks the View Log button while a rail is running
- **THEN** the app navigates to `/jobs/${railJob.jobId}` in the current tab

### Requirement: View Log button matches Dracula running-state aesthetic
The View Log button SHALL use dracula-cyan (`#8be9fd`) as its icon color, consistent with the running-state color convention used elsewhere in the app. It SHALL display a subtle cyan glow on hover. Its size and padding SHALL be consistent with the adjacent Play/Stop button.

#### Scenario: Button color matches running state
- **WHEN** the View Log button is rendered
- **THEN** its icon color is dracula-cyan

#### Scenario: Hover produces glow effect
- **WHEN** the user hovers over the View Log button
- **THEN** a subtle cyan box-shadow glow appears
