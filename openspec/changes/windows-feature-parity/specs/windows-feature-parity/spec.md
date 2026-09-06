## ADDED Requirements

### Requirement: Windows execution preserves user intent
Windows SHALL execute provider, loop, terminal, background process and Git operations using the intended executable, repository and exact arguments, including paths with spaces and non-ASCII characters. Stop actions SHALL terminate owned child work without terminating unrelated processes.

#### Scenario: Project path contains spaces
- **WHEN** a Windows user runs a job or opens a terminal in a repository whose path contains spaces
- **THEN** the command runs in that repository with arguments preserved and its owned processes can be stopped

#### Scenario: A background launcher exits before its application
- **WHEN** a Windows background command creates a long-running descendant and its intermediate launchers exit
- **THEN** the application remains visible as running and Stop terminates its contained descendants before confirming completion
- **AND** loss of the owning sidecar closes the containment and terminates the application
- **AND** containment setup failure prevents the user command from running

### Requirement: Windows filesystem workflows match desktop behavior
Project registration, persistence, repository browsing, search, summaries, plugins and framework updates SHALL handle Windows absolute paths, case rules and file replacement semantics without losing data or referring to a different repository.

#### Scenario: A registered Windows project is reopened
- **WHEN** the app restarts after a project or framework update
- **THEN** the same project, repositories and current framework state remain available

### Requirement: Native interactions support Windows
The Windows app SHALL support its native browser, authentication popups, file reveal/save interactions and terminal paste/drop behavior through supported platform APIs with truthful capability reporting.

#### Scenario: Authentication popup closes itself
- **WHEN** an authentication popup requests close after completing login
- **THEN** its native window and ownership state are released without closing the parent browsing session

### Requirement: Platform verification is explicit
CI SHALL execute Windows-sensitive regression checks on x64 and ARM64. Verification records SHALL distinguish executed checks, static review and remaining real-device checks.

#### Scenario: Local verification runs on macOS
- **WHEN** an audit is reported from a macOS workstation
- **THEN** its results do not claim a successful Windows installation unless the Windows checks were actually executed
