# Proposal

## Why

Mission mode currently removes finished work through a 30-day trash. People need a reversible way to clear the sidebar while retaining mission history indefinitely.

## What Changes

- Add persistent, idempotent archive and unarchive operations without changing messages, attachments, sessions, project pins or favorite membership.
- Add an Active / Archived / All selector beside Projects, independent of the live-only toggle, with persisted selection, scoped empty states and archived row styling.
- Permit archived history to open read-only. Refuse archiving streaming or background-active missions; move away from a successfully archived open mission.
- **BREAKING**: reject deletion of non-archived missions, including direct requests. Archived Delete still uses existing soft-delete, Undo, trash and 30-day purge semantics after confirmation.
- Default desktop and mobile mission lists to non-archived missions; expose archive scope on the desktop list API.

## Capabilities

### New Capabilities

- `mission-archive`: persistent archive lifecycle, read-only history, guarded deletion and sidebar archive scopes.

### Modified Capabilities

- `mission-sidebar-active-filter`: compose existing live-only behavior and open-mission exception within the selected archive scope.

## Impact

Extends the desktop SQLite migration and agents store, mission HTTP routes and admission coordinator, mobile list, mission client API/context/composer and ArcSidebar. Adds ArchiveScopeFilter and focused regression tests; updates all eight shipped locales and narrow module/API guides. No dependency additions, module extraction or trash format changes. Default list payloads remain bounded by the existing limit; archives load only when their scope is requested.
