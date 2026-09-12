## ADDED Requirements

### Requirement: Repository-scoped code identity
Code Explorer, Git reads, provenance and summaries SHALL distinguish files by repository identity as well as relative path. Existing primary REST routes SHALL remain compatible, and explicit repository routes SHALL enforce membership and root containment.

#### Scenario: Identical relative file paths
- **WHEN** two members both contain `src/index.ts`
- **THEN** their content, summaries, provenance and cached scans SHALL remain separate

#### Scenario: Select a repository in Code Explorer
- **WHEN** the user changes the selected repository
- **THEN** the tree and selected file SHALL resolve within that member without displaying a stale file from another repository

### Requirement: Project-wide mission discovery
The mission agent and MCP SHALL expose the project repository inventory. Bounded search SHALL be able to discover across members under one aggregate limit, and results and saved file/Git references SHALL carry `repositoryId`. Specific file or Git operations in multi-repository MCP context SHALL require an unambiguous member.

#### Scenario: Discover a backend file
- **WHEN** the mission searches the shared project for a symbol found in a secondary repository
- **THEN** results SHALL include that repository ID and allow a subsequent scoped read without creating another project

#### Scenario: Ambiguous read
- **WHEN** a multi-repository mission requests a relative file without identifying its repository
- **THEN** the tool SHALL request an explicit member through a structured error and inventory rather than guess

#### Scenario: Restore a saved reference
- **WHEN** a mission draft containing a file reference is restored
- **THEN** the reference SHALL retain its original project and repository identity
