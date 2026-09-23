## 1. Backend — Activity Query

- [x] 1.1 Add `getProjectActivity(db, opts: { limit: number; before?: string })` function to `server/db.ts` that queries `jobs` table and maps rows to `ActivityItem` objects
- [x] 1.2 Add `ActivityItem` interface to `server/types.ts` with fields: `id`, `type`, `jobId`, `jobCommand`, `timestamp`, `summary`, `costUsd`

## 2. Backend — Activity Endpoint

- [x] 2.1 Add `GET /:projectId/activity` route to `server/project-router.ts` using `ctx(req).projectCtx`; parse and validate `limit` (default 50, max 100) and `before` query params
- [x] 2.2 Return 200 with the `ActivityItem[]` array from `getProjectActivity`

## 3. Backend — Tests

- [x] 3.1 Add tests for `GET /activity` endpoint in `server/project-router.test.ts`: empty project returns `[]`, jobs appear as correct types, pagination with `limit` and `before`, limit capped at 100

## 4. Frontend — useActivity Hook

- [x] 4.1 Create `client/src/features/analytics/hooks/useActivity.ts`: fetches `GET ${getApiBase()}/activity` on mount and on `activeProjectId` change; returns `{ items, loadMore, loading }`
- [x] 4.2 Subscribe to WS messages (`phase`, `queue`) in `useActivity` to prepend new synthesized `ActivityItem` objects; filter by `activeProjectId` via ref; deduplicate by composite key `type+jobId`
- [x] 4.3 Implement `loadMore()` using `before` cursor from the oldest item in current list; append results to existing list

## 5. Frontend — ActivityFeedPage

- [x] 5.1 Create `client/src/features/analytics/pages/ActivityFeedPage.tsx`: renders a scrollable list of activity items using `useActivity`; shows icon per type, truncated command, relative timestamp, type label
- [x] 5.2 Add empty state when `items.length === 0` and not loading
- [x] 5.3 Add "Load more" trigger at bottom of list (button or scroll sentinel) that calls `loadMore()`
- [x] 5.4 Add `/activity` route in `client/src/App.tsx` under the per-project routes, rendering `<ActivityFeedPage />`

## 6. Frontend — NotificationCenter

- [x] 6.1 Create `client/src/components/NotificationCenter.tsx`: bell icon button with badge showing unread count; click toggles dropdown; dropdown lists last 10 items
- [x] 6.2 Implement read-state logic: read `localStorage` key `specrails:notifications:<projectId>` on mount; unread count = items with `timestamp > lastReadAt`
- [x] 6.3 On dropdown open: set `lastReadAt` to current time, persist to `localStorage`, reset unread count to 0
- [x] 6.4 Subscribe to WS messages in `NotificationCenter` (or reuse `useActivity`) to receive real-time items and update unread badge
- [x] 6.5 Add `<NotificationCenter />` to `client/src/components/ProjectNavbar.tsx` in the nav action area

## 7. Integration & Cleanup

- [x] 7.1 Add "Activity" nav link to `ProjectNavbar` pointing to `/activity` route
- [x] 7.2 Run `npm run typecheck` and fix any TypeScript errors
- [x] 7.3 Run `npm test` and confirm all existing and new tests pass
