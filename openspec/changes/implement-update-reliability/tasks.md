## 1. Shared Core execution

- [x] 1.1 Implement versioned execution context, durable phase journal and candidate-bound verification receipts with transition tests.
- [x] 1.2 Correct common confidence/archive gates, retry states, host ownership and preview/apply validation.
- [x] 1.3 Apply shared lifecycle to Codex, Gemini and Kimi; fix routing, skill provisioning and continuation contracts with provider fixtures.

## 2. CLI and Desktop integration

- [x] 2.1 Connect the pipeline CLI and publish an accurate Core 5 integration contract.
- [x] 2.2 Export frozen Desktop execution context and validate receipt reuse without dropping acceptance review.
- [x] 2.3 Make Core CLI update metadata truthful, prevent unintended downgrade and rollback failed updates while preserving custom artifacts.

## 3. Core package updates in Desktop

- [x] 3.1 Resolve and persist the actual compatible Core runtime across update, restart, offline operation and external installs.
- [x] 3.2 Adapt setup/framework operations to Core 5 and remove obsolete enrichment requirements for that version.
- [x] 3.3 Expose accurate runtime/framework/latest version state and invalidate stale caches after verified updates.

## 4. Validation and documentation

- [x] 4.1 Run Core regression tests, typecheck and packaged CLI/provider fixtures.
- [x] 4.2 Run Desktop server/client regression tests, typecheck, compatibility and build checks.
- [x] 4.3 Document lifecycle, update provenance, recovery behavior and remaining provider validation limits.
