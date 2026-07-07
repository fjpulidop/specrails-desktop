# project-activity-feed Specification

## Purpose
Define project activity feed API, UI, notification, and realtime update behavior.

## Requirements

### Requirement: Activity feed endpoint
The system SHALL expose `GET /api/projects/:projectId/activity` returning a JSON array of `ActivityItem` objects representing recent project events sorted by `timestamp` descending.

Each `ActivityItem` SHALL have: `id` (string, unique within response), `type` (one of `job_started`, `job_completed`, `job_failed`, `job_canceled`), `jobId` (string), `jobCommand` (string), `timestamp` (ISO 8601), `summary` (human-readable string), and `costUsd` (number | null, only for terminal job states).

The endpoint SHALL accept optional query params `limit` (integer 1–100, default 50) and `before` (ISO 8601 timestamp for cursor pagination).

#### Scenario: Returns recent jobs in descending order
- **WHEN** `GET /api/projects/:projectId/activity` is called with no params
- **THEN** response is 200 with a JSON array of activity items sorted by `timestamp` DESC, limited to 50

#### Scenario: Cursor pagination
- **WHEN** `GET /api/projects/:projectId/activity?before=<timestamp>` is called
- **THEN** only items with `timestamp` strictly before the cursor are returned

#### Scenario: Custom limit
- **WHEN** `GET /api/projects/:projectId/activity?limit=10` is called
- **THEN** at most 10 items are returned

#### Scenario: Limit capped at 100
- **WHEN** `GET /api/projects/:projectId/activity?limit=200` is called
- **THEN** at most 100 items are returned

#### Scenario: Running job appears as job_started
- **WHEN** a job with `status=running` exists and the activity endpoint is called
- **THEN** that job appears as an item with `type=job_started` and no `costUsd`

#### Scenario: Completed job appears as job_completed
- **WHEN** a job with `status=completed` exists
- **THEN** that job appears as an item with `type=job_completed` and `costUsd` reflecting `total_cost_usd`

#### Scenario: Failed job appears as job_failed
- **WHEN** a job with `status=failed` exists
- **THEN** that job appears as an item with `type=job_failed`

#### Scenario: Canceled job appears as job_canceled
- **WHEN** a job with `status=canceled` exists
- **THEN** that job appears as an item with `type=job_canceled`

#### Scenario: Unknown project returns 404
- **WHEN** `GET /api/projects/nonexistent/activity` is called
- **THEN** response is 404

### Requirement: Activity feed UI page
The system SHALL render an `ActivityFeedPage` at route `/activity` within `ProjectLayout` showing all activity items in a scrollable chronological list.

Each row SHALL display: a status icon, the job command (truncated), a relative timestamp (e.g., "2 minutes ago"), and an event type label.

The page SHALL load more items when the user scrolls to the bottom (cursor pagination via `before`).

#### Scenario: Activity page renders feed
- **WHEN** user navigates to `/activity` for a project
- **THEN** a list of activity items is displayed, most recent first

#### Scenario: Empty state
- **WHEN** the project has no jobs
- **THEN** the page shows a message indicating no activity yet

#### Scenario: Load more on scroll
- **WHEN** user reaches the bottom of the list and more items exist
- **THEN** older items are appended to the list

### Requirement: Notification Center
The system SHALL render a `NotificationCenter` component in `ProjectNavbar` as a bell icon with an unread-count badge.

Clicking the bell SHALL open a dropdown listing the most recent 10 activity items for the active project.

Clicking any item or an explicit "Mark all read" action SHALL mark all current items as read, clearing the badge. Read state SHALL be persisted to `localStorage` under the key `specrails:notifications:<projectId>`.

The unread count SHALL reflect activity items received after the last-read timestamp stored in `localStorage`.

The component SHALL update in real-time by subscribing to WebSocket `phase` and `queue` messages and prepending synthesized activity items to its local list.

#### Scenario: Unread badge appears after new job
- **WHEN** a new job starts (via WebSocket `queue` message) and the user has not opened the notification dropdown
- **THEN** the bell badge shows a positive unread count

#### Scenario: Badge clears on open
- **WHEN** user clicks the bell icon to open the dropdown
- **THEN** all items are marked as read, badge count resets to 0, and the last-read timestamp is persisted to localStorage

#### Scenario: Read state persists across page reload
- **WHEN** user has previously opened the notification dropdown
- **AND** the page is reloaded
- **THEN** items older than the stored last-read timestamp do not show as unread

#### Scenario: Real-time update via WebSocket
- **WHEN** a `phase` WebSocket message arrives for the active project
- **THEN** a new activity item is prepended to the notification dropdown list

#### Scenario: No badge when no unread items
- **WHEN** all activity items are older than the last-read timestamp
- **THEN** the bell badge is hidden or shows 0
