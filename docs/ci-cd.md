# CI and releases

Desktop distributes an npm package and native installers. Their publication workflows require successful `CI` for the **same commit**, from a `main` push in this repository. A passing pull request, another commit, a skipped run or an older successful attempt does not authorize publication. No repository protection setting is assumed by this check.

## Quality checks

| Workflow or command | What it checks |
| --- | --- |
| `CI` on pushes, pull requests and merge queues | Workflow syntax, secrets, TypeScript, server/client coverage, package contents and platform regressions |
| `npm run test:scripts` | Every `scripts/*.test.mjs` helper, including release admission, package integrity and Core dispatch handling |
| `npm run build` then `npm run check:package` | A real npm tarball, isolated production install with lifecycle scripts disabled, CLI help/version, MCP and required runtime resources |
| Windows x64 and ARM64 jobs | Native filesystem/process regressions, terminal/background containment, client tests, bundled Core and native browser/mission window fixtures |
| macOS native job | Native Rust tests and browser, popup, multiwindow and mission window fixtures |
| Paired Core engine | Real Core acceptance suites, discovered as `*-paired.test.ts` and time-balanced across runners by `scripts/paired-core-shards.mjs` (2 shards on Linux/macOS, 4 on Windows) |
| Native release builds | Packaged resources and installer validation; Windows additionally exercises the installed NSIS artifact |

The npm package check does not start a server or exercise native postinstall rebuilds. Native platform jobs and installed application smoke tests provide separate evidence. Defining a Windows or signing job is not evidence that it has passed: inspect the corresponding GitHub run before claiming platform or release acceptance.

Actions are pinned to commit SHAs. Downloaded actionlint and gitleaks binaries have fixed checksums verified before execution. Actionlint checks workflow structure, expressions and action inputs; its ShellCheck integration is disabled, so it does not claim complete shell-script analysis. Dependabot covers root/client/MCP npm dependencies, GitHub Actions and Cargo.

## Pipeline speed

The CI critical path is kept near the slowest ordinary job (~8 min) rather than one long serial suite. Add a paired suite by naming it `*-paired.test.ts`; it is assigned automatically, and `scripts/paired-core-shards.test.mjs` fails if any suite is unassigned, duplicated or has a stale timing weight. Refresh `WEIGHTS` from a CI JUnit artifact when suites grow.

Tag builds can only restore caches saved on `main`, so `Release Rust cache` compiles the release profile on `main` (on `src-tauri/**` changes, daily, or manually) under the `desktop-release-*` shared keys that `Desktop Release` restores without saving. A cache miss only costs time: the release still compiles from scratch. Windows ships only NSIS, which removes a second compression pass, smoke install and upload per architecture.

## Release flow

1. A successful main `CI` run triggers `Release`. It checks out that exact revision, skips superseded main revisions and lets release-please maintain the release pull request or tag. The credential-bearing job does not install dependencies or run builds.
2. `Publish npm` and the publishing mode of `Desktop Release` accept a stable `vX.Y.Z` tag only when it exactly matches `package.json` and the checked-out commit. Publication retries must select that existing tag; for `Desktop Release`, explicitly set `validation_only=false`. Prereleases and branch-based manual publication are rejected.
3. Both workflows wait for successful main CI for that exact SHA, with a bounded deadline. Failed or cancelled CI must be corrected or rerun successfully before retrying publication. This is an API check requiring `actions: read`, not an assumption about branch protection.
4. The npm packaging job builds and verifies a tarball with read-only repository permissions. It uploads that tarball and its integrity receipt. A separate publication job rechecks its identity and hashes and publishes those exact bytes with lifecycle scripts disabled and provenance enabled.
5. Native publication waits for every platform build. The mutable download channel is serialized, refuses older versions, and switches the verified manifest using an FTPS rename after all referenced files are uploaded. Server-managed `.htaccess` remains untouched. Previous binaries are retired only after the new manifest has been fetched and verified.

