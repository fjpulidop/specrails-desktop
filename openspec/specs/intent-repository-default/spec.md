# intent-repository-default Specification

## Purpose
Defines where an Intent session runs in a project with several Git repositories when nobody names one.

## Requirements

### Requirement: No one named a repository
When neither the spec, the mission agent nor the person names a repository, an Intent SHALL run in the Git primary, else in the repository of the project's last Intent, else in the first Git member, without asking.

#### Scenario: No one named a repository
- **WHEN** an Intent starts without a repository in a workspace with several Git members
- **THEN** it runs in the last Intent's repository, or in the first Git member when there is none

### Requirement: The entry never asks
The Intent entry card SHALL show the chosen repository on one line with a Change action and SHALL NOT block the start on a repository choice.

#### Scenario: The entry never asks
- **WHEN** the entry card opens in a workspace and no one named a repository
- **THEN** it shows "Runs in" the default repository and Start is enabled

### Requirement: The agent places the work
A settled intent card SHALL carry the repository the agent placed the work in (several Git repositories), and Explore SHALL start the Intent there.

#### Scenario: The agent places the work
- **WHEN** a settled intent card carries a repositoryId
- **THEN** Explore opens the entry with that repository chosen
