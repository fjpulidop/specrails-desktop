# CI/CD and README audit — 6 September 2026

This audit covers the current Desktop and Core source branches. It does not publish either package, modify repository protection rules, configure npm accounts, or exercise production hosting/signing credentials.

## Findings and changes

| Finding | Change |
| --- | --- |
| Release automation ran independently of CI and could publish after failed verification. | Publication now requires successful main-branch CI for the exact release commit; tag/package identity is checked before distribution. Stale main pushes cannot advance release metadata. |
| Tests against a checkout did not prove the npm payload was usable. Desktop omitted its compiled MCP bridge and filesystem-loaded server resources. | Both repositories install and inspect the actual tarball in a temporary consumer. Desktop builds and ships MCP, schemas, shell-integration shims and Serena templates. Core exercises both CLI entries, four provider assemblies and installed pipeline journals. |
| Credential-bearing release jobs also performed package installation/build work. | Preparation and tests use read-only jobs. npm publication consumes verified bytes with lifecycle scripts disabled; npm credentials are limited to the publish step. |
| Concurrent or late releases could move mutable `latest` channels backwards. | Global publication serialization and numeric version guards reject older promotions. Exact existing npm versions require matching integrity for retry. |
| Core notified the former web repository but not Desktop; Desktop's compatibility check could skip the intended package. | Core dispatches to both consumers with their expected version formats. Desktop validates an explicitly installed candidate and fails if its contract cannot be checked. Only actual drift opens a deduplicated issue. |
| Workflow syntax and downloaded CI utilities had incomplete verification; native dependency update coverage was missing. | Actionlint becomes a CI gate; utilities are checksum-verified, actions are commit-pinned, and Desktop dependency automation includes Cargo and the MCP bridge. |
| Native download promotion uploaded its public manifest directly and used plaintext FTP. | Host publication requires FTPS and promotes the manifest using a server-side rename after uploading and checking the referenced installers. Hosting support must be verified during deployment acceptance. |
| Chromium's optional macOS bundle concealed ad-hoc binaries in an encoded archive, and the launcher's sandbox comment did not match Playwright's default. | New assembly uses transparent archives and a release signing/notarization gate. The resolver prefers those archives, preserves framework links and rolls back failed cache publication. macOS/Windows launches explicitly enable Chromium's sandbox. Hosted signing and clean-machine browser acceptance remain pending. |
| READMEs contained older architecture, installation claims, unsupported comparisons and incomplete native development steps. | Both READMEs now distinguish the native app, npm/browser use, provider workflows, source development and published releases, with links to detailed feature and release documentation. |

## Verification boundaries

Package checks do not invoke a model or read the user's project registry. Desktop's package smoke verifies CLI execution and runtime resource discovery with dependency lifecycle scripts disabled; it does not certify native SQLite/PTY ABI behavior or launch a complete installed server. Native fixtures and installer gates cover separate parts of that acceptance surface.

Local workflow syntax, helper regression, build, typecheck, package and coverage results are recorded in the [verification report](../../openspec/changes/ci-cd-documentation-hardening/verification.md). Windows/Linux runner execution and real signed publication require the hosted workflows after these changes are merged. Coverage thresholds were retained.

### Native Chromium signing: implementation repaired, hosted acceptance pending

The former optional macOS bundle used XOR-encoded `chromium.pak` to prevent inspection of Chromium's ad-hoc signatures. Outer-app notarization therefore did not establish that the extracted browser met distribution-signing requirements. The audit also found that omitting `--no-sandbox` was insufficient: Playwright disables its Chromium sandbox by default unless `chromiumSandbox` is explicitly enabled.

The new `scripts/assemble-chromium.mjs` packages Chromium as transparent `chromium.tar.gz`, preserving versioned framework symlinks. Release mode on macOS requires Developer ID signing from inner components to their enclosing bundles, Hardened Runtime, the appropriate Chromium component entitlements, signature verification and notarization before distribution. Local assembly invokes the same packager without release credentials, producing an explicitly unsigned development artifact. `scripts/obfuscate-chromium.mjs` remains only for legacy compatibility and fixtures; new release assembly does not produce `.pak` files.

The resolver selects `.tar.gz` and `.tar` before legacy `.pak`, binds cache reuse to the selected archive's path and filesystem revision, rechecks deleted caches and preserves the prior extraction if replacement fails. Regression fixtures exercise transparent/legacy migration and framework symlinks. The production Playwright launcher explicitly sets `chromiumSandbox: true` on macOS and Windows; Linux retains its existing compatibility fallback.

These code changes do not certify an unsigned local browser or a future signed release. Acceptance still requires the real Developer ID/notary workflow and a clean Mac run of the **extracted distributed** browser, including renderer and GPU processes with the sandbox enabled, plus the relevant hosted Windows checks. No signing credential, quarantine attribute or production installer was modified to claim that acceptance locally. A blanket `codesign --deep` substitution is insufficient. See [Chromium's signing process](https://chromium.googlesource.com/chromium/src/+/main/chrome/installer/mac/signing/README.md) and [Apple's distribution signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).

## Observed production release failure

Desktop [CI run 33986784637](https://github.com/fjpulidop/specrails-desktop/actions/runs/33986784637) and the [v2.41.0 native release run](https://github.com/fjpulidop/specrails-desktop/actions/runs/33986801426) succeeded. The separate [npm publication run 33986784639](https://github.com/fjpulidop/specrails-desktop/actions/runs/33986784639) failed with `E404` on `PUT https://registry.npmjs.org/specrails-desktop`. The package remains readable in the registry. This result requires checking npm publication authorization; it does not establish exactly which credential or account setting is wrong. Source changes cannot prove that the configured secret can publish.

Follow [Desktop CI and releases](../ci-cd.md) and [Core CI and publishing](https://github.com/fjpulidop/specrails-core/blob/main/docs/ci-cd.md) when configuring credentials or retrying publication. npm trusted publishing needs repository/workflow configuration in the npm account before token authentication can be removed. The implementation follows [GitHub's workflow permission rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [npm's provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
