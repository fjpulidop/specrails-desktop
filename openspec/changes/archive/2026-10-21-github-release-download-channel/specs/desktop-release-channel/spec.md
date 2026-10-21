## MODIFIED Requirements

### Requirement: Stable "latest" download URL for macOS build
The system SHALL publish the most recent signed and notarised `.dmg` for specrails-desktop as an asset of the GitHub Release for its tag, so that the GitHub latest release always offers the current macOS installer. The asset SHALL be the same signed and notarised artifact the build job produced. The system SHALL NOT upload installers to specrails.dev.

#### Scenario: Tag push publishes the dmg to the GitHub Release
- **WHEN** a commit tagged `v<version>` is pushed and the `Desktop Release` workflow completes successfully
- **THEN** the GitHub Release `v<version>` has an asset named `specrails-desktop-<version>-aarch64.dmg` downloadable from `https://github.com/fjpulidop/specrails-desktop/releases/download/v<version>/specrails-desktop-<version>-aarch64.dmg`

#### Scenario: Subsequent release becomes the latest download
- **WHEN** a newer tag `v<version+1>` is released
- **THEN** the GitHub latest release is `v<version+1>` and its `.dmg` asset is `specrails-desktop-<version+1>-aarch64.dmg`

### Requirement: Stable "latest" download URL for Windows build
The system SHALL publish the most recent Windows installers for specrails-desktop as assets of the GitHub Release for its tag. Windows releases SHALL ship only the NSIS installer, for x64 and ARM64. The Windows installer MAY be unsigned; Authenticode code-signing is not required by this requirement.

#### Scenario: Tag push publishes Windows installers to the GitHub Release
- **WHEN** a commit tagged `v<version>` is pushed and the `Desktop Release` workflow completes successfully
- **THEN** the GitHub Release `v<version>` has assets named `specrails-desktop-<version>-x64-setup.exe` and `specrails-desktop-<version>-arm64-setup.exe`

#### Scenario: Subsequent release becomes the latest Windows download
- **WHEN** a newer tag `v<version+1>` is released
- **THEN** the GitHub latest release is `v<version+1>` and offers `specrails-desktop-<version+1>-x64-setup.exe`

### Requirement: Release manifest describes the latest build
Each GitHub Release SHALL carry a UTF-8 JSON `manifest.json` asset, reachable for the latest release at `releases/latest/download/manifest.json`. It SHALL contain `schemaVersion` (`1`), `version` (no leading `v`), `releasedAt` (ISO 8601 UTC), `releaseUrl` and `platforms`, keyed by `<os>-<arch>` (`darwin-arm64`, `windows-x64`, `windows-arm64`), each with the asset `filename`, GitHub `url`, lowercase hex `sha256` and byte `size`.

#### Scenario: Manifest is valid JSON and matches schema
- **WHEN** a release completes and `manifest.json` is fetched
- **THEN** it parses as JSON, contains `schemaVersion`, `version`, `releasedAt`, `releaseUrl`, and a `platforms` object with at least `darwin-arm64`

#### Scenario: Manifest includes windows-x64 entry
- **WHEN** a release completes for which the Windows x64 build job succeeded
- **THEN** `manifest.json.platforms["windows-x64"]` exists and contains `filename`, `url`, `sha256`, and `size`
- **AND** `platforms["windows-x64"].filename` matches `^specrails-desktop-\d+\.\d+\.\d+-x64-setup\.exe$`

#### Scenario: Manifest reflects the most recent release
- **WHEN** the release for tag `v<version>` completes
- **THEN** `manifest.json.version === "<version>"` (no leading `v`) and every `platforms[<key>].url` points at `releases/download/v<version>/`

#### Scenario: Manifest sha256 matches the published binary for every platform
- **WHEN** the consumer downloads the file referenced by `platforms[<key>].url` for any key in `platforms` and computes its sha256
- **THEN** the result equals `platforms[<key>].sha256`

#### Scenario: Manifest size matches the published binary for every platform
- **WHEN** the consumer downloads the file referenced by `platforms[<key>].url` for any key in `platforms`
- **THEN** its byte length equals `platforms[<key>].size`

### Requirement: Manifest is uploaded after all referenced binaries
The system SHALL upload `manifest.json` in the same GitHub Release upload as every installer it references, and SHALL fail the release before upload if any referenced installer is missing, so the manifest never references an installer the release does not carry.

#### Scenario: Missing installer stops publication
- **WHEN** a referenced installer was not produced by its build job
- **THEN** the canonical rename step fails and neither the installers nor `manifest.json` are uploaded

### Requirement: Released filename includes the version
The `.dmg` asset name SHALL contain the release version so that a consumer can derive the version by parsing the filename when the manifest is unavailable.

#### Scenario: Filename contains semver
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the `.dmg` asset name matches the regular expression `^specrails-desktop-\d+\.\d+\.\d+-aarch64\.dmg$` and the captured version equals the release version

### Requirement: Windows installer filename includes the version and architecture
The Windows installer asset names SHALL contain the release version and architecture so that consumers can derive both by parsing the filename when the manifest is unavailable.

#### Scenario: NSIS filename contains semver and arch
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the NSIS installer asset names match `^specrails-desktop-\d+\.\d+\.\d+-(x64|arm64)-setup\.exe$` and the captured version equals the release version

## REMOVED Requirements

### Requirement: Versioned download URL remains available
**Reason**: GitHub Releases keeps every tag's assets; the versioned specrails.dev folder only duplicated them.
**Migration**: Link `https://github.com/fjpulidop/specrails-desktop/releases/tag/v<version>`; specrails-web redirects old `/downloads/specrails-desktop/*` URLs to GitHub.

### Requirement: Versioned download URL for Windows build remains available
**Reason**: GitHub Releases keeps every tag's assets; the versioned specrails.dev folder only duplicated them.
**Migration**: Link `https://github.com/fjpulidop/specrails-desktop/releases/tag/v<version>`.

### Requirement: Manifest cache is short-lived
**Reason**: The manifest is no longer served by specrails.dev; GitHub serves immutable per-tag assets and `releases/latest` resolves to the newest tag.
**Migration**: Browsers read the latest release through the GitHub API, which is not cached across releases.
