# Verification

Final pre-push client suites: 63 tests passed across usage, keep-awake, status/title/sidebar and split-layout behavior. Typecheck passed. Native library tests: 49 passed on macOS, including real keep-awake acquisition, idempotency and disposal. Subscription server tests: 24 passed; broader server regressions, build, package and scripts passed earlier in this change. Core compatibility check skipped because the packaged Core dependency is absent.

The final UI places provider summaries in the shared footer with full quotas, last-update and reset durations in a hover/focus menu. Provider brand silhouettes, an animated collection halo, a native keep-awake control, titlebar sidebar toggles and labeled horizontal sidebar actions are implemented. No view selector, usage-history or account-management action is exposed.

Windows keep-awake is implemented with a dedicated assertion thread but has not been smoke-tested on Windows. Final visual coverage across all themes, long locales and 200% zoom remains incomplete (task 5.4). Earlier focused previews covered desktop, narrow viewport and no-CLI states.
