## Why

Specrails currently exposes integrations as a project-scoped sidebar page. That worked while Jira and Serena were the only integrations, but it does not fit global plugins such as Headroom AI, and it hides important setup flows behind a project context. Users need a single polished plugin center that makes plugin scope obvious, supports project-local install wizards, and handles global install/activation with guided recovery when the environment fails.

Headroom AI also needs a transparent installation path. Specrails should bundle `uv` like the existing Node/Git/GitHub CLI runtimes, install Headroom into a Specrails-owned tool area, and activate routing per platform without requiring the user to copy terminal commands.

## What Changes

- Add a global `Plugins` section below `Loops` in the left sidebar for both Board and Mission mode.
- Replace the project-right-sidebar `Integrations` section with a global plugin center. Existing `/integrations` routes remain as compatibility redirects to `/plugins`.
- Present plugins as a catalog with clear scope:
  - `Global`: Headroom AI.
  - `Project`: Jira and Serena.
- Add project-selection wizards for Jira and Serena installs. Jira reuses the existing Jira connection flow after project selection; Serena reuses the project plugin installer after selecting a target project.
- Add Headroom AI global plugin management:
  - install using bundled `uv tool install "headroom-ai[all]"`;
  - keep install and activation separate;
  - activate independently for Codex and Claude;
  - use a Specrails-managed proxy/env routing path for in-app/headless spawns;
  - expose optional system-wide activation only as an explicit advanced action.
- Add bundled `uv` runtime support to release/local packaging, path resolution, prerequisite detection, and smoke tests.
- Add guided error handling for install, activation, proxy health, route verification, rollback, and diagnostics.

## Impact

- **Client:** new `PluginsPage`, sidebar entry, Mission modal path, polished plugin cards, project plugin wizard, Headroom status/actions, i18n strings.
- **Server:** new global plugins router/service, Headroom manager, global plugin state persisted in `desktop_settings`, spawn env routing for Codex/Claude, project plugin aggregation endpoints.
- **Runtime packaging:** bundle `uv` in macOS/Windows release jobs, local assembler, runtime resolver, smoke tests, and setup-prerequisites.
- **Existing integrations:** Jira and Serena move from project-right-sidebar integration UX into the global plugin center while keeping their project-local backend semantics.
- **Compatibility:** `/integrations` redirects to `/plugins`; existing project plugin APIs remain available for backward compatibility.
