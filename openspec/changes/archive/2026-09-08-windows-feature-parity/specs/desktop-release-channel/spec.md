## ADDED Requirements

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
