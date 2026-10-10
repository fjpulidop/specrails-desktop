## 1. Dependency input fingerprint

- [x] 1.1 In `server/worktree-node-modules.ts`, add `dependencyInputs(checkoutRoot, pkgRel)`. It returns `{ lockfile: { name, digest } | null, manifestDigest }`.
  - It finds the nearest lockfile by walking up to the git top level of `checkoutRoot`, checking `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json` and `bun.lock` in that order.
  - It digests the canonical JSON (sorted keys) of the four dependency fields.
  - It never throws. Unreadable inputs return a sentinel that compares as different.
- [x] 1.2 Unit tests in `worktree-node-modules.test.ts` covering:
  - a lockfile at the package directory, at a parent directory, and at the git top level of a subdirectory project;
  - a lockfile present on only one side;
  - manifest dependency fields reordered (equal), and a changed range (different);
  - a changed `scripts` field only (equal).

## 2. Guard in the linker

- [x] 2.1 In `linkNodeModulesIntoWorktree`, compare `dependencyInputs(baseRepo, pkgRel)` with the worktree side before preparing each link. When they differ:
  - skip the directory;
  - push the warning `<rel>: <lockfile name|package.json> differs from the base checkout; dependencies will be installed in the worktree`;
  - create nothing.
- [x] 2.2 Leave the authentication of existing links (`authenticateWarmNodeModulesLinks`) unchanged, so resumed runs keep their authenticated links.
- [x] 2.3 Tests covering:
  - a stale base lockfile, where the link is skipped, `linked` and `authenticated` are empty for that directory, the warning text is exact, and the base checkout is untouched;
  - matching inputs, where the link is made as before;
  - a monorepo subdirectory project with a root `yarn.lock` that differs, where the link is skipped;
  - a resumed run with an existing authenticated link and a changed base lockfile, where the link stays authenticated.

## 3. Launch integration and docs

- [x] 3.1 Add or extend a `rail-isolated-launch` test so that a freshness warning reaches `notifyOverlayDegraded` and the launch continues.
- [x] 3.2 Document the guard and the cold fallback, next to the warm-reuse notes, in the relevant internals guide (delivery or worktree docs). Mention that Desktop never touches the user's checkout. Update the source map if files are added.
- [x] 3.3 Run `npm run typecheck`, `npx vitest run server/worktree-node-modules.test.ts server/modules/delivery` and the affected launch suites.
