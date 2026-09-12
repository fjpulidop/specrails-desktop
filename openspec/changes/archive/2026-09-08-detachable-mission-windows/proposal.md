## Why

Users need to keep multiple missions visible, including on different monitors, while continuing to use the board or another mission in Specrails. Moving a conversation between integrated and separate views must preserve the running agent and unsent input.

## What Changes

- Add a detach action beside the conversation menu in mission and board views, and a reintegrate action in separate native mission windows.
- Allow multiple independent mission windows with native minimize, maximize/restore, resize and monitor movement on macOS and Windows.
- Closing a mission window reintegrates its conversation into the main interface without stopping the agent. Integrated remains the default.
- Transfer drafts, references, attachments and view state with acknowledgement before relinquishing the source view; focus an existing window instead of duplicating a mission.
- Scope native browser ownership, popups, permissions and lifecycle by application window.

## Capabilities

### New Capabilities
- `detachable-mission-windows`: Conversation window ownership, state transfer, window controls and failure recovery.
- `mission-window-native-tools`: Trusted mission interfaces and their independently owned native browsers/popups.

### Modified Capabilities

None. Existing mission execution and board behavior continue through the shared backend.

## Impact

Tauri window management, invoke guards, capabilities, browser ownership and close handling; React application composition, agent conversation headers, drafts, workspace state and cross-window coordination; all supported locales and native/client regression fixtures. No second backend, provider invocation or project database is created by detaching a mission.
