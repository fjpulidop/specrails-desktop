# ci-cd Specification

## Purpose
Define the continuous integration, release PR, and package publishing behavior for the desktop package.

## Requirements

### Requirement: CI runs on every push and pull request
The system SHALL run automated checks (typecheck and tests) on every push to any branch and on every pull request targeting `main`. Checks SHALL cover both root and client packages.

#### Scenario: Push to main triggers CI
- **WHEN** a commit is pushed to `main`
- **THEN** the `CI` workflow runs typecheck and tests for root and client packages

#### Scenario: Pull request to main triggers CI
- **WHEN** a pull request is opened or updated against `main`
- **THEN** the `CI` workflow runs and its status is reported on the PR

#### Scenario: CI fails on type error
- **WHEN** TypeScript compilation produces an error
- **THEN** the CI job fails and the PR cannot be merged (if branch protection is configured)

#### Scenario: CI fails on test failure
- **WHEN** any vitest test fails
- **THEN** the CI job fails

### Requirement: Release PR is created automatically on push to main
The system SHALL use release-please to analyze conventional commits since the last release and create or update a Release PR that bumps the version in `package.json` and updates `CHANGELOG.md`.

#### Scenario: feat commit triggers minor bump
- **WHEN** a commit with prefix `feat:` is merged to `main`
- **THEN** release-please creates or updates the Release PR with a minor version bump

#### Scenario: fix commit triggers patch bump
- **WHEN** a commit with prefix `fix:` is merged to `main`
- **THEN** release-please creates or updates the Release PR with a patch version bump

#### Scenario: Release PR reflects accumulated commits
- **WHEN** multiple commits have been pushed to `main` since the last release
- **THEN** the Release PR includes all of them in the CHANGELOG and picks the highest applicable bump

### Requirement: npm package is published on release merge
The system SHALL automatically publish the package to npm when the Release PR is merged.

#### Scenario: Release PR merge triggers publish
- **WHEN** the release-please Release PR is merged to `main`
- **THEN** the release workflow builds all packages and runs `npm publish`

#### Scenario: Publish uses NPM_TOKEN secret
- **WHEN** `npm publish` runs
- **THEN** it authenticates using the `NPM_TOKEN` repository secret

#### Scenario: Publish only runs when release is created
- **WHEN** a regular (non-release) commit is pushed to `main`
- **THEN** `npm publish` does NOT run
