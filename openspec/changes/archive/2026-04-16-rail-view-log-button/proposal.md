## Why

When a rail is running, the user has no quick way to jump to its live log — they must navigate to the jobs list and find the right entry. A direct "View Log" button on the rail removes this friction and keeps the user in context.

## What Changes

- Add a "View Log" icon button to `RailControls.tsx` that appears only when a rail is actively running
- Button navigates to `/jobs/<jobId>` (same behavior as clicking a job in RecentJobs)
- Button disappears when the rail stops, completes, or fails
- Button is styled with Dracula cyan (the established "running" color) with a subtle glow effect

## Capabilities

### New Capabilities
- `rail-view-log-button`: Icon button on the rail controls bar that links to the active job log while the rail is running

### Modified Capabilities

## Impact

- `client/src/features/rails/components/RailControls.tsx` — add button, read `railJob?.jobId` and `railJob?.status`
- No API changes, no new routes, no server changes
