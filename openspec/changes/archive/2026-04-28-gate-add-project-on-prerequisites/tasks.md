## 1. Server: enrich prerequisites response

- [x] 1.1 In `server/setup-prerequisites.ts`, add a `minVersion: string` field to each definition (Node `18.0.0`, npm `9.0.0`, npx omitted/`undefined`, Git `2.20.0`)
- [x] 1.2 Add a small `compareVersions(a: string, b: string): number` helper (or use an existing util / `semver` if already a dep) supporting `major.minor.patch` plus `vX.Y.Z` and `git version X.Y.Z` prefixes
- [x] 1.3 Compute `meetsMinimum: boolean` per record: `installed && parsedVersion >= minVersion`. When `minVersion` is undefined, `meetsMinimum` mirrors `installed`
- [x] 1.4 Add `platform: 'darwin' | 'win32' | 'linux'` at the response root (derived from `process.platform`)
- [x] 1.5 Update `SetupPrerequisitesStatus` and `SetupPrerequisite` interfaces; export `MIN_VERSIONS` constant for reuse if helpful
- [x] 1.6 In `server/setup-prerequisites.test.ts`, add cases covering: version parsing for `node v18.0.0`, `npm 10.2.4`, `git version 2.42.1`; `meetsMinimum=false` for an old version; `platform` field present
- [x] 1.7 Run `npx vitest run server/setup-prerequisites.test.ts` and confirm green

## 2. Client: shared hook + components

- [x] 2.1 Create `client/src/features/projects/hooks/usePrerequisites.ts` exporting `usePrerequisites()` returning `{ status, isLoading, error, recheck }`
- [x] 2.2 Implement a module-level cache: `{ data, fetchedAt, inFlight }`; cache window 60_000 ms; `recheck()` invalidates and refetches
- [x] 2.3 Subscribe to `window.addEventListener('focus', recheck)` while at least one consumer is mounted; clean up on last unmount
- [x] 2.4 Use `AbortController` to cancel in-flight fetches on unmount
- [x] 2.5 Add `client/src/features/projects/hooks/__tests__/usePrerequisites.test.tsx` covering: initial fetch, cache hit on quick re-render, recheck after `window.focus`, recheck button bypass, abort on unmount, error path
- [x] 2.6 Create `client/src/features/projects/components/PrerequisitesPanel.tsx` accepting `{ status, isLoading, error, onMoreInfo? }` props
- [x] 2.7 Render the "All required tools detected" success line when `status.ok && !error`
- [x] 2.8 Render per-tool rows for missing/below-min tools with red-cross icon and the version-detail line; render present tools with a green-check icon and version
- [x] 2.9 Render the "More info" affordance only when `!status.ok`; calls `onMoreInfo` from props
- [x] 2.10 Add `client/src/features/projects/components/__tests__/PrerequisitesPanel.test.tsx` covering all four panel states (loading, ok, partial-missing, all-missing) plus error
- [x] 2.11 Create `client/src/features/projects/components/InstallInstructionsModal.tsx` with `{ open, onClose, status, onRecheck }` props
- [x] 2.12 Render the host-OS section (driven by `status.platform`) by default; macOS shows brew + official, Windows shows winget + official + restart hint, Linux shows apt/dnf + official
- [x] 2.13 Each command renders inside a code block with a `CopyButton` child component that calls `navigator.clipboard.writeText` (fallback `document.execCommand('copy')`) and shows a 1500 ms "Copied" affordance
- [x] 2.14 Wrap non-host platforms in a Radix `<Collapsible>` or native `<details>` "Show other platforms" disclosure (closed by default)
- [x] 2.15 Add an "I installed it, recheck" button calling `onRecheck`
- [x] 2.16 Add `client/src/features/projects/components/__tests__/InstallInstructionsModal.test.tsx` covering: shows host OS by default, hides others, copy-to-clipboard fires the API, recheck button triggers prop, fallback path when `navigator.clipboard` is undefined

## 3. Wire AddProjectDialog

