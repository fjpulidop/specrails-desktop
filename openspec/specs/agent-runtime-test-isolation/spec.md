# agent-runtime-test-isolation Specification

## Purpose
Keeps the agent-runtime bridge tests independent of the process that runs them.

## Requirements

### Requirement: Bridge tests ignore an inherited headless guard
The agent-runtime bridge tests SHALL strip only the `electron-headless-guard.cjs` `--require` entry that the host process already carries in `NODE_OPTIONS`, so they assert what the bridge itself adds and pass whether the suite runs from a plain shell or from inside Specrails.

#### Scenario: Suite run from a Specrails-hosted process
- **WHEN** the tests run with an inherited `--require …electron-headless-guard.cjs` in `NODE_OPTIONS`
- **THEN** the bridge assertions on `NODE_OPTIONS` see the same values as in a plain shell
