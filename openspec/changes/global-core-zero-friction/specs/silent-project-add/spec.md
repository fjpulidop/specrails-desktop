# silent-project-add

## ADDED Requirements

### Requirement: Add Project collects only the path

The Add Project flow SHALL request exactly one user input: the project path (Existing) or the Builder flow (New). The prerequisites gate (`PrerequisitesPanel`) SHALL remain. No provider selection, no agent/model configuration, no install tier, and no wizard step SHALL be presented. The multi-step `SetupWizard` UI (Configure / Install / Done) SHALL NOT exist.

#### Scenario: Adding an existing project
- **WHEN** the user enters a valid path and clicks Add with prerequisites satisfied
- **THEN** the dialog closes, the project is registered immediately, and no wizard screen appears

#### Scenario: Prerequisites still gate submission
- **WHEN** a required tool (node/git) is missing
- **THEN** the Add submit stays disabled with the existing missing-prerequisite surface

### Requirement: Registration is immediate, assembly is background

`POST /api/projects` SHALL register the project (desktop.sqlite + registry.json) and return before workspace assembly. The server SHALL then assemble the relocated workspace offline from the bundled framework for every detected provider, sequentially, in the background. The project SHALL be navigable immediately after registration; surfaces that need the workspace SHALL render loading states until assembly completes.

#### Scenario: Project usable during assembly
- **WHEN** registration succeeds and assembly is still running
- **THEN** the project appears in the project list and can be opened, with workspace-dependent surfaces in a loading state

#### Scenario: Assembly requires no network
- **WHEN** the bundled framework is present
- **THEN** assembly performs no `npx` invocation and completes offline

### Requirement: Assembly progress and failure are surfaced without a wizard

The server SHALL broadcast app-level progress `project.assemble_progress` (`{ projectId, provider, status: 'running' | 'done' | 'failed' }`). The client SHALL render at most a subtle indicator (project card spinner → ready state). A per-provider assembly failure SHALL leave the project usable with the providers that succeeded, badge the project with a non-blocking warning, and offer a retry action. A failure of every provider SHALL keep the project registered with a retry affordance — registration is never rolled back by assembly failure.

#### Scenario: One provider fails
- **WHEN** claude assembly succeeds and codex assembly fails
- **THEN** the project works with claude, a warning badge names codex, and retry re-runs only the failed provider

#### Scenario: Silent success
- **WHEN** all providers assemble successfully
- **THEN** the only UI evidence is the card indicator reaching its ready state — no modal, no log screen

### Requirement: Wizard-resident hints re-home

The Jira CTA and the MCP / agent-chat hints previously rendered in the wizard's Done step SHALL be reachable without the wizard: the Jira connect flow remains available in project Settings, and the one-line hints render on WelcomeScreen and/or first-visit surfaces. No hint SHALL block or interrupt the add flow.

#### Scenario: Jira still discoverable
- **WHEN** a user who just added a project wants to connect Jira
- **THEN** the Jira connect wizard is reachable from project Settings and a WelcomeScreen hint points there
