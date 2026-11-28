## Why

With Tapflow installed and Test in Mobile Device in place (changes `add-tapflow-plugin`, `add-mobile-device-testing`), agents still cannot see or use a device, and an external client (Claude Code, Codex) driving Specrails through its MCP has no way to reach Tapflow. Phase 3 lets a mission agent verify the app it built on a real simulator, and makes "test it on mobile" one call from Specrails' MCP.

## What Changes

- **Managed MCP servers.** `server/external-mcp.ts` gains a registry of first-party servers (`registerManagedMcpServer`) that ride every mission spawn (Claude `--mcp-config`, Codex `-c`, file-based providers) while their plugin provides them, regardless of the person's external-server settings; a person's own server of the same name wins.
- **Tapflow for mission agents.** While Specrails runs Tapflow and holds its token, mission agents get `tapflow` (Tapflow's own MCP server, `@tapflowio/mcp-server`): devices, boot, install, launch, screenshots, UI tree, taps, flows.
- **Specrails MCP.** `specrails_integrations` treats `tapflow` as an app-global plugin (list with its phase, activate, deactivate, uninstall, install opens its interactive setup) and adds `mobile_test` (`options.delivery`, `options.platforms`), which starts Test in Mobile Device and returns the run ref to wait on.

## Capabilities

### New Capabilities
- `tapflow-agent-access`: Tapflow's tools for mission agents and Tapflow / mobile testing through Specrails' MCP.

### Modified Capabilities
<!-- None. -->

## Impact

- `server/external-mcp.ts` (registry), `server/modules/tapflow/runtime.ts` (registration), `server/mcp/v2/tools/integrations.ts` (+ i18n, docs reference).
