# Spec Delta

## MODIFIED Requirements

### Requirement: Filter limits missions to live ones
While the filter is on, Favorites, Home and every project group SHALL list only missions within the selected archive scope that the sidebar already marks live (a turn streaming or agents working in the background), subject to the existing open-mission exception. Missions that are only awaiting a decision or failed are not included unless also live or open. Changing either filter SHALL NOT reset the other.

#### Scenario: Filter on
- **WHEN** some missions are live and the filter is turned on
- **THEN** every group lists only the live missions within the selected archive scope, subject to the open-mission exception

#### Scenario: Filter off restores the list
- **WHEN** the filter is turned off
- **THEN** all missions within the selected archive scope are listed again in their original order

#### Scenario: Independent archive scope
- **WHEN** Archived is selected while live-only is on
- **THEN** only archived missions satisfying live-only or its open-mission exception remain
- **AND** changing archive scope does not turn live-only off, and changing live-only does not alter archive scope

### Requirement: Open mission stays visible
While the filter is on, the currently open mission SHALL remain listed in its group even when it is not live, provided it belongs to the selected archive scope. The open-mission exception SHALL NOT bypass archive scope.

#### Scenario: Open idle mission
- **WHEN** the filter is on and the open mission is not live but belongs to the selected archive scope
- **THEN** that mission is still listed

#### Scenario: Open archived mission outside Active
- **WHEN** Active is selected and an archived mission is open
- **THEN** the archived mission is excluded from the sidebar even under the open-mission exception
