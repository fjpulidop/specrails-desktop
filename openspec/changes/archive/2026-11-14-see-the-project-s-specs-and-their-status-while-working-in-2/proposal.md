# Proposal

## Why

Inside a mission the user cannot see which specs the project has or their status without asking the agent (a turn, and a stale snapshot) or leaving for the Specs board. The branch adds a read-only Specs side pane to Mission mode. The same branch also carries three further changes the user asked for: the Fable alias moved to 5.2, GitHub clone support when adding projects/repositories, and per-area accent colours with layered surfaces and fully hidden sidebars.

## What Changes

- New Specs pane in the Mission mode right toolbar: lists the whole backlog of the mission's project with status, open specs first, done/cancelled folded; opens the existing ticket modal on click; specs can be dragged into the composer as a reference and are hidden while in that draft; newly created specs animate in.
- The Specs pane is exclusive with Jobs, Files and Analytics and disabled without a pinned project; all four panes get a 48px header, a full-height resize handle and text-selection blocking only during drag.
- The `fable` alias now resolves to `claude-fable-5-2`; pricing reuses the 5.1 rate provisionally.
- GitHub clone endpoint and a clone dialog used from Add Project and project repositories settings.
- Area accent colours, layered surfaces (title bar darkest, centre intermediate, sidebars lightest), sidebars hidden entirely with no icon rail, sidebar headers removed.
- Locale strings in 8 languages, docs and the source map updated.

## Capabilities

### New Capabilities

### Modified Capabilities
- `mission-specs-pane`: Specs side pane in Mission mode; the layout requirement now covers all side panes.
- `fable-model-alias`: Fable alias points to Fable 5.2.
- `github-repository-clone`: clone a GitHub repository to a chosen destination.
- `app-area-chrome`: area accents, surface layering and fully hidden sidebars.

## Impact

Client (missions, projects, settings, shell, styles, locales), server (desktop router, GitHub clone, pricing, Claude adapter, spec models), docs and OpenSpec archive files.