npm publication is serialized across versions and checks the current `latest` version before publishing. An already published version is skipped only if its registry integrity matches the verified tarball. A different payload fails rather than overwriting an immutable package. Concurrency alone cannot prevent an old retry from running after a newer release, which is why version guards are also required. [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Release admission uses the current run/attempt of the named CI workflow and the exact SHA, repository, branch and event. The metadata workflow consumes no artifacts from an untrusted pull request. [Workflow-run trust and event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs).

## Update channels

Desktop offers two update channels, chosen in **App settings ▸ Updates ▸ Update channel** and stored as the app setting `updateChannel` (`GET/PUT /api/settings`):

| Channel | Desktop updater manifest | Core (npm dist-tag) |
|---|---|---|
| `latest` (default) | `releases/latest/download/latest.json`, the newest release, written by `Desktop Release` | `latest` |
| `stable` | `releases/download/stable/latest.json`, the promoted release | `stable`; while Core publishes no `stable` dist-tag the check falls back to `latest` and reports `channelFallback: true` |

**Mechanism.** `stable` is a single moving GitHub **pre-release** tagged `stable`. Its assets are verbatim copies of the promoted version's `latest.json` and `manifest.json`, plus `stable.json` (`{ version, tag, sha, promotedAt }`). The copied `latest.json` still points at that version's signed installers, so promotion rebuilds and re-signs nothing, and the updater's signature check is unchanged. Because the pointer is a pre-release created with `--latest=false`, it never becomes the repository's "latest" release, so the `latest` channel, `release-policy.mjs latest` and specrails.dev downloads are unaffected. The `stable` tag is only an anchor for that release; it is not a version tag and does not match the `v*` trigger of `Desktop Release`.

The updater endpoint compiled into `tauri.conf.json` stays the `latest` manifest. The app checks through the native command `check_app_update(channel)` (`src-tauri/src/app_updates.rs`), which rebuilds the updater with the selected channel's endpoint and hands the stock plugin `Update` back to the UI, so download, signature verification and install use the plugin unchanged. A `stable` check before the first promotion fails with `stable-channel-unavailable`; the app says so instead of silently switching the user to `latest`.

**Promoting a release to stable.** Run the `Promote Stable` workflow (`.github/workflows/promote-stable.yml`, `workflow_dispatch` only) with `version=X.Y.Z`:

```sh
gh workflow run promote-stable.yml -f version=2.64.2 -f allow_rollback=false
```

`node scripts/release-policy.mjs stable-promotion` admits the promotion only when:

- `vX.Y.Z` is a published GitHub release (not a draft or prerelease) carrying `latest.json`;
- it was published at least **7 days** ago (`STABLE_SOAK_DAYS`);
- the exact commit of the tag has a successful `CI` push run on `main` in this repository;
- it does not move stable to an older version, unless `allow_rollback=true` is set for an incident rollback.

Only then does the job copy the assets onto the `stable` pre-release (creating it on first use). Nothing is promoted automatically; promoting is a deliberate maintainer action, typically monthly. Core's `stable` dist-tag is promoted in specrails-core on the same cadence; Desktop needs no change when it appears.

## Native validation without publication

Manually running `Desktop Release` defaults to `validation_only=true`. Select a trusted branch in this repository: admission requires successful push CI for that exact branch and SHA, and refuses evidence from another branch, a pull request or a fork. Selecting an existing matching release tag instead requires its main push CI. Validation builds retain their artifacts in GitHub Actions; macOS signing/notarization remains mandatory and the existing Windows installer signing policy is unchanged. The entire GitHub Release publication job is skipped. A passing validation build does not publish a release or move an update channel.

Both validation and release builds use `assemble-chromium.mjs --release`. On macOS, the certificate and Apple API key are imported before Chromium assembly. The assembler must sign and notarize Chromium before writing a normal `chromium.tar.gz`; missing credentials or failed verification fail the build. Windows uses the same archive format without changing the browser's Authenticode signature. The archive keeps framework symlinks intact through Tauri resource copying. Staging and packaged macOS smoke tests require Chromium signature and notarization verification as well as actual browser execution.

Local source tests can verify archive structure, symlinks and failure handling without accessing signing keys. Acceptance of Developer ID signatures, notarization and Gatekeeper behavior still requires the native validation run and inspection of its artifacts; an unsigned development build is not equivalent evidence.

The macOS job retains `artifacts/chromium-signing/` as the `chromium-signing-macos` Actions artifact for 14 days, including on failure. It contains the notarization submission/result/log JSON and the bundle verification receipt with checksums; private keys and certificates are not stored there. The job allows 120 minutes for assembly, Chromium notarization, outer-app notarization and smoke tests. When updating Playwright to a different Chromium major, review [the entitlement policy](../scripts/chromium-entitlements/README.md) and its current major-148 guard before accepting the new browser; do not bypass that guard merely to make the build pass.

## Credentials and external requirements

### Download channel

GitHub Releases is the only Desktop download channel. Each release carries the canonical installers, the Tauri updater assets and `manifest.json` (version, sha256 and size per platform, with GitHub asset URLs). The Tauri updater reads `releases/latest/download/latest.json` on the `latest` channel and the `stable` pointer on the `stable` channel (see [Update channels](#update-channels)); specrails.dev reads the latest release through the GitHub API. Nothing is uploaded to Hostinger, so a release has no second publication step to recover.

- `RELEASE_PAT` must be authorized for release-please's pull requests and releases. It also permits tag pushes to trigger publication workflows; events created with the repository's ordinary `GITHUB_TOKEN` generally do not trigger another workflow.
- Publication uses one of two credentials. When the `NPM_TOKEN` secret is set, it must authenticate an account with publishing permission for `specrails-desktop` (npm now requires such tokens to be granular with *bypass 2FA*, and they expire within 90 days); the workflow checks authentication and gives an explicit error before publishing. When the secret is empty, the job publishes through npm **trusted publishing**: it installs npm 11, removes the empty token line that `setup-node` writes, and lets npm exchange the job's OIDC identity (`id-token: write`) for a short-lived publish grant. That path only works once the package's *Trusted publisher* on npmjs.com names this repository (`fjpulidop/specrails-desktop`) and workflow file (`npm-publish.yml`, no environment); registry configuration is never changed from here. Provenance does **not** grant publishing permission in either mode. An npm `E404` during publication is npm's answer to an unauthorized publish and does not identify which token or permission failed; an `E403` mentioning two-factor authentication means the stored token lacks *bypass 2FA*. [npm publishing and provenance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages).
- Existing Apple signing/notarization and Tauri updater signing secrets remain required. Installer build steps retain their platform-specific checks.

No secret, registry authorization, signing certificate, hosting permission or branch protection is configured by these source changes. Dependency installation is separated from npm publishing credentials. Candidate Core packages and publication tarballs use `--ignore-scripts` at the relevant installation/publication boundaries. [npm installation lifecycle options](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

## Core compatibility dispatch

After publishing Core, its workflow dispatches `specrails-core-released` to Desktop with `client_payload.core_version` set to a bare stable version such as `5.0.0`. Desktop validates this value before using it as an npm package selector, installs that exact candidate in a temporary directory without running package scripts, and reads that candidate's contract explicitly.

A missing package, malformed version, registry failure or missing contract fails the check without claiming compatibility or opening a misleading drift issue. A measured contract mismatch or unsupported Core major opens one issue per version, using a separate `issues: write` job. The compatibility check does not upgrade the pinned native Core bundle; that remains a reviewed source change.

For local checks, run `npm run test:scripts` and actionlint 1.7.12 with `-shellcheck=`. For a reusable npm artifact, run `npm run build` followed by `npm run check:package -- --output artifacts/npm`; retain both the tarball and `package-verification.json` together. These commands do not publish anything.
