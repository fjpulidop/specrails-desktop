## ADDED Requirements

### Requirement: Warm links require matching dependency inputs

Before preparing a warm `node_modules` link for a package directory, Desktop SHALL compare the dependency inputs of the base checkout with those of the worktree. The inputs are:

- the content digest of the nearest lockfile found by walking from the package directory up to the repository's git top level, using the first match of `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json` or `bun.lock`;
- the canonical `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` of the package directory's `package.json`.

Desktop SHALL link only when both inputs are equal, or when both are absent, between the base checkout and the worktree.

#### Scenario: Base checkout on an older branch

- **WHEN** the base checkout's root `yarn.lock` differs from the worktree's root `yarn.lock`, and the package directory is `apps/busuu-courses`
- **THEN** Desktop creates no `apps/busuu-courses/node_modules` in the worktree, adds no path to `linked` or `authenticated`, and includes a warning that names `apps/busuu-courses` and `yarn.lock`

#### Scenario: Same lockfile, different manifest

- **WHEN** the lockfiles are equal but the worktree's `package.json` declares a dependency range the base checkout's does not
- **THEN** Desktop skips that package directory with a warning naming `package.json`

#### Scenario: Inputs match

- **WHEN** the lockfile and the dependency fields are byte-equal in canonical form
- **THEN** Desktop prepares the warm link exactly as it does today

#### Scenario: No lockfile anywhere

- **WHEN** neither checkout has a lockfile up to the git top level and the dependency fields are equal
- **THEN** Desktop prepares the warm link

### Requirement: Skipped links fall back to a cold install in the worktree

When the guard skips a package directory, Desktop SHALL leave that directory without `node_modules`, so that the runtime's environment preparation installs it from the worktree's own lockfile. Desktop SHALL NOT run any install, checkout, pull or other write in the user's base checkout.

#### Scenario: No write to the base checkout

- **WHEN** a link is skipped for freshness
- **THEN** the base checkout's working tree, refs and `node_modules` are unchanged, and the worktree's package directory has no `node_modules` entry

### Requirement: Existing authenticated links are not revoked mid-run

The guard SHALL apply only when a link is being prepared. Links that a previous pass created for the same run, and that `authenticateWarmNodeModulesLinks` proves, SHALL remain authenticated and excluded from commits as they are today.

#### Scenario: Resumed launch with an existing link

- **WHEN** a resumed launch finds an authenticated warm link and the base checkout's lockfile has since changed
- **THEN** the link stays authenticated and excluded, and the resume does not fail
