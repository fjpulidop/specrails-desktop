# Add Integrations entry to the Agent Mode sidebar with a full-size modal

## Why
Agent Mode users can reach Jobs, Browser, Terminal, and Files from the right workspace sidebar, but Integrations is only available through board mode navigation. That forces users to leave the current agent chat/session context just to manage existing integrations.

## What changes
- Add an Agent Mode right-sidebar Integrations tool immediately after Files when provider visibility allows it.
- Add workspace context state and a toggle for the Agent Mode integrations modal.
- Render the existing IntegrationsPage content inside a new near-fullscreen, movable, resizable modal from Agent Mode.
- Preserve board mode Integrations routing and the existing small install/uninstall confirmation modals inside IntegrationsPage.

## Impact
- Affected specs: agent-mode-integrations
- Affected code: Agent Mode sidebar wiring, AgentWorkspaceContext state, AgentModeSurface conditional rendering, and a new AgentIntegrationsModal component that wraps the existing IntegrationsPage content with the established movable/resizable modal chrome.
- Out of scope: Board mode's existing Integrations nav link and page routing; the small install/uninstall confirmation ModalShell inside IntegrationsPage; new integration providers.
