# Proposal

## Why

Inside a mission the user cannot see which specs the project has or their status. They must ask the agent (a chat turn, stale snapshot) or leave for the Specs board. A read-only, live Specs side pane in Mission mode answers this without leaving the conversation.

## What Changes

- New Specs pane in Mission mode, opened from the right toolbar like Jobs. It lists the whole backlog of the mission's project; open specs first (in_progress, on_review, todo, draft), done/cancelled folded by default. Clicking a spec opens the existing ticket detail modal. It updates live through the existing tickets hook.
- The Specs tool is disabled with no pinned project and is exclusive with Jobs, Files and Analytics.
- Specs can be dragged into the composer as a spec reference chip; while referenced in the current draft the spec is hidden from the pane and returns when the reference is removed or the message is sent. Newly created specs animate in (reduced motion respected).
- The Specs pane has a 48px header, a full-height resize handle and blocks text selection only while dragging.
- Locale strings for the pane in 8 languages, README/source-map docs and the frontend boundary manifest.
- Also kept, at the user's explicit request in the Intent conversation: GitHub repository clone, the Fable 5.2 model alias, and per-area accents, surface layering and fully hidden sidebars (each with its own delta spec and tagged tests).

## Capabilities

### New Capabilities
- `mission-specs-pane`: Read-only live view of the mission project's specs and status in Mission mode, with drag-to-chat reference.

- `github-repository-clone`: clone a GitHub repository to a chosen destination.
- `fable-model-alias`: Fable alias resolves to Claude Fable 5.2.
- `app-area-chrome`: area accents, surface layering, hideable sidebars.

### Modified Capabilities

## Impact

Client only: missions feature (pane, workspace context, toolbar, composer, drag helper, mission windows), specs and missions READMEs, `agent` locales, boundaries manifest, source map.
