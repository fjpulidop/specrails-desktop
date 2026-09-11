# Verification — 6 September 2026

This change implements the signing/notarization flow. It has not performed a real Apple submission or published any installer.

## Local evidence

The complete script suite passed **65 tests**, including the new signing/assembly/browser guards and existing release/package helpers. Together with the runtime suites below, **125 focused tests** passed.

- Component-signing and assembly tests cover signing order, every Mach-O, role-specific entitlements, team/timestamp/runtime rejection, unknown helper/version rejection, missing credentials, failed and accepted notary responses, diagnostic retrieval, transparent tar round-trips, symlinks, staging failure preservation, stale unpacked code removal and CLI invocation through symlinks.
- Browser verification tests cover format selection, legacy decoding, unsafe archive paths and links, signature failure before launch, cleanup, sandbox options and rendering failures. All 17 passed on Node 25.9.0 and the available bundled Node 22.23.1.
- Runtime/browser regression suites passed 60 tests. They exercise cache invalidation and concurrency, rollback, archive changes during extraction, preservation of tar metadata and explicit sandbox settings on macOS/Windows.
- Full TypeScript checking, server production build, shell/JavaScript syntax, actionlint 1.7.12 (`-shellcheck=`), `git diff --check` and strict OpenSpec validation passed.

## Actual Chromium smoke

The installed Playwright browser was copied to temporary staging, assembled as a transparent archive, extracted into a separate temporary directory and launched with a temporary profile. The user's browser cache was not modified. The browser was Chromium **148.0.7778.96** on macOS ARM64.

The smoke confirmed JavaScript/DOM interaction, canvas pixel output, PNG screenshots, sandbox launch arguments, WebGL, a live GPU process and Metal rendering on Apple M1 Pro. Chromium reported GPU compositing/rasterization enabled and the smoke reported no graphics limitations. This development payload was explicitly reported as `signatureVerified: false` and `notarizationVerified: false`.

A second disposable copy exercised the actual `codesign` tool using the new inside-out policy with an ad-hoc identity: all 13 Mach-O components were signed and outer deep/strict verification succeeded, preserving framework symlinks. Launching that copy under the distribution library-validation flags correctly failed because an ad-hoc signature has no valid distribution Team ID. The policy was not weakened to turn this fixture green. This is evidence of signing structure and fail-closed behavior, not proof of Developer ID execution or notarization.

## Hosted acceptance

After the source revision is available remotely and its CI passes, run **Desktop Release** on that trusted branch with **validation_only=true**. This path must retain installers/diagnostics and skip the entire release/download deployment job.

The macOS job must successfully sign every browser component, receive `Accepted` from Apple's service, staple and validate the browser ticket, retain the ticket through archive extraction, pass Gatekeeper assessment and execute the signed payload with sandbox and graphics checks. It then builds/notarizes Specrails and repeats checks on the payload inside the final application. Confirm the downloaded installer on a clean Mac, including first browser use without a network connection. No local test can replace this credential-dependent acceptance.

Windows x64/ARM64 must pass their hosted archive and installed-application checks. New archives preserve upstream Authenticode bytes; this change does not introduce installer signing or claim a local Windows run.

Diagnostics include the browser notary submission ID, service result/log and verified archive receipt under `artifacts/chromium-signing/`. They exclude signing certificates and API private keys. A failed or timed-out submission remains a failure; do not bypass the gate or reintroduce archive encoding to obtain a green release.

## Hosted Windows regression follow-up

The first PR run demonstrated that Windows system tar can write through an archive-created symlink before post-extraction validation. Archive admission now runs before extraction in both the distribution verifier and the installed runtime. A shared, shipped module rejects Windows links and special entries after tar resolves PAX/GNU metadata, rejects Windows path aliases, and removes inherited TAR_OPTIONS. macOS internal framework links remain supported and the extracted tree is checked before discovery/publication.

Real ustar, PAX and GNU symlink/hardlink fixtures prove rejection before extraction; a runtime fixture verifies that external files and the prior browser cache/receipt remain unchanged. The complete script suite passed 74 tests, resolver/launcher regressions passed 28 tests, TypeScript passed, and the real production package check loaded the shared validator from the installed tarball. Hosted Windows validation is rerun on the follow-up commit.
