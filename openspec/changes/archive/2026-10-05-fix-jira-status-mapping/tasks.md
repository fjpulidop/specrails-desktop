## 1. Status identity

- [x] 1.1 Add regressions and fix explicit outbound status identity and truthful completion.
- [x] 1.2 Honor all configured inbound mappings and test deterministic ambiguity handling.

## 2. Recovery and diagnostics

- [x] 2.1 Retain superseded failed transition history, guard stale retry/drain, and test issue isolation and independent operations.
- [x] 2.2 Add issue/target context to outbox responses and pass live status IDs into the resolver.
- [x] 2.3 Refresh actionable UI counts safely across projects and show issue-specific errors and discovery retry with translations.

## 3. Verification and delivery

- [x] 3.1 Run affected server/client suites, typecheck and applicable architecture checks.
- [x] 3.2 Update the narrow integration guide, review the patch, validate and archive the change, and prepare its PR.
