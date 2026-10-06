## MODIFIED Requirements

### Requirement: Agents tab
The Agents tab SHALL display a catalog segmented into Upstream and Custom. Upstream entries are the provider's baseline roles (`sr-architect`, `sr-developer`, `sr-reviewer`), defined by the specrails-core runtime and listed read-only with the runtime definition as their body; they do not correspond to files in `.claude/agents/`. Custom entries are the `custom-*` agents in the provider's native catalog and are editable. An "Open in Studio" action SHALL open a Custom agent in the Agent Studio.

#### Scenario: Upstream read-only
- **WHEN** the user selects `sr-developer`
- **THEN** a read-only viewer shows the role's description ("runtime-defined by specrails-core") and the current runtime definition body; no edit actions are offered

#### Scenario: Upstream shown without installed files
- **WHEN** the project has no `.claude/agents` directory
- **THEN** the Upstream segment still lists the three baseline roles and the Custom segment is empty

#### Scenario: Custom editable
- **WHEN** the user selects `custom-pentester`
- **THEN** an "Open in Studio" button and a "Version history" control are offered
