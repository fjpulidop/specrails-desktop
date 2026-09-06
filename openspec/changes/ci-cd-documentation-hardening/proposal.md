## Why

Desktop and Core releases currently run independently of their quality gates, and several publication and compatibility paths can report success without verifying the deliverable consumers install. Their READMEs also mix released behavior, development prerequisites, and older product descriptions.

## What Changes

- Gate releases on successful verification of the exact source revision and validate package/tag identity.
- Verify npm deliverables and their executable entrypoints before publication, with separate test and publication privileges.
- Harden workflow concurrency, timeouts, dependency automation, cross-repository contract checks, and release channel ordering.
- Keep native macOS and Windows coverage explicit and distinguish local checks from remote runner acceptance.
- Rewrite both READMEs around installation, provider/runtime requirements, development, updates, and links to detailed documentation.

## Capabilities

### New Capabilities
- `verified-delivery`: Reproducible quality gates and validated publication for Core and Desktop, with documentation matching the supported development and distribution paths.

### Modified Capabilities
None.

## Impact

Both repositories' GitHub Actions, package scripts, release/check helpers, dependency update configuration, and README files. Existing local feature changes remain in their current branches. No live publication, repository settings changes, or secret rotation is performed by this implementation.
