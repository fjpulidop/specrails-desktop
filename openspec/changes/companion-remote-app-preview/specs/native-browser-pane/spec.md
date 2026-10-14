## MODIFIED Requirements

### Requirement: Localhost and private addresses are navigable in the native pane
The native pane SHALL allow navigation to loopback/private-network http(s) URLs (e.g. `http://localhost:5173`), since browsing happens client-side in the user's own webview. The server-side screencast path SHALL keep its existing SSRF guard for every session. The one exception is a companion preview session, which MAY navigate to a loopback origin only while that origin is announced as a preview target by a running background process of the same project (see `companion-app-preview`).

#### Scenario: Dev-server preview
- **WHEN** the user navigates the native pane to `http://localhost:4201`
- **THEN** the page renders

#### Scenario: Screencast session keeps the guard
- **WHEN** a regular server-side screencast session is asked to navigate to `http://localhost:4201`
- **THEN** the navigation is rejected

#### Scenario: Companion preview of an announced origin
- **WHEN** a companion preview session navigates to `http://localhost:5173/` and a running process of that project announced that origin
- **THEN** the navigation is allowed
