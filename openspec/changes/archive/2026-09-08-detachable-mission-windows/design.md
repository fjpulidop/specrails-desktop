## Context

Mission and board conversation bodies share AgentConversationView. Agent execution, transcript and pending/live snapshots already live in one backend. Composer drafts are currently module-local Maps; workspace panels and scroll state are local React state. Tauri trusts only `main`, intercepts every window close as hide-to-tray, and has a single native browser owner attached to main.

## Goals / Non-Goals

**Goals:** Multiple independent native mission windows on macOS and Windows; one editable owner per conversation; acknowledged detach/reattach preserving unsent work and live execution; usable workspace tools and correct close semantics.

**Non-Goals:** Multiple backend instances, duplicating provider work, separate databases, editing code in the explorer, or claiming real-Windows validation from a macOS run. Browser-only development must remain usable and must not advertise unavailable native window operations.

## Decisions

1. A Rust registry owns native mission windows and transfer revisions. Windows are independent top-level application windows, not owned children of main. Creating one never starts another sidecar. Default placement is integrated; existing detached missions are focused rather than opened twice.
2. Use the existing frontend bundle with a dedicated mission-window entry context and shared conversation/workspace components. Each secondary is pinned to its mission and project; main navigation cannot repin it. Global updater/notifications/administration remain on main.
3. Transfer bounded, versioned view snapshots containing composer text, inline reference offsets, uploaded attachment descriptors, scroll and workspace state. Freeze the source during handoff; the destination hydrates backend state and acknowledges restoration before ownership changes or the secondary is destroyed. Late acknowledgements are rejected by revision. Failed or timed-out transfers keep a usable source and recoverable draft.
4. Native close requests on a mission trigger the same reintegration path as its toolbar action. Main retains hide-to-tray behavior. Browser popups close and release their ownership slot. A real app exit continues to shut down the one backend intentionally.
5. Register exact trusted mission webviews in Rust and grant only the needed native capabilities. Remote browser children and popups remain denied privileged app IPC. Native browser ownership and event delivery become window-scoped. Browser/session transfer uses supported reparenting where practical; preserve session data and report failures rather than transferring to an unrelated window.
6. Keep window controls consistent with each OS, including dynamic maximize/restore state, minimum sizes, resize and monitor/DPI changes. Add translated detach/reattach labels and a clear main-window placeholder for an externally hosted conversation.

## Risks / Trade-offs

- Separate renderers have independent React memory → explicit snapshot/ack protocol and recovery rather than relying on shared JS Maps.
- Live events race initial history fetches → reuse backend reconciliation and guard handoffs by conversation and revision.
- Browser ownership and close handlers currently assume main → classify windows explicitly and regression-test popup cleanup as well as mission transfer.
- Secondary frontend setup can fail → keep source state until destination acknowledgement and allow retry.
- Native differences require real platform runs → local macOS fixture plus Windows CI gates, with honest verification records.

## Migration Plan

No database migration is required for window placement. Existing missions remain integrated. The feature is available only when the native host supports its commands; browser development retains the integrated view. Preserve existing branch work and validate shared server/client behavior after integration.
