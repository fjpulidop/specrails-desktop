# desktop-release-channel Specification

## Purpose
Defines the desktop release publishing contract for stable latest downloads, versioned archival URLs, and release manifests across supported platforms.
## Requirements
### Requirement: Stable "latest" download URL for macOS build
The system SHALL publish the most recent signed and notarised `.dmg` for specrails-desktop to a stable, version-independent URL at `https://specrails.dev/downloads/specrails-desktop/latest/`. The file SHALL be the same signed and notarised artifact that is published to the versioned folder for the corresponding tag.

#### Scenario: Tag push publishes to latest folder
- **WHEN** a commit tagged `v<version>` is pushed and the `Desktop Release` workflow completes successfully
- **THEN** a file named `specrails-desktop-<version>-aarch64.dmg` exists at `https://specrails.dev/downloads/specrails-desktop/latest/` and returns HTTP 200

#### Scenario: Latest file matches versioned file
- **WHEN** both the `latest/` and the corresponding `v<version>/` folder have been populated by the same workflow run
- **THEN** the `.dmg` binaries at both locations have identical sha256 hashes

#### Scenario: Subsequent release replaces latest
- **WHEN** a newer tag `v<version+1>` is released
- **THEN** `https://specrails.dev/downloads/specrails-desktop/latest/specrails-desktop-<version+1>-aarch64.dmg` is served and any prior `.dmg` left in `latest/` from a previous release SHALL NOT be served from that folder

### Requirement: Stable "latest" download URL for Windows build
The system SHALL publish the most recent Windows x64 installer for specrails-desktop to a stable, version-independent URL at `https://specrails.dev/downloads/specrails-desktop/latest/`. The Windows installer SHALL be the same artifact published to the versioned folder for the corresponding tag. The v1 Windows installer MAY be unsigned; Authenticode code-signing is not required by this requirement.

#### Scenario: Tag push publishes Windows installer to latest folder
- **WHEN** a commit tagged `v<version>` is pushed and the `Desktop Release` workflow completes successfully
- **THEN** a file named `specrails-desktop-<version>-x64-setup.exe` exists at `https://specrails.dev/downloads/specrails-desktop/latest/` and returns HTTP 200
- **AND** a file named `specrails-desktop-<version>-x64.msi` exists at the same folder and returns HTTP 200

#### Scenario: Latest Windows installer matches versioned file
- **WHEN** both the `latest/` and the corresponding `v<version>/` folder have been populated by the same workflow run
- **THEN** the `.exe` binaries at both locations have identical sha256 hashes
- **AND** the `.msi` binaries at both locations have identical sha256 hashes

#### Scenario: Subsequent release replaces latest Windows installer
- **WHEN** a newer tag `v<version+1>` is released
- **THEN** `https://specrails.dev/downloads/specrails-desktop/latest/specrails-desktop-<version+1>-x64-setup.exe` is served
- **AND** any prior Windows installer left in `latest/` from a previous release SHALL NOT be served from that folder

### Requirement: Versioned download URL remains available
The system SHALL continue to publish each released `.dmg` to its version-specific folder `https://specrails.dev/downloads/specrails-desktop/v<version>/` for archival and deep linking.

#### Scenario: Versioned URL remains reachable after new release
- **WHEN** a new release is published and `latest/` has been updated
- **THEN** the previous release's `.dmg` at `https://specrails.dev/downloads/specrails-desktop/v<previous-version>/` still returns HTTP 200

### Requirement: Versioned download URL for Windows build remains available
The system SHALL publish each released Windows installer (`.exe` and `.msi`) to its version-specific folder `https://specrails.dev/downloads/specrails-desktop/v<version>/` for archival and deep linking.

#### Scenario: Versioned Windows URL remains reachable after new release
- **WHEN** a new release is published and `latest/` has been updated
- **THEN** the previous release's Windows `.exe` at `https://specrails.dev/downloads/specrails-desktop/v<previous-version>/specrails-desktop-<previous-version>-x64-setup.exe` still returns HTTP 200

### Requirement: Release manifest describes the latest build
The system SHALL publish a `manifest.json` file at `https://specrails.dev/downloads/specrails-desktop/latest/manifest.json` that describes the most recent release. The manifest SHALL be a UTF-8 encoded JSON document with the following fields:

- `schemaVersion` (integer): currently `1`.
- `version` (string): semver version of the release, without a leading `v` (e.g. `"1.40.0"`).
- `releasedAt` (string): ISO 8601 UTC timestamp of when the release was published.
- `releaseUrl` (string): HTTPS URL of the corresponding GitHub Release page.
- `platforms` (object): map whose keys are `<os>-<arch>` identifiers. Currently defined keys are `darwin-arm64` and `windows-x64`. Additional platform keys MAY be added in future releases without bumping `schemaVersion`. Each value contains:
  - `filename` (string): the installer filename inside `latest/`. For `windows-x64` this points to the NSIS `.exe` installer.
  - `url` (string): absolute HTTPS URL of the installer inside `latest/`.
  - `sha256` (string): lowercase hex sha256 of the installer.
  - `size` (integer): size of the installer in bytes.

