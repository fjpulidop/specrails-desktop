## Why

The macOS release encodes Chromium to avoid nested notarization while leaving its ad-hoc signatures unchanged. A trusted distribution must sign and notarize the browser itself and verify the extracted payload with the same sandbox behavior as production.

## What Changes

- Replace newly generated opaque archives with transparent archives preserving framework symlinks.
- Sign Chromium components with explicit role-specific policies, notarize/staple the browser, and reject incomplete credentials or verification failures in release mode.
- Preserve legacy archive decoding for installed versions and prefer the new format.
- Exercise extracted browser rendering and sandbox behavior, including distribution signature/ticket checks on macOS.
- Provide a CI validation-only path that builds signed artifacts without publishing releases or changing download channels.

## Capabilities

### New Capabilities

- `signed-browser-payload`: Verified Chromium distribution and backward-compatible extraction.

### Modified Capabilities

None. Existing native browser UI and normal release-channel rules remain intact.

## Impact

Desktop release workflow, Chromium assembly/signing scripts and entitlements, runtime extraction, Playwright launch settings, functional smoke checks, regression tests and release documentation. Real Apple acceptance requires configured distribution credentials and a hosted macOS run; no publication is part of this implementation.
