# Proposal

## Why

Mission users need to reuse a conversation fragment in the source mission or explore it separately without copying and pasting. The existing diff adds selection actions with an explicit choice of how much conversation context to retain.

## What Changes

- Show a localized selection menu for committed mission messages, with source-bound sending and separate-mission actions, including keyboard access.
- Prepare selected text as an editable, unsent draft in an additional split pane, retaining existing panes and the source draft.
- Support starting empty with source settings or forking the inclusive history through the final selected message, including independent attachment copies and provenance.
- Keep inherited cards inactive and exclude inherited proposals/deliveries from the new mission's active run strip.
- Seed copied historical attachments into the fork's fresh provider session; retain recorded interrupted/cancelled status without copying input admissions or execution ownership.
- Append desktop migration 39 and document the UI, storage and branch API.

## Capabilities

### New Capabilities

- `mission-text-reuse`: Selection eligibility, source-bound sending, unsent split-pane preparation, inclusive independent snapshots, and inherited-history presentation.

### Modified Capabilities

- `agent-attachments`: Extend attachment folding to include eligible inherited attachment IDs when a fork starts its own provider session.

## Impact

Changes are confined to the mission React feature, eight agent locale files, app-level mission routing/runtime, agent persistence, attachment copying, desktop migration 39, adjacent tests and focused documentation. The additive `POST /api/agent/conversations/:id/branch` endpoint accepts empty/fork snapshots; the client uses the existing creation endpoint for empty missions. No dependency additions or source deletions appear in the diff. Verification execution remains with Core.
