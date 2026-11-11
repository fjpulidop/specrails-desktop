# Proposal

## Why

Failure diagnosis and expanded run Details currently push execution evidence below the visible area on both Job Detail surfaces. Separating failure information from execution evidence makes either reachable without scrolling through the other.

## What Changes

- Introduce shared Failure reasons / Log navigation for the routed page and mission modal. Failure reasons defaults selected for diagnosed failed/canceled jobs and is also available for answerable pending questions; no separate cause summary appears above the tabs.
- Bound diagnosis and Details scrolling; keep header status/actions and pipeline chips compact.
- Give loop jobs Execution graph / Log detail sub-sections; plain jobs show Log detail alone. Remember the Log sub-section and Details expansion per surface without remembering the top-level tab.
- Preserve diagnosis remedies, pending-question answering, streaming/retained-tail states, narration, and keyboard accessibility. Apply the requester's explicit exception: answerable pending questions expose Failure reasons even without a diagnosis; their affordance selects it and opens Details.
- Preserve graph exploration state and log scroll when navigating; reconcile the active-only mounting instruction with component-local state explicitly in design.

## Capabilities

### New Capabilities

- `job-run-detail-navigation`: Shared bounded run-detail panels, selection, persistence, accessible navigation, and remedy/question navigation on page and modal.

### Modified Capabilities

- `live-job-status`: Replace the legacy inline status-panel/metric-grid layout requirement with compact shared chrome and bounded Details while retaining existing metric calculation requirements.
- `narrated-progress`: Place the existing narrated/raw mode in Log detail while keeping navigation independent of the narration flag and preserving narration semantics.

## Impact

Client-only jobs feature composition, its adjacent tests, jobs translations in all eight locales, and localized Job Detail guides. Reuse the existing recovery parser/remedies and scoped failure-log lookup without changing their wire contracts. No server/API/database changes or new dependencies. Existing React 19.3.0 supports state-preserving hidden Activity boundaries, subject to the explicit lifecycle decision in design. Details storage retains legacy page/glass entries. The exact implementation file boundary is enumerated in design.md.
