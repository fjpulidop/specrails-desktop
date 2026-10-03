## Context

`AgentRailLaunchCard` loads pinned project tickets but hides repository choices with `workspaceOnly` and a no-op scope callback. Launch admission correctly requires the union of saved spec scopes. Ticket PATCH already persists validated scope and broadcasts the result.

## Goals / Non-Goals

**Goals:** Visible saved spec assignments and editable launch targets, explicit persisted spec edits, early actionable errors, correct pinned project routing, preserved workspace selections and frozen intents.

**Non-Goals:** Changing project membership, relaxing launch admission, changing runtime contracts or rewriting delivered work.

## Decisions

- Reuse the public project repository API helper and repository selector. Add optional selector labels/hints and single-repository visibility instead of changing every authoring form's default layout.
- Load repositories as required card context. Await the pinned project's complete snapshot and reconcile the initial proposal with current required repositories. Unknown selections remain visible for repair.
- Present a launch repository selector and compact saved-scope summaries per spec. An Edit action opens one local draft; Save uses existing ticket PATCH, Cancel discards it. Play is blocked while an edit is open.
- After a saved scope or selected spec change, replace obsolete required targets, merge new required targets, preserve additional launch targets and trim workspace entries for removed repositories. Manual omission of a still-required target blocks Play with its name and an explanation to edit the spec.
- Keep server validation authoritative for concurrent changes. Failed saves retain the draft and saved scope; failed launches remain editable.

## Risks / Trade-offs

- [Specs can change concurrently] → The server revalidates on Play and the card exposes its error. A card refresh loads current assignments; no silent server override is introduced.
- [Pinned and active projects differ] → All reads, scope writes and launch calls use the proposal's explicit project ID, preserving mission isolation.
- [Additional UI length] → Saved scopes use compact summaries and editors expand only when requested; repositories remain visible even in a single-repository project.
