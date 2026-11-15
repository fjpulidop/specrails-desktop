# Spec Delta

## Purpose

Lets a user add a repository by cloning it from GitHub.

## ADDED Requirements

### Requirement: Clone a GitHub repository to a chosen destination
The app SHALL clone a GitHub repository (owner/repo, https or ssh URL) to a user-chosen destination without a shell, reject unsupported or credential-bearing sources, and return the checkout path without registering a project.

#### Scenario: Successful clone
- **WHEN** the user submits a valid GitHub source and destination
- **THEN** the repository is cloned there and its path is returned

### Requirement: Existing folders are not overwritten
The clone SHALL never write into or delete an existing destination, SHALL reject concurrent reservations of the same destination, and on failure SHALL clean up only its own partial checkout.

#### Scenario: Existing destination
- **WHEN** the destination already exists
- **THEN** it is untouched and the clone is rejected
