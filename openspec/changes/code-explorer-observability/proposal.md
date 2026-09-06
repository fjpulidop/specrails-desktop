## Why

Files should help users explore a multi-repository project and understand changes produced by Specrails. The current surface hides existing search capabilities, loses repository identity in spec links, shows stale results during navigation, and offers little overview of recorded work. Summary and story generation also have freshness, lifecycle and evidence gaps.

## What Changes

- Build a read-only exploration workspace with files, filename/content search and recorded activity, explicit repository scope, useful empty states and compact mission navigation.
- Preserve repository, file and line identity through navigation; expose reader controls, breadcrumbs, reliable request cancellation and real change patches.
- Improve file summaries and construction stories with useful explanations, provenance metadata, honest evidence/freshness states, bounded generation and cancellation.
- Make spec-to-file links include every affected repository, and keep historical changes distinguishable from the current registered checkout.
- Translate the experience in all supported languages and cover races, multi-repo navigation and safety bounds with regressions.

## Capabilities

### New Capabilities
- `code-explorer-workspace`: repository-aware search, navigation and recorded activity for full-page and mission exploration.

### Modified Capabilities
- `code-explorer`: improve the read-only viewer and tree defaults, loading/error/partial states and spec links.
- `file-summaries`: bind generation to actual source snapshots, expose useful evidence and prevent abandoned or erroneous generation.
- `file-provenance`: provide bounded repository-aware activity and consistent path filtering.

## Impact

Client Code page, mission code pane, file tree/reader, summary/story presentation and spec file links; server Code Explorer/provenance endpoints and summary/story generation lifecycle; existing database and cached-summary compatibility; code namespace translations, documentation and regression tests. Existing editing endpoints remain compatible, but the explorer UI is a reader. No provider credentials, paid model calls, deployment or data migration of user repositories is required to validate the change.
