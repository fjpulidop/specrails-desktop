## 1. Environment recovery

- [x] 1.1 Add non-mutating bounded login-shell reading with account-shell fallback and regression tests.
- [x] 1.2 Scope recovered values and expiring lookup caches to the project DB; test refresh, removed names, explicit values and project isolation.

## 2. Runtime propagation

- [x] 2.1 Apply the project environment overlay to retained runtime controls and verify scope and secret-free persistence.
- [x] 2.2 Exercise parent-project credentials through real verification subprocesses for multiple repositories and role execution.

## 3. Validation and documentation

- [x] 3.1 Update the narrow environment guide and runtime module documentation; review dependency boundaries.
- [x] 3.2 Run affected suites, TypeScript and architecture checks, published Core compatibility/pairing and relevant build checks; validate and archive the change.
