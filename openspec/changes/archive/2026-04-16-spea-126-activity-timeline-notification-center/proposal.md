## Why

The hub currently provides no way to track what happened in a project over time. Users must dig into individual job detail pages to understand what ran, when, and with what outcome. A centralized activity timeline and notification system gives users instant situational awareness across job lifecycle events and phase transitions without navigating away from their current view.

## What Changes

- New REST endpoint `GET /api/projects/:projectId/activity` returning a deduplicated, chronological feed of job and phase events
- New `ActivityFeedPage` component at route `/activity` within `ProjectLayout`, showing a scrollable timeline
- New `NotificationCenter` component in `ProjectNavbar`: bell icon with unread-count badge, dropdown of recent events, mark-as-read persisted to `localStorage` per project
- `useActivity` hook that fetches the activity feed and subscribes to WebSocket messages (`phase`, `queue`, `event`) to append new items in real-time
- Server-side tests for the new activity endpoint

## Capabilities

### New Capabilities

- `project-activity-feed`: REST endpoint and data model for querying recent project events (job lifecycle + phase transitions) with cursor pagination

### Modified Capabilities

<!-- No existing spec-level requirements change -->

## Impact

- **server/project-router.ts** — new `/activity` route
- **server/db.ts** — new `getProjectActivity` query function joining `jobs` + `events`
- **client/src/features/analytics/hooks/useActivity.ts** — new hook (fetch + WS subscription)
- **client/src/components/NotificationCenter.tsx** — new component added to `ProjectNavbar`
- **client/src/features/analytics/pages/ActivityFeedPage.tsx** — new page added to `ProjectLayout` routing
- **client/src/App.tsx** — new `/activity` route in per-project routes
- **client/src/components/ProjectNavbar.tsx** — `NotificationCenter` integration
- **server/project-router.test.ts** — new endpoint tests
