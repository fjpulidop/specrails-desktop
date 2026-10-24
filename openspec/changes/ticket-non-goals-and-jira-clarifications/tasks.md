## 1. Non-goals

- [x] 1.1 Pure `specs/domain/non-goals.ts` (validation, bounds, section extraction, rendering) with its architecture rule
- [x] 1.2 Ticket `nonGoals` (schema 1.5, additive); create/PATCH/from-draft validation; never a Jira write-back
- [x] 1.3 Quick prompt + parser move `## Out of Scope` into the field; rewrite keeps existing non-goals; Explore `spec-draft` schema, parser and merge
- [x] 1.4 Loop spec lookup and Freestyle prompt append the non-goals
- [x] 1.5 Client: ticket modal section, Explore draft panel, edit/commit paths; locales ×8

## 2. Jira clarifications

- [x] 2.1 Project setting `jiraPostClarifications` (domain, SQLite, HTTP, settings UI gated on `architectClarifications`)
- [x] 2.2 Run-record parser (`clarifications.json`, engine-2 fallback); invocation-end observer; composition publisher
- [x] 2.3 Outbox comment per linked ticket (idempotent per run/record); migration 77 thread table
- [x] 2.4 Reply import as `clarification` addenda during the poll; 14-day window

## 3. Verification

- [x] 3.1 Server tests: domain, routes (success and 400), generation, draft parser/merge, Freestyle prompt, Jira publish/idempotency/import/failure, settings, observer
- [x] 3.2 Client tests: modal section and save, settings switch
- [x] 3.3 Docs: existing-project anchoring, spec addenda, API reference, configuration, user guide ×8