#### Scenario: Manifest is valid JSON and matches schema
- **WHEN** a release completes and `manifest.json` is fetched
- **THEN** it parses as JSON, contains `schemaVersion`, `version`, `releasedAt`, `releaseUrl`, and a `platforms` object with at least `darwin-arm64`

#### Scenario: Manifest includes windows-x64 entry
- **WHEN** a release completes for which the `build-windows` job succeeded
- **THEN** `manifest.json.platforms["windows-x64"]` exists and contains `filename`, `url`, `sha256`, and `size`
- **AND** `platforms["windows-x64"].filename` matches `^specrails-desktop-\d+\.\d+\.\d+-x64-setup\.exe$`

#### Scenario: Manifest reflects the most recent release
- **WHEN** the release for tag `v<version>` completes
- **THEN** `manifest.json.version === "<version>"` (no leading `v`)

#### Scenario: Manifest sha256 matches the published binary for every platform
- **WHEN** the consumer downloads the file referenced by `platforms[<key>].url` for any key in `platforms` and computes its sha256
- **THEN** the result equals `platforms[<key>].sha256`

#### Scenario: Manifest size matches the published binary for every platform
- **WHEN** the consumer issues `HEAD` on the file referenced by `platforms[<key>].url` for any key in `platforms`
- **THEN** the returned `Content-Length` equals `platforms[<key>].size`

### Requirement: Manifest is uploaded after all referenced binaries
The system SHALL upload every installer file referenced by `manifest.json` to its destination folder in `latest/` BEFORE uploading `manifest.json`. This ordering SHALL prevent a race in which a consumer reads a manifest referencing a binary that has not yet been published, regardless of how many platforms the manifest describes.

#### Scenario: Deploy step ordering for single-platform release
- **WHEN** the desktop-release deploy job runs and the manifest references only `darwin-arm64`
- **THEN** the `.dmg` file is fully uploaded to the FTP server before the `manifest.json` file is uploaded

#### Scenario: Deploy step ordering for multi-platform release
- **WHEN** the desktop-release deploy job runs and the manifest references both `darwin-arm64` and `windows-x64`
- **THEN** the `.dmg` file AND the Windows `.exe` file referenced by the manifest are both fully uploaded to the FTP server before `manifest.json` is uploaded
- **AND** the deploy job HEAD-verifies each referenced binary returns HTTP 200 before uploading `manifest.json`

#### Scenario: Deploy fails if a referenced binary cannot be verified
- **WHEN** a HEAD request on any binary referenced by the manifest returns non-200 during the deploy step
- **THEN** the deploy job fails and `manifest.json` is NOT uploaded

### Requirement: Manifest cache is short-lived
The system SHALL serve `manifest.json` from `latest/` with HTTP cache headers that prevent intermediate caches from returning a stale version to a consumer across releases. Cache-Control SHALL be set to `no-cache, must-revalidate`.

#### Scenario: Browser fetches manifest after new release
- **WHEN** a browser has previously fetched `manifest.json` before a release and fetches it again after the release
- **THEN** the browser receives the new manifest (not a cached prior version) assuming the server is reachable

### Requirement: Released filename includes the version
The `.dmg` filename published to both `latest/` and `v<version>/` SHALL contain the release version so that a consumer can derive the version by parsing the filename when the manifest is unavailable.

#### Scenario: Filename contains semver
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the `.dmg` filename matches the regular expression `^specrails-desktop-\d+\.\d+\.\d+-aarch64\.dmg$` and the captured version equals the release version

### Requirement: Windows installer filename includes the version and architecture
The Windows installer filenames published to both `latest/` and `v<version>/` SHALL contain the release version and architecture so that consumers can derive both by parsing the filename when the manifest is unavailable.

#### Scenario: NSIS filename contains semver and arch
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the NSIS installer filename matches the regular expression `^specrails-desktop-\d+\.\d+\.\d+-x64-setup\.exe$` and the captured version equals the release version

#### Scenario: MSI filename contains semver and arch
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the MSI filename matches the regular expression `^specrails-desktop-\d+\.\d+\.\d+-x64\.msi$` and the captured version equals the release version

### Requirement: Windows updates retain installer format
The Tauri update manifest SHALL provide NSIS and MSI entries for both Windows architectures. Each entry SHALL reference a non-empty paired installer and signature. Missing artifacts SHALL fail publication instead of substituting a different installer format.

#### Scenario: MSI installation checks for an update
- **WHEN** an MSI-installed app resolves its platform update
- **THEN** it receives the MSI update for its architecture

#### Scenario: NSIS artifact is missing
- **WHEN** release inputs omit an NSIS installer or its signature
- **THEN** update manifest generation fails before publishing a new latest manifest

### Requirement: Windows installed package is smoke tested
The release workflow SHALL install and exercise Windows packages on both architectures before publishing their artifacts, validating sidecar startup, database/API access, native terminal dependencies and bundled runtimes. Installers SHALL provision WebView2 when absent.

#### Scenario: Native dependency is omitted from the package
- **WHEN** the installed package cannot load its database or terminal dependency
- **THEN** the Windows release smoke fails and prevents publication

