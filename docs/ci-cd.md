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
| Native release builds | Packaged resources and installer validation; Windows additionally exercises installed NSIS/MSI artifacts |

The npm package check does not start a server or exercise native postinstall rebuilds. Native platform jobs and installed application smoke tests provide separate evidence. Defining a Windows or signing job is not evidence that it has passed: inspect the corresponding GitHub run before claiming platform or release acceptance.

Actions are pinned to commit SHAs. Downloaded actionlint and gitleaks binaries have fixed checksums verified before execution. Actionlint checks workflow structure, expressions and action inputs; its ShellCheck integration is disabled, so it does not claim complete shell-script analysis. Dependabot covers root/client/MCP npm dependencies, GitHub Actions and Cargo.

## Release flow

1. A successful main `CI` run triggers `Release`. It checks out that exact revision, skips superseded main revisions and lets release-please maintain the release pull request or tag. The credential-bearing job does not install dependencies or run builds.
2. `Publish npm` and the publishing mode of `Desktop Release` accept a stable `vX.Y.Z` tag only when it exactly matches `package.json` and the checked-out commit. Publication retries must select that existing tag; for `Desktop Release`, explicitly set `validation_only=false`. Prereleases and branch-based manual publication are rejected.
3. Both workflows wait for successful main CI for that exact SHA, with a bounded deadline. Failed or cancelled CI must be corrected or rerun successfully before retrying publication. This is an API check requiring `actions: read`, not an assumption about branch protection.
4. The npm packaging job builds and verifies a tarball with read-only repository permissions. It uploads that tarball and its integrity receipt. A separate publication job rechecks its identity and hashes and publishes those exact bytes with lifecycle scripts disabled and provenance enabled.
5. Native publication waits for every platform build. The mutable download channel is serialized, refuses older versions, and switches the verified manifest using an FTPS rename after all referenced files are uploaded. Server-managed `.htaccess` remains untouched. Previous binaries are retired only after the new manifest has been fetched and verified.

npm publication is serialized across versions and checks the current `latest` version before publishing. An already published version is skipped only if its registry integrity matches the verified tarball. A different payload fails rather than overwriting an immutable package. Concurrency alone cannot prevent an old retry from running after a newer release, which is why version guards are also required. [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Release admission uses the current run/attempt of the named CI workflow and the exact SHA, repository, branch and event. The metadata workflow consumes no artifacts from an untrusted pull request. [Workflow-run trust and event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs).

## Native validation without publication

Manually running `Desktop Release` defaults to `validation_only=true`. Select a trusted branch in this repository: admission requires successful push CI for that exact branch and SHA, and refuses evidence from another branch, a pull request or a fork. Selecting an existing matching release tag instead requires its main push CI. Validation builds retain their artifacts in GitHub Actions; macOS signing/notarization remains mandatory and the existing Windows installer signing policy is unchanged. The entire GitHub Release/Hostinger deployment job is skipped. A passing validation build does not publish a release or move an update channel.

Both validation and release builds use `assemble-chromium.mjs --release`. On macOS, the certificate and Apple API key are imported before Chromium assembly. The assembler must sign and notarize Chromium before writing a normal `chromium.tar.gz`; missing credentials or failed verification fail the build. Windows uses the same archive format without changing the browser's Authenticode signature. The archive keeps framework symlinks intact through Tauri resource copying. Staging and packaged macOS smoke tests require Chromium signature and notarization verification as well as actual browser execution.

Local source tests can verify archive structure, symlinks and failure handling without accessing signing keys. Acceptance of Developer ID signatures, notarization and Gatekeeper behavior still requires the native validation run and inspection of its artifacts; an unsigned development build is not equivalent evidence.

The macOS job retains `artifacts/chromium-signing/` as the `chromium-signing-macos` Actions artifact for 14 days, including on failure. It contains the notarization submission/result/log JSON and the bundle verification receipt with checksums; private keys and certificates are not stored there. The job allows 120 minutes for assembly, Chromium notarization, outer-app notarization and smoke tests. When updating Playwright to a different Chromium major, review [the entitlement policy](../scripts/chromium-entitlements/README.md) and its current major-148 guard before accepting the new browser; do not bypass that guard merely to make the build pass.

## Credentials and external requirements

- `RELEASE_PAT` must be authorized for release-please's pull requests and releases. It also permits tag pushes to trigger publication workflows; events created with the repository's ordinary `GITHUB_TOKEN` generally do not trigger another workflow.
- `NPM_TOKEN` must authenticate an account with publishing permission for `specrails-desktop`. The workflow checks authentication and gives an explicit error before publishing. Provenance requires `id-token: write`; it does **not** grant npm publishing permission. Trusted publishing requires separate registry configuration and is not silently enabled here. An npm `E404` during publication is not sufficient evidence to identify a particular token or permission failure. [npm publishing and provenance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages).
- Existing Apple signing/notarization and Tauri updater signing secrets remain required. Installer build steps retain their platform-specific checks.
- Hostinger credentials must support **explicit FTPS**, a valid TLS certificate, uploads and `RNFR`/`RNTO` in the release directory. There is no plaintext FTP fallback. A failed transfer or rename fails the workflow before old files are removed. [FTP action protocol and security options](https://github.com/SamKirkland/FTP-Deploy-Action/blob/v4.3.6/action.yml).

No secret, registry authorization, signing certificate, hosting permission or branch protection is configured by these source changes. Dependency installation is separated from npm publishing credentials. Candidate Core packages and publication tarballs use `--ignore-scripts` at the relevant installation/publication boundaries. [npm installation lifecycle options](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

## Core compatibility dispatch

After publishing Core, its workflow dispatches `specrails-core-released` to Desktop with `client_payload.core_version` set to a bare stable version such as `5.0.0`. Desktop validates this value before using it as an npm package selector, installs that exact candidate in a temporary directory without running package scripts, and reads that candidate's contract explicitly.

A missing package, malformed version, registry failure or missing contract fails the check without claiming compatibility or opening a misleading drift issue. A measured contract mismatch or unsupported Core major opens one issue per version, using a separate `issues: write` job. The compatibility check does not upgrade the pinned native Core bundle; that remains a reviewed source change.

For local checks, run `npm run test:scripts` and actionlint 1.7.12 with `-shellcheck=`. For a reusable npm artifact, run `npm run build` followed by `npm run check:package -- --output artifacts/npm`; retain both the tarball and `package-verification.json` together. These commands do not publish anything.
