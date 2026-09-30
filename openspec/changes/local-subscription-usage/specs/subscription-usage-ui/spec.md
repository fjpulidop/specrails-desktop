## ADDED Requirements

### Requirement: Footer usage menu
The UI SHALL display a Usage label in the shared footer bar in both board and mission modes, rather than the left sidebar. Hover, keyboard focus and click SHALL open a viewport-bounded menu above the footer with Claude and Codex cards. Opening SHALL request refresh while preserving cached data and service cooldowns. The menu SHALL remain open while the pointer moves into it, and dismiss on pointer departure, Escape or outside interaction. Mission mode SHALL use minimal status chrome without spending polling.

#### Scenario: Hover provider cards
- **WHEN** the user hovers Usage and moves into the menu
- **THEN** the menu remains visible with distinct provider quotas

#### Scenario: Both modes
- **WHEN** the user switches between board and mission
- **THEN** Usage remains available in the footer

### Requirement: Always detailed consumption view
The UI SHALL always use the detailed presentation, ignore old Compact preferences, and expose no view selector. It SHALL show every available window separately and explicitly label consumed quota. The UI SHALL NOT average windows/providers or invent a remaining allowance. Reported plan SHALL appear only when known.

#### Scenario: Detailed provider row
- **WHEN** a provider has session, weekly and model-specific windows
- **THEN** the row displays each label, known percentage, reset information and freshness without hiding any window

#### Scenario: Previous compact preference
- **WHEN** an older installation has saved a Compact preference
- **THEN** all windows still show percentages, bars and reset information, without a Detailed/Compact selector

### Requirement: Truthful loading and unavailable states
The UI SHALL distinguish initial loading, refreshing with cached data, signed-out, unsupported auth/CLI/platform, unknown measurement and transient failure. Unknown percentage SHALL have no determinate progress bar or numeric ARIA value; real zero SHALL display 0%. No-window local engines SHALL not display synthetic subscription usage.

#### Scenario: Unknown percentage
- **WHEN** a window's percentage is null
- **THEN** the UI displays an em dash with a localized unavailable description rather than 0%

#### Scenario: Failure with prior data
- **WHEN** a refresh fails transiently for a verified unchanged account
- **THEN** the previous measurements stay visible with neutral stale styling, observation time and a refresh failure description

#### Scenario: User is signed out
- **WHEN** no local subscription login is available
- **THEN** the row explains signing in with the existing CLI and refreshing, without implying an in-app login or account switcher exists

### Requirement: Freshness and actionable refresh
The UI SHALL display last successful update, localized relative reset times and absolute local reset dates/timezone in details. Passed reset times SHALL request confirmation without altering measurements. Refresh controls SHALL show busy/cooldown information and respect service retryAt. Numeric warning styling SHALL use fresh known values: warning from 80%, destructive from 90%, limit reached at 100%; the sidebar warning indicator SHALL begin at 90%.

#### Scenario: Stale high usage
- **WHEN** a cached 95% measurement is stale
- **THEN** the value remains readable with an explicit stale label and neutral styling and does not activate the current sidebar warning indicator

#### Scenario: Reset occurs
- **WHEN** a known reset time passes before a fresh snapshot arrives
- **THEN** the UI displays a refresh-to-confirm message instead of a negative countdown or simulated zero

### Requirement: Settings usage uses app modal
Subscription usage SHALL remain accessible inside the existing global settings modal, showing full windows, reset dates and observation times. Neither the popover nor the settings panel SHALL contain View details or Manage providers buttons.

#### Scenario: Open usage settings
- **WHEN** the user selects Subscription usage in global settings
- **THEN** the modal shows the detailed usage panel without changing project route or losing provider draft edits

### Requirement: Shared visible-demand client lifecycle
The client SHALL share a host-scoped usage store across mounted consumers, cancel subscriptions/timers when unused or hidden, and use global API origin/auth conventions. Automatic refresh SHALL be eligible every 120 seconds while visible; snapshot polling SHALL run every 30 seconds while idle and every second during refresh for at most 30 seconds. Delayed GET responses SHALL NOT overwrite newer revisions or account generations.

#### Scenario: Hidden app
- **WHEN** the document is hidden or no usage surface is mounted
- **THEN** client usage polling and automatic refresh scheduling stop, resuming with freshness checks when visible again

#### Scenario: Out-of-order snapshots
- **WHEN** an older GET response arrives after a newer revision or account generation is installed
- **THEN** the shared store retains the newer snapshot

### Requirement: Theme, language and assistive technology support
The UI SHALL use existing theme tokens, UI primitives and all supported locale namespaces; render usable layouts at 200% zoom and with long translations; respect reduced motion; and provide visible focus, named progress bars and a polite refresh status announcement. Color SHALL NOT be the sole communication of quota status.

#### Scenario: Accessible progress
- **WHEN** a screen reader focuses a known weekly consumption window
- **THEN** it receives provider/window name and consumed percentage, while countdown ticks do not repeatedly interrupt announcements

#### Scenario: Theme and zoom
- **WHEN** a user changes theme or increases zoom to 200%
- **THEN** text/actions remain readable and reachable without clipped essential values
