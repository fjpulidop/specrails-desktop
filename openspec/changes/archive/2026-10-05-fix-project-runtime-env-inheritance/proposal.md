## Why

A multi-repository Implement run aborts before tests because Yarn cannot resolve a project-configured NODE_AUTH_TOKEN. Desktop can permanently cache a failed login-shell lookup and omit project environment recovery from retained runtime controls; recovering credentials into the global process also exposes them to unrelated projects.

## What Changes

- Resolve the account's login shell when GUI startup does not supply SHELL.
- Recover only the project's configured names into a scoped, bounded-lived environment overlay, with retries after failed lookups and no secret persistence or logging.
- Apply the same project environment policy to new rails and retained runtime controls, including multi-repository runs.
- Add regression coverage with fictitious values and real subprocess verification.

## Capabilities

### New Capabilities
- `project-runtime-environment`: Project-scoped runtime environment inheritance and login-shell recovery for rails and continuations.

### Modified Capabilities
None.

## Impact

Desktop path resolution, project environment assembly, runtime controls, their tests and narrow configuration documentation. Existing project settings remain a names-only list shared by repositories in that project. Core's environment inheritance contract is already sufficient; no Core source or dependency change is planned.
