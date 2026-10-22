## ADDED Requirements

### Requirement: Update channel setting

The app SHALL persist an app-wide `updateChannel` of `latest` (default) or `stable`, exposed through
`GET/PUT /api/settings` and chosen in App settings ▸ Updates. Any other value SHALL be rejected with
400 and not stored; an unreadable stored value SHALL read as `latest`.

#### Scenario: Choosing stable persists across restarts

- **WHEN** the user selects Stable
- **THEN** `PUT /api/settings { updateChannel: "stable" }` stores it and later reads return `stable`

#### Scenario: Unknown channel rejected

- **WHEN** a client sends `updateChannel: "beta"`
- **THEN** the server answers 400 and the stored channel is unchanged

### Requirement: Desktop updater follows the channel

The app update check SHALL read `releases/latest/download/latest.json` on `latest` and
`releases/download/stable/latest.json` on `stable`, reusing the updater plugin's download, signature
verification and install. On `stable`, a missing stable pointer SHALL be reported as
`stable-channel-unavailable` and SHALL NOT fall back to `latest`.

#### Scenario: Stable check

- **WHEN** the channel is `stable` and the pointer serves version 2.64.2
- **THEN** the check offers 2.64.2 through the standard update card

#### Scenario: No promoted release

- **WHEN** the channel is `stable` and no release has been promoted
- **THEN** the manual check explains that no stable release exists yet

### Requirement: Core updates follow the channel

The Core update check SHALL read the npm `latest` dist-tag on `latest` and the `stable` dist-tag on
`stable`. Only when the `stable` dist-tag does not exist (404) SHALL it use `latest`, reporting
`resolvedDistTag: "latest"` and `channelFallback: true`. A version cached for one channel SHALL NOT be
offered or installed after switching to the other channel.

#### Scenario: Core has no stable tag

- **WHEN** the channel is `stable` and npm has no `stable` dist-tag
- **THEN** the status reports the `latest` version with `channelFallback: true` and the UI explains it

#### Scenario: Channel switch invalidates the cached target

- **WHEN** a check on `latest` found 6.7.0 and the user switches to `stable`
- **THEN** the status shows no available update until a stable check runs

### Requirement: Guarded stable promotion

A `workflow_dispatch`-only workflow SHALL promote a version to stable only when it is a published,
non-draft, non-prerelease `vX.Y.Z` release carrying `latest.json`, published at least 7 days earlier,
whose exact tag commit has a successful main push CI, and which does not move stable to an older
version unless rollback is explicitly allowed. The stable pointer SHALL be a GitHub pre-release that
never becomes the repository's latest release.

#### Scenario: Release too fresh

- **WHEN** a maintainer promotes a release published 6 days ago
- **THEN** the policy step fails and nothing is published

#### Scenario: Successful promotion

- **WHEN** a maintainer promotes 2.64.2, published 8 days ago with green CI, while stable serves 2.63.0
- **THEN** the `stable` pre-release assets are replaced with 2.64.2's `latest.json` and `manifest.json` plus `stable.json`
