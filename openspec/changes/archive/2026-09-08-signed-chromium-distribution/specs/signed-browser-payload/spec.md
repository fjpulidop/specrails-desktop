## ADDED Requirements

### Requirement: macOS browser payload has a verified distribution identity
Release assembly MUST sign all Chromium code with a consistent Developer ID identity and the required role-specific policy, then notarize and staple the browser before archiving it.

#### Scenario: Missing credentials or rejected notarization
- **WHEN** release assembly lacks usable signing/notarization credentials or Apple does not accept the browser
- **THEN** the build SHALL fail without producing an accepted release payload.

### Requirement: New archives are transparent and preserve browser structure
New builds SHALL produce transparent archives preserving framework symlinks. Runtime resolution SHALL continue reading legacy encoded archives and prefer transparent archives when both exist.

#### Scenario: Upgrade from an encoded archive
- **WHEN** a new transparent bundle replaces a legacy browser payload
- **THEN** resolution SHALL extract the new payload and preserve the executable and framework links.

### Requirement: Browser acceptance exercises the shipped code
Release verification SHALL extract the shipped archive, verify macOS signatures and notarization, and exercise browser rendering with the production sandbox enabled on macOS and Windows.

#### Scenario: Browser executable starts but cannot render
- **WHEN** extracted Chromium cannot execute page JavaScript or render the fixture
- **THEN** verification SHALL fail and block publication.

### Requirement: Validation builds cannot publish
The release workflow SHALL provide a validation-only mode that builds artifacts from the exact verified repository revision without modifying GitHub releases or download channels.

#### Scenario: Successful validation-only build
- **WHEN** all signed installer checks pass in validation-only mode
- **THEN** artifacts SHALL be retained and every publication job SHALL remain skipped.
