## ADDED Requirements

### Requirement: Managed Claude sessions register required OpenSpec commands

Specrails SHALL explicitly register the official OpenSpec commands required by its managed Claude agents before invoking a pipeline or lifecycle step that uses them. Registration SHALL use application-owned packaged assets with the required command namespace, and SHALL work in both development and packaged desktop installations independently of the user's global plugin enablement.

#### Scenario: Architect invokes OpenSpec without globally enabled plugin
- **WHEN** a managed Claude implementation step starts with no corresponding OpenSpec plugin enabled in the user's Claude settings
- **THEN** the spawned session SHALL have the required `opsx:ff` command registered from application-owned assets
- **AND** the architect SHALL NOT need to copy skill files into the project or change global plugin settings

#### Scenario: Packaged execution preserves other provider options
- **WHEN** a packaged installation prepares a managed Claude process with model, effort, MCP, and existing plugin options
- **THEN** required OpenSpec registration SHALL be added while preserving those options
- **AND** asset resolution SHALL use resources shipped with the application

### Requirement: Missing required skill assets fail before invocation

If a required OpenSpec asset cannot be prepared, Specrails SHALL surface an actionable local preparation error before launching that managed provider invocation. It MUST NOT silently proceed with an unresolved required skill or modify a user repository as an installation fallback.

#### Scenario: Required packaged assets are unavailable
- **WHEN** preparation cannot locate or construct the required application-owned OpenSpec plugin
- **THEN** the invocation SHALL fail before spawning the paid provider process
- **AND** the failure SHALL identify the unavailable managed skill resources
- **AND** the implementation repositories SHALL remain unmodified by skill setup
