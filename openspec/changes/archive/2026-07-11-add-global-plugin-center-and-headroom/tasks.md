## 1. OpenSpec and architecture

- [x] 1.1 Capture proposal/design/spec/tasks for the global plugin center and Headroom runtime model.

## 2. Bundled uv runtime

- [x] 2.1 Add bundled `uv` path resolution and prerequisite detection.
- [x] 2.2 Add `uv` to local runtime assembly.
- [x] 2.3 Add `uv` download/extract/smoke checks to macOS and Windows release jobs.
- [x] 2.4 Extend bundled runtime smoke tests to execute `uv --version`.

## 3. Headroom backend

- [x] 3.1 Add global plugin settings/state helpers backed by `desktop_settings`.
- [x] 3.2 Implement Headroom manager: install, status, proxy lifecycle, activate/deactivate per provider, diagnostics.
- [x] 3.3 Add global plugins API endpoints.
- [x] 3.4 Add shared Headroom spawn env routing for Codex/Claude process launches.
- [x] 3.5 Add structured error classification and repair/retry responses.

## 4. Plugin center UI

- [x] 4.1 Add global `/plugins` page with premium catalog layout, installed strip, search, scope filters, and status cards.
- [x] 4.2 Add sidebar `Plugins` entry below `Loops` and Mission-mode modal behavior.
- [x] 4.3 Remove project-right-sidebar `Integrations`; redirect `/integrations` to `/plugins`.
- [x] 4.4 Add Headroom global plugin detail/actions with install/activate/deactivate/change-port/diagnostics flows.
- [x] 4.5 Add Jira project-selection wizard and reuse existing Jira connection flow.
- [x] 4.6 Add Serena project-selection wizard and reuse project plugin install/preview/verify flow.

## 5. Tests and verification

- [x] 5.1 Add backend tests for Headroom routing and activation env state.
- [x] 5.2 Add client tests for plugin center filters/wizards and Headroom error guidance.
- [x] 5.3 Run typecheck, targeted tests, build, and visual verification.
