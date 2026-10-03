## 1. Allocation and delivery safety

- [x] 1.1 Allocate fresh run mounts and collision-free branches; retain recorded continuation and recovery ownership.
- [x] 1.2 Block new active OpenSpec directories before staging and external absolute symlinks before commit.
- [x] 1.3 Preserve overlay exclusions across provider switches without widening cleanup authority.

## 2. Revision and addendum identity

- [x] 2.1 Require durable delivery for revision admission and preserve full addendum claims on a fresh retry.
- [x] 2.2 Derive stable readable Core-compatible change IDs and make undelivered revision briefings truthful.

## 3. Verification and documentation

- [x] 3.1 Add regression coverage using real Git for dirty relaunches, valid continuations, planning residue and external links.
- [x] 3.2 Run affected lifecycle/loop/execution suites, architecture checks, typecheck and OpenSpec validation.
- [x] 3.3 Update the narrow delivery guide and prepare the completed change for archival before committing.

Validation: root/CLI/bridge/runner/client typechecks passed; the module/Git/routing suite passed 4,466 tests (57 optional tests skipped). After the final committed-symlink guard and provider-switch refinement, 430 focused Git/overlay/router/settlement tests passed. Regression fixtures use real Git and simulated agents; no third-party PR or live provider was modified.
Build, installed-package smoke checks and paired Core contract 5.1 compatibility also passed.
