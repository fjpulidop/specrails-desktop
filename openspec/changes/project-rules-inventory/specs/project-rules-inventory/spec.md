## ADDED Requirements

### Requirement: Project settings show the rules inventory

Project settings SHALL show the project's `.specrails/rules.json`: gates, rules grouped by status (including `unclassified`), counts and why rules are not classified when `classification.status` says so, and SHALL offer **Re-run inventory** when the active Core announces `rulesInventory: 1`. Without the capability the panel SHALL say Core must be updated and SHALL refuse writes with 409; a missing or invalid file SHALL be reported as such.

#### Scenario: Re-run
- **WHEN** the user clicks Re-run inventory
- **THEN** Desktop runs Core's inventory for the project and shows the new file, or the command output when it fails

### Requirement: Automatable rules become specs in one click

For a rule with status `automatable`, addressed by its Core id, **Create spec** SHALL create a ticket with source `rules`, describing the rule, its source and the proposed check, with non-goals. Other statuses SHALL be refused.

#### Scenario: Create spec
- **WHEN** the user creates a spec from "Frontend API calls use getApiBase()"
- **THEN** a `todo` ticket titled "Enforce: Frontend API calls use getApiBase()" with source `rules` appears on the board

### Requirement: Human-only rules appear in the review packet

At settle, Desktop SHALL copy the project's `humanOnly` rules into the delivery evidence and the review packet SHALL list them under **Needs human eyes**.

#### Scenario: Packet reminder
- **WHEN** a delivery settles in a project with two human-only rules
- **THEN** its packet lists both rules with their source

### Requirement: Gates are the default verification suggestions

When Core announces `rulesInventory: 1`, the verification suggestions SHALL list the inventory's plain gate commands first, de-duplicated against detected commands, and SHALL skip gates that need a shell.

#### Scenario: Project without checks
- **WHEN** a project with an `npm run lint` gate opens the verification suggestions
- **THEN** `npm run lint` is the first suggestion