- [x] 3.1 Read `client/src/features/projects/components/AddProjectDialog.tsx` end to end
- [x] 3.2 Import and call `usePrerequisites()` at the top of the component
- [x] 3.3 Render `<PrerequisitesPanel />` near the top of the dialog body, above the path/name fields
- [x] 3.4 Track an `installModalOpen` local state; pass `onMoreInfo={() => setInstallModalOpen(true)}` to the panel
- [x] 3.5 Render `<InstallInstructionsModal open={installModalOpen} onClose={...} status={status} onRecheck={recheck} />`
- [x] 3.6 Compute `submitDisabled = !status?.ok || isLoading || existingFormErrors`; pass to the "Add project" button
- [x] 3.7 Wrap the disabled button in a `<Tooltip>` listing missing tools when `submitDisabled` is due to prereqs (e.g. "Git is required to add a project"); existing form-error tooltips remain
- [x] 3.8 If the prereq fetch errors (`error != null`), do NOT block the submit — render a small notice and let the user proceed; server install guard remains the source of truth
- [x] 3.9 Add `client/src/features/projects/components/__tests__/AddProjectDialog.test.tsx` (or extend if it exists) covering: panel shows on open, button disabled when prereqs missing, button enabled when prereqs ok, more-info opens modal, error path leaves submit enabled

## 4. Refactor SetupWizard onto the shared hook

- [x] 4.1 In `client/src/components/SetupWizard.tsx`, replace the inline `refreshSetupPrerequisites` callback (around line 761), the `setupPrerequisites` state, and the inline panel render (around line 195) with `usePrerequisites()` + `<PrerequisitesPanel />`
- [x] 4.2 Remove the now-unused `isSetupPrerequisitesStatus` type-guard if no other caller needs it (verify with grep before deleting)
- [x] 4.3 Keep the existing `installDisabled` gate but source `prerequisites.ok` from the hook
- [x] 4.4 Run existing `client/src/components/__tests__/SetupWizard.test.tsx` and adapt mocks: replace `vi.mock('global').fetch.../api/hub/setup-prerequisites` with a `vi.mock('../../hooks/usePrerequisites', ...)`
- [x] 4.5 Confirm the wizard's install-step screenshot/behaviour is unchanged (visual parity check via test selectors)

## 5. Documentation

- [x] 5.1 Update `CLAUDE.md` setup-wizard section to mention that prereq gating now also lives at `AddProjectDialog`
- [x] 5.2 If `docs/engineering/architecture.md` or `docs/general/getting-started.md` references the prereq flow, update to reflect the new location

## 6. Verification

- [x] 6.1 Run `npm run typecheck` and confirm zero errors (server + client)
- [x] 6.2 Run `npm test` (root) and `cd client && npx vitest run` — all green
- [x] 6.3 Run `npm run test:coverage` (root) and `cd client && npm run test:coverage` — server gates 80/80/80/70 hold; client gate 70 holds
- [ ] 6.4 Smoke test in `npm run dev` (USER VERIFICATION REQUIRED — automated apply cannot drive the browser):
  - With all tools installed → panel shows "All required tools detected", no "More info" link, button enabled
  - Temporarily rename `git` on PATH (or stub the endpoint) → button disables, tooltip names Git, "More info" appears, modal shows host-OS commands by default
  - Click copy button → clipboard receives the command, "Copied" flash visible
  - Open `<details>` "Show other platforms" → other OS sections render
  - Restore `git`, click "I installed it, recheck" → status flips to ok, button enables
  - Trigger `window.focus` (Cmd+Tab away and back) with the dialog open → fetch fires, status updates
- [ ] 6.5 Smoke test `SetupWizard` install step (USER VERIFICATION REQUIRED): prereq panel renders identically, gate still works

## 7. Validation

- [x] 7.1 Run `openspec validate gate-add-project-on-prerequisites --strict` and resolve any findings
- [x] 7.2 Self-review the diff for stray `console.log`, dead imports, and obsolete prereq fetch code in `SetupWizard.tsx`
