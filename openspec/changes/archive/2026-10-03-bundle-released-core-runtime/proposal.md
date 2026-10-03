## Why

Desktop still ships Core 6.1.0 while the companion Core PR contains the verification and OpenSpec fixes required by the current Desktop changes. New Desktop installations should include those fixes without a separate Core installation.

## What Changes

- Complete the authorized Core merge and its normal release pipeline, preserving CI and publication evidence.
- Pin Desktop's release bundle and vendored npm dependency lock to the resulting published Core version.
- Pair integration CI with the corresponding immutable release revision and use the supported Node runtime in the Windows bundle smoke lane.
- Verify the installed, staged registry package and update the runtime update guide.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-update-consistency`: Desktop ships an exact, integrity-locked, compatible published Core release as its offline default.

## Impact

Core PR and release coordination; Desktop release and CI workflows; `scripts/assemble-bundled-core.lock.json`; `docs/internals/core-runtime-updates.md`. No changes to project state or retained-run runtime selection.
