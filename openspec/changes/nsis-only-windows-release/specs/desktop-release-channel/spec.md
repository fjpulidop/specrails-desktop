## MODIFIED Requirements

### Requirement: Stable "latest" download URL for Windows build
The system SHALL publish the most recent Windows x64 installer for specrails-desktop to a stable, version-independent URL at `https://specrails.dev/downloads/specrails-desktop/latest/`. The Windows installer SHALL be the same artifact published to the versioned folder for the corresponding tag. Windows releases SHALL ship only the NSIS installer. The v1 Windows installer MAY be unsigned; Authenticode code-signing is not required by this requirement.

#### Scenario: Tag push publishes Windows installer to latest folder
- **WHEN** a commit tagged `v<version>` is pushed and the `Desktop Release` workflow completes successfully
- **THEN** a file named `specrails-desktop-<version>-x64-setup.exe` exists at `https://specrails.dev/downloads/specrails-desktop/latest/` and returns HTTP 200

#### Scenario: Latest Windows installer matches versioned file
- **WHEN** both the `latest/` and the corresponding `v<version>/` folder have been populated by the same workflow run
- **THEN** the `.exe` binaries at both locations have identical sha256 hashes

#### Scenario: Subsequent release replaces latest Windows installer
- **WHEN** a newer tag `v<version+1>` is released
- **THEN** `https://specrails.dev/downloads/specrails-desktop/latest/specrails-desktop-<version+1>-x64-setup.exe` is served
- **AND** any prior Windows installer left in `latest/` from a previous release, including a legacy `.msi`, SHALL NOT be served from that folder

### Requirement: Versioned download URL for Windows build remains available
The system SHALL publish each released Windows NSIS installer (`.exe`) to its version-specific folder `https://specrails.dev/downloads/specrails-desktop/v<version>/` for archival and deep linking.

#### Scenario: Versioned Windows URL remains reachable after new release
- **WHEN** a new release is published and `latest/` has been updated
- **THEN** the previous release's Windows `.exe` at `https://specrails.dev/downloads/specrails-desktop/v<previous-version>/specrails-desktop-<previous-version>-x64-setup.exe` still returns HTTP 200

### Requirement: Windows installer filename includes the version and architecture
The Windows installer filenames published to both `latest/` and `v<version>/` SHALL contain the release version and architecture so that consumers can derive both by parsing the filename when the manifest is unavailable.

#### Scenario: NSIS filename contains semver and arch
- **WHEN** the release for tag `v<version>` publishes
- **THEN** the NSIS installer filename matches the regular expression `^specrails-desktop-\d+\.\d+\.\d+-x64-setup\.exe$` and the captured version equals the release version

### Requirement: Windows installed package is smoke tested
The release workflow SHALL install and exercise the Windows NSIS package on both architectures before publishing its artifacts, validating sidecar startup, database/API access, native terminal dependencies and bundled runtimes. The installer SHALL provision WebView2 when absent, downloading it through the embedded bootstrapper.

#### Scenario: Native dependency is omitted from the package
- **WHEN** the installed package cannot load its database or terminal dependency
- **THEN** the Windows release smoke fails and prevents publication

#### Scenario: A stale MSI bundle target reappears
- **WHEN** the Windows build produces an MSI bundle
- **THEN** the Windows release smoke fails and prevents publication

## REMOVED Requirements

### Requirement: Windows updates retain installer format
**Reason**: Windows no longer ships MSI packages.
**Migration**: See "Windows updates migrate MSI installs to NSIS".

## ADDED Requirements

### Requirement: Windows updates migrate MSI installs to NSIS
The Tauri update manifest SHALL provide `windows-<arch>-nsis` and `windows-<arch>` entries for both Windows architectures, both referencing the NSIS installer, and SHALL NOT provide `windows-<arch>-msi` entries. Each entry SHALL reference a non-empty paired installer and signature. Missing artifacts SHALL fail publication.

#### Scenario: MSI installation checks for an update
- **WHEN** an app installed from an earlier MSI release resolves its platform update
- **THEN** it falls back to the `windows-<arch>` entry and receives the NSIS update for its architecture
- **AND** the NSIS installer removes the WiX installation so a single installation remains

#### Scenario: NSIS artifact is missing
- **WHEN** release inputs omit an NSIS installer or its signature
- **THEN** update manifest generation fails before publishing a new latest manifest
