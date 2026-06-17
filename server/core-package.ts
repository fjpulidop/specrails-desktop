/**
 * Single source of truth for the specrails-core npm package spec the app
 * installs and probes (H5). Pinned to the current major range so a future
 * specrails-core 5.x with breaking changes never lands on every user the
 * minute it is published — adopting a new major is a deliberate one-line
 * bump here, shipped through the app's own release pipeline.
 *
 * Floor bumped to 4.8.0 — the version that ships the Gemini provider target
 * (`.gemini/` commands + agents). It also changes the `npx` package-spec string,
 * which invalidates any stale `_npx` exec cache that npx would otherwise reuse
 * for the old `^4.6.0` range (so users actually resolve the newer core).
 *
 * `SPECRAILS_CORE_BIN` remains the escape hatch for local/linked builds
 * (see getCoreCommand in setup-manager.ts).
 */
export const CORE_PACKAGE_SPEC = 'specrails-core@^4.8.0'
