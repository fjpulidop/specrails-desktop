## Context

Chromium is copied by Tauri as an archive to preserve framework symlinks, then extracted into a runtime cache. The current archive is encoded to avoid nested notarization. Release CI already references Apple distribution credentials but does not sign the nested browser, and the browser smoke disables its sandbox.

## Goals / Non-Goals

**Goals:** Produce transparent, signed and notarized macOS browser payloads; preserve Windows and legacy extraction; validate actual browser launches; provide non-publishing acceptance builds.

**Non-Goals:** Changing native WebKit/WebView2 UI, downloading signing credentials locally, or publishing a release during implementation.

## Decisions

- Copy Playwright's pinned browser into temporary staging, preserving symlinks. Never modify the user's browser cache.
- Explicitly inventory Mach-O code and nested bundles and sign them inside out. Use Chromium's per-role entitlement policy, not the main Specrails app entitlements or a blanket `codesign --deep` signing command. Unknown helper roles fail for deliberate review.
- Use Developer ID, secure timestamps and Hardened Runtime for executable processes. Notarize a ZIP of the browser, staple its ticket, then create a transparent tar.gz. Verify the extracted browser before using it as a release resource.
- Reject missing credentials, unsigned components and non-Accepted notarization. Bound subprocess duration and record notary results without emitting credentials.
- Prefer tar.gz/tar, preserving legacy pak reads. Generate only transparent archives for new macOS and Windows builds.
- Run Playwright with explicit sandbox enablement on macOS/Windows and match this behavior in functional checks. Test DOM/JS and graphics functionality in a temporary profile; verification failures block publication.
- Validation-only CI requires successful checks on the exact selected trusted repository revision and bypasses all publication jobs, while retaining signed artifacts. Normal publication keeps existing main/tag gates.

## Risks / Trade-offs

- Chromium's layout and entitlements can evolve → inventory roles explicitly and fail on unsupported ones; document the reviewed upstream revision.
- Apple submission latency and credential validity are external → bounded failures and artifact diagnostics; do not claim acceptance without a hosted run.
- Signature changes can affect renderer/GPU loading → functional tests use the extracted signed bytes and sandbox, with a clean-Mac installer acceptance checklist.
- Archive handling is shared with Windows → shared assembly and hermetic format tests; leave Windows Authenticode signatures intact.
