---
id: backend-test-coverage
title: "Backend 100% Test Coverage — Tasks"
date: 2026-03-18
---

# Task Breakdown

## Task 1 [server] — Create hub-db.test.ts
**File:** `server/hub-db.test.ts`
Test all hub-db functions with :memory: SQLite.

## Task 2 [server] — Create setup-manager.test.ts
**File:** `server/setup-manager.test.ts`
Test checkpoint detection, process management, polling, abort.

## Task 3 [server] — Create project-registry.test.ts
**File:** `server/project-registry.test.ts`
Test context loading, project lifecycle, error handling.

## Task 4 [server] — Create hub-router.test.ts
**File:** `server/hub-router.test.ts`
Test all API endpoints with supertest.

## Task 5 [server] — Expand analytics.test.ts
**File:** `server/analytics.test.ts`
Add tests for percentiles, bonus metrics, multi-command scenarios.

## Task 6 [server] — Expand project-router.test.ts (new file: project-router-full.test.ts)
**File:** `server/project-router-full.test.ts`
Test all routes not covered by proposal-routes.test.ts.

## Task 7 [server] — Expand chat-manager.test.ts
**File:** `server/modules/conversations/runtime/chat-manager.test.ts`
Add edge case tests.

## Task 8 [server] — Expand queue-manager.test.ts
**File:** `server/modules/execution/runtime/queue-manager.test.ts`
Add error recovery and edge case tests.

## Task 9 [server] — Fix bugs found during testing
Fix any issues discovered during test writing.

## Task 10 [server] — Run full suite, ensure 100% pass
Run `npm test` and fix any failures.
