# dialog-movable-resizable Specification

## Purpose

Wire the `useMovableResizableModal()` hook into the shared `DialogContent` primitive behind an opt-in `movableResizable` prop, and enroll the Tier A Dialog-based modals into it. Dialog-style modals are resize-only (not movable) because they lack an obvious drag handle, while preserving the Radix focus trap, dialog semantics, and Escape-to-close.

## Requirements

### Requirement: DialogContent Opt-In Resizable Prop

The shared `DialogContent` primitive (`client/src/components/ui/dialog.tsx`) SHALL accept an optional `movableResizable` boolean prop, defaulting to `false`. When `false`, `DialogContent` SHALL render exactly as before. When `true`, it SHALL apply `useMovableResizableModal({ allowMove: false })` to the Radix `Content` element and render the resize grips, without altering the Radix focus trap, `role="dialog"`, `aria-modal`, or Escape handling. Dialog-style modals are **resize-only** — they are NOT movable, because they lack an obvious drag handle and a whole-panel move makes body clicks accidentally reposition the modal.

#### Scenario: Default-off preserves existing behavior

- **WHEN** a modal renders `DialogContent` without `movableResizable`
- **THEN** it SHALL behave and appear identically to before this change

#### Scenario: Opt-in enables resize only

- **WHEN** a modal renders `DialogContent` with `movableResizable`
- **THEN** the modal SHALL be resizable by its corner/edge grips, subject to the viewport gate
- **AND** clicking anywhere on the modal (header or body) SHALL NOT reposition it

#### Scenario: Radix semantics preserved

- **WHEN** `movableResizable` is enabled
- **THEN** the Radix-provided focus trap, `role="dialog"`, `aria-modal`, and Escape-to-close SHALL remain in effect unchanged

### Requirement: Tier A Dialog Modals Are Resizable

The Dialog-based modals that funnel through `DialogContent` SHALL opt into `movableResizable`: AddProjectDialog, CreateTicketModal, ProposeSpecModal, CreateTemplateDialog, FeatureProposalModal, FreestyleLaunchDialog, DiscardSpecDialog, PromptDialog, RoutingRuleDialog, PairWebCompanionModal, LoopRunModal, TemplatePreviewModal, KeyboardShortcutsCheatsheet, DocsDialog, the GlobalSettingsPage SettingsDialog, and InstallInstructionsModal.

#### Scenario: A Tier A modal can be resized but not moved

- **WHEN** the user opens any of the listed Tier A modals on a viewport at or above the gate
- **THEN** the modal SHALL be resizable from its corners and edges
- **AND** it SHALL stay centered (clicks never reposition it)

#### Scenario: Nested confirmation dialogs are not resizable

- **WHEN** a modal opens a nested confirmation dialog (e.g. a delete or save confirm)
- **THEN** the nested dialog SHALL render with `movableResizable` off
