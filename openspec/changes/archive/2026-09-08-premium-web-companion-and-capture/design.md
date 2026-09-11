## Context

Web uses React/Vite with eight languages and currently eagerly imports guide Markdown through navigation. Companion uses Flutter and a paired-device RPC gateway. Mission agents can operate across projects: a pinned project is a context preference, not an authorization boundary. Desktop has screencast and native capture implementations with inconsistent annotation transitions.

## Goals / Non-Goals

**Goals:** Demonstrate current workflows accurately; improve discovery and mobile usability; make capture handoff consistent; validate responsive behavior, protocol permissions and regressions.

**Non-Goals:** Cloud execution, public deployment or changing provider guarantees. Product demos must preserve the real application UI 1:1; no recreated product screens.

## Decisions

- Present real application recordings in focused feature cards inspired by the user's Voicebox reference. Keep mission primary; allow play/pause and expansion to the uncropped recording. Reuse current brand surfaces and components; avoid autoplay, eager video downloads and extra dependencies on initial navigation.
- Separate the lightweight documentation index from lazily loaded article content. Prefer current English fallback labeled for the reader over stale untranslated articles; translate essential journeys across supported locales.
- Negotiate mobile features explicitly. Enable mission control only for all-project device grants until agents enforce an immutable project allowlist. Do not expose repinned cross-project transcripts to restricted devices. Keep existing authorized board/rail features available on older servers.
- Keep mission RPCs bounded and authenticated; never add a generic proxy or arbitrary shell execution. Restore snapshots after reconnect and expose supported queue/process operations.
- Route all completed capture variants through annotation, keep native views behind the editor, and retain editable content on attachment failure. Escape belongs to the active editor while it is open.
- Work on staged copies of external repositories, then apply a reviewed file list to avoid overwriting unrelated untracked documents.

## Risks / Trade-offs

- Public feature drift → source-backed guide index, link checks, explicit capability limitations.
- Restricted device agent escape → deny mission reads/writes without full project grants; filter existing payloads by grant.
- Browser-only previews differ from native windows → unit coverage of both paths plus a real development browser smoke; report native validation limits.
- Stale bundles and docs → production build checks and lazy chunk inspection.

## Migration Plan

Ship additive mobile capability/RPC contracts before relying on them in Companion. Older servers retain legacy navigation. Web changes have no persistence migration and can be rolled back independently. Capture uses existing attachment payloads.
