## Context

Desktop has independent npm and native distribution workflows; Core is an npm package consumed by providers and Desktop's pinned bundle. Both repositories already have broad tests, while their publication paths do not consistently depend on those tests. Existing uncommitted feature work must remain intact.

## Goals / Non-Goals

**Goals:** Validate the exact release source and npm payload; prevent skipped or unrelated CI from authorizing publication; reduce duplicate or stale runs; document real entrypoints, platform coverage, and operational release requirements.

**Non-Goals:** Publishing these changes, changing repository protection rules or signing credentials, promising real-device acceptance from local source tests, or replacing the release infrastructure wholesale.

## Decisions

- Keep existing release-please and native publication destinations. Add revision/version validation and quality dependencies around them instead of introducing a new release service.
- Verify npm tarballs before publishing. Run package entrypoints in isolation and inspect required runtime assets so tests against a checkout cannot conceal missing distribution files.
- Separate quality checks from credential-bearing publication jobs. Minimize permissions and retain existing authentication paths until external trusted-publisher configuration is explicitly available.
- Preserve cross-platform matrices and coverage thresholds. Bound execution time and cancel superseded development checks, while serializing mutable release channels without cancelling an active publication.
- Treat Core/Desktop compatibility dispatch as an exact-version contract check. Invalid input or unavailable contract must not produce a green compatibility result.
- Document installed product, browser development, native development, and source-branch behavior separately. Link detailed feature and CI documents from compact READMEs.

## Risks / Trade-offs

- Remote GitHub runners, signing and hosting credentials cannot be exercised locally → validate workflow syntax and helper behavior; record remote-only release acceptance explicitly.
- Existing branch protection can refer to job names → retain established names where practical and document any newly recommended aggregate gate.
- More distribution validation adds work → avoid rerunning complete suites within release jobs when successful exact-revision evidence is available, and reuse tested artifacts.
- Previously published versions are immutable → permit safe release recovery only after verifying existing publication; never silently replace a different payload.

## Migration Plan

Merge each repository's reviewed changes, verify its CI on GitHub, then use normal release-please flow. Existing secrets remain valid. Roll back workflow changes through Git without altering installed user data.
