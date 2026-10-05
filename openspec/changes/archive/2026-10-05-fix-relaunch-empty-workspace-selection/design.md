## Context

Relaunch restores saved launch options or derives them from a delivery manifest. Object.fromEntries over repositories without selectedWorkspacePaths produces an empty object, but the public validator accepts absence for workspace defaults and requires nonempty explicit maps. Mission launch-card repository filtering can also leave an empty map. The Relaunch button itself sends only the source id; Core is not involved in this failure.

## Goals / Non-Goals

**Goals:** Preserve default scope during reconstruction and repository edits; retain explicit selections; reproduce the reported rejection at the route boundary.

**Non-Goals:** Accept arbitrary empty/invalid client maps, alter repository/workspace admission, migrate saved executions, or change environment propagation/Core.

## Decisions

- Omit workspaceSelection only when the manifest-derived map has no entries. Saved explicit selections keep their priority and remain subject to normal validation. Invalid arrays, empty arrays and stale paths must not be silently converted to unrestricted defaults.
- Frontend projection returns undefined when no entries remain for selected repositories; the launch payload therefore omits the optional property. Retained entries are unchanged, including any invalid values that the server must reject.
- Keep the public validator strict. Cover both successful default-scope relaunch and rejected explicit invalid scopes, checking that rejection does not restore tickets or launch work.
- Add focused tests and document optional selection semantics in the existing delivery/mission guides, without introducing a new module or persistence format.

## Risks / Trade-offs

- Silently dropping invalid explicit values could broaden scope → omit only genuinely absent or empty projection results, not invalid saved selections or path arrays.
- A unit-only fix might miss admission behavior → include HTTP relaunch regression tests using a persisted delivery manifest.
- Existing malformed saved configurations remain rejected → retain that safe behavior rather than guessing intended scope.

## Migration Plan

No migration. Existing failed deliveries with default workspace scope become relaunchable after updating Desktop. Rollback changes no persisted data.
