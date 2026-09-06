# Chromium signing policy

Reviewed against Chromium **148.0.7778.96**, the browser shipped by the locked Playwright dependency. The release assembler rejects a different major until this policy is deliberately reviewed. It also rejects unknown nested helper bundles.

- The browser retains Chromium's ordinary device/TCC entitlements.
- Renderer and GPU helpers need `allow-jit`. They use Hardened Runtime without the explicit `library` code-sign option, matching Chromium's role distinction.
- Ordinary helper executables use Hardened Runtime, `kill`, `restrict`, and library validation without additional entitlement exceptions.
- Dynamic libraries/frameworks are signed without process-specific runtime flags or entitlement files.

Do not substitute the main Specrails app's entitlements, Google-private entitlements, `get-task-allow`, or a blanket `codesign --deep --force`. The development-only ad-hoc signing API exists to test signature structure; it cannot provide a Team ID, a notarization ticket or a runnable distribution with library validation. Release assembly never falls back to it.

When updating Playwright across Chromium majors, compare the matching upstream revision's [browser entitlements](https://chromium.googlesource.com/chromium/src/+/148.0.7778.96/chrome/app/app-entitlements.plist), [renderer entitlements](https://chromium.googlesource.com/chromium/src/+/148.0.7778.96/chrome/app/helper-renderer-entitlements.plist), [GPU entitlements](https://chromium.googlesource.com/chromium/src/+/148.0.7778.96/chrome/app/helper-gpu-entitlements.plist) and [component signing policy](https://chromium.googlesource.com/chromium/src/+/148.0.7778.96/chrome/installer/mac/signing/parts.py). Review new components, update this policy and run the signed validation workflow before publication. Configuration is derived from Chromium's documented requirements; the implementation and fixtures live in `scripts/sign-chromium-macos.mjs` and its tests.
