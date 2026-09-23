## Context

Hub client is a Vite + React + Tailwind v4 SPA whose visual identity is locked to a Dracula palette declared in `client/src/globals.css` under a single `@theme inline { … }` block. Two namespaces of CSS variables coexist there:

1. **Semantic shadcn-style tokens** (`--color-background`, `--color-foreground`, `--color-card`, `--color-primary`, …) — already neutral.
2. **Brand-named accent tokens** (`--color-dracula-purple`, `--color-dracula-cyan`, `--color-dracula-green`, `--color-dracula-pink`, `--color-dracula-orange`, `--color-dracula-red`, `--color-dracula-yellow`, `--color-dracula-comment`, `--color-dracula-current`, `--color-dracula-darker`) — leaked across 336 component usages (`text-dracula-purple`, `bg-dracula-current`, …).

Non-CSS surfaces also embed colors:
- `client/src/lib/dracula-colors.ts` (+ `__tests__/dracula-colors.test.ts`) — JS-side palette mirror used by xterm and charts.
- `client/src/components/analytics/*` (Recharts) — color literals or palette imports.
- `client/src/features/terminals/context/TerminalsContext.tsx` — xterm.js `Terminal` instances receive a `theme` option (background, foreground, ANSI 16).
- `client/src/features/jobs/components/LogViewer.tsx` — syntax highlighting palette.
- `client/src/demo-mode/tour/tour.css` — tour overlay styles.

Hub already has settings infrastructure: `hub_settings` table in `hub.sqlite`, hub router endpoints under `/api/hub/*`, and `GlobalSettingsPage` modal. Theme persistence fits cleanly there.

Cross-cutting change touching CSS architecture, ~60 components, server settings, two non-CSS rendering layers (xterm, Recharts), and a new boot-time anti-FOUC mechanism — design doc is warranted.

## Goals / Non-Goals

**Goals:**
- Three first-class themes selectable hub-wide: `dracula` (default, byte-equivalent visual to current), `aurora-light` (premium light), `obsidian-dark` (premium dark).
- Clean rename of brand-named tokens to semantic names; zero residual `dracula-*` references in component code after this change.
- Theme switch is instantaneous, with no flash of wrong theme on hub boot.
- Theme propagates correctly to xterm terminals, Recharts charts, syntax-highlighting, and the demo tour.
- Premium look-and-feel: each theme's palette is hand-tuned, not auto-inverted; cards in Settings showcase the theme visually.
- Adding a fourth theme later requires only (a) a new entry in `themes.ts`, (b) a new `[data-theme="…"]` block in `globals.css`, (c) a new xterm/recharts mapping. No component-code changes.

**Non-Goals:**
- Per-project theme override (out of scope; hub-wide only).
- Live preview on hover in Settings cards.
- User-defined custom themes / theme editor.
- Real "premium" gating (auth, billing, license). "Premium" here is purely a visual quality bar, not a paywall.
- Migration of `specrails-core` palette or any non-hub repo.
- High-contrast or accessibility-mode themes (deferred).

## Decisions

### D1 — Token strategy: full semantic rename (no aliases)

Rename every `dracula-*` Tailwind token to a semantic name in one change. Mapping:

| Old token | New token | Role |
|---|---|---|
| `dracula-purple` | `accent-primary` | brand primary, links, primary buttons |
| `dracula-cyan` | `accent-info` | informational accents, secondary actions |
| `dracula-green` | `accent-success` | success states |
| `dracula-pink` | `accent-secondary` | secondary brand accent |
| `dracula-orange` | `accent-warning` | warning states |
| `dracula-red` | `accent-danger` | error/destructive (note: `--color-destructive` already exists; keep for shadcn semantics, `accent-danger` is the brand mirror) |
| `dracula-yellow` | `accent-highlight` | highlights, badges |
| `dracula-comment` | (drop, replace with existing `muted-foreground`) | de-duplicate |
| `dracula-current` | `surface` | elevated surface (card-equivalent but distinct from `card`) |
| `dracula-darker` | `background-deep` | deep background (sidebars, code blocks) |

**Why not aliases (Option B/C from exploration):** keeping `dracula-*` names while a Light theme is active creates permanent cognitive debt — every component reader must mentally translate. Aliases also mask drift: a future contributor would not know which name is canonical. One-shot rename is mechanical (~336 replacements), low-risk under a comprehensive visual review pass, and yields a codebase where the active theme is invisible to component code (Liskov-friendly: any theme substitutes cleanly).

**Alternatives considered:**
- *Keep `dracula-*` names with per-theme remapping.* Rejected: lying name in Light theme.
- *Hybrid (semantic + dracula alias deprecated).* Rejected by user; correctly identified the cognitive overhead.

### D2 — Theme switching mechanism: `data-theme` on `<html>` with CSS-var override blocks

```css
@theme inline { /* dracula tokens — default */ }

[data-theme="aurora-light"] {
  --color-background: hsl(220 20% 98%);
  --color-foreground: hsl(230 25% 14%);
  --color-accent-primary: hsl(255 75% 58%);
  /* … */
}

[data-theme="obsidian-dark"] {
  --color-background: hsl(220 18% 8%);
  /* … */
}
```

Tailwind v4 reads CSS vars at runtime; switching `document.documentElement.dataset.theme` re-resolves all variables instantly without React re-render. No class-toggling, no `useTheme()` re-renders cascading through the tree.

**Alternatives considered:**
- *Tailwind `dark:` variant.* Rejected: only supports two states, can't express three themes; couples theme to color-scheme rather than a first-class identity.
- *CSS Modules per theme.* Rejected: massive duplication, breaks Tailwind utility flow.
- *Runtime CSS-in-JS.* Rejected: extra dependency; FOUC harder; performance regression.

### D3 — Persistence: `hub_settings.ui_theme` + localStorage mirror

Server-side source of truth: a row in `hub_settings` with key `ui_theme`, value one of `dracula | aurora-light | obsidian-dark`. Default seeded by migration: `dracula`.

REST surface: extend the existing hub settings endpoint family. Concretely add `GET /api/hub/theme` and `PATCH /api/hub/theme` in `server/hub-router.ts` (small, focused; SRP-friendly relative to the broader settings endpoint which is becoming crowded).

Client: on every successful PATCH, mirror to `localStorage` under key `specrails-hub:ui-theme`. On boot, the inline anti-FOUC script reads `localStorage` first (synchronous, before React mounts), applies `data-theme`, and React's `ThemeProvider` later reconciles by fetching the server value — if they differ (e.g. another machine changed it), apply server value and overwrite localStorage.

**Why localStorage as boot cache:** server fetch is async (network round-trip even on localhost adds 5–50ms; in packaged Tauri it's IPC); without a cache the user always sees Dracula for one frame before the chosen theme paints. localStorage read is synchronous and pre-React.

### D4 — Anti-FOUC: blocking inline script in `index.html`

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem('specrails-hub:ui-theme');
      var allowed = ['dracula', 'aurora-light', 'obsidian-dark'];
      if (t && allowed.indexOf(t) !== -1) {
        document.documentElement.dataset.theme = t;
      } else {
        document.documentElement.dataset.theme = 'dracula';
      }
    } catch (e) {
      document.documentElement.dataset.theme = 'dracula';
    }
  })();
</script>
```

Inlined as the first child of `<head>`, before the Vite-injected `<script type="module">`. The allow-list prevents stored garbage from setting an attacker-controlled attribute. Wrapped in try/catch because Tauri's `localStorage` can throw under certain configurations.

### D5 — Non-CSS surface bridging via single source of truth (`themes.ts`)

`client/src/features/settings/lib/themes.ts` becomes the canonical theme registry — exported as a typed `Record<ThemeId, ThemeDescriptor>`. Each descriptor includes:
- CSS-var values (informational; mirrored from `globals.css` for tooling — runtime authority is the CSS).
- `xterm`: the full xterm.js theme object (background, foreground, cursor, ANSI 16).
- `chart`: array of palette colors used by Recharts.
- `syntax`: token-color map for `LogViewer`.
- `displayName`, `tagline`, `previewSwatches` — UI metadata for the Settings card.

Components that previously imported `dracula-colors.ts` switch to a `useTheme()` hook returning the active descriptor. xterm `Terminal` instances are reconfigured on theme change via `term.options.theme = …` (xterm supports live theme updates without recreating the instance — preserves scrollback, marks, and shell-integration state).

This layout enforces **DIP** (components depend on the abstract `ThemeDescriptor` shape, not on a specific theme), **OCP** (adding a fourth theme = adding one entry to the registry; no consumer code changes), and **SRP** (one module owns "what is a theme").

### D6 — Recharts palette via CSS-var read at render time

Recharts components read CSS variables via `getComputedStyle(document.documentElement).getPropertyValue('--color-accent-primary')`, memoized per theme change (subscribe to `ThemeContext`). Avoids hardcoded hex values and ensures charts always match the active theme without a separate palette duplication.

### D7 — Default theme per platform: do nothing fancy

Default = `dracula` for all users (preserves current experience). No `prefers-color-scheme` auto-detection in v1. Reason: Dracula is the existing brand identity; auto-flipping users to a Light theme on first launch would be jarring and a behavior change. Easy to add later as a `"system"` pseudo-theme.

### D8 — Tests: snapshot for token-rename mechanical correctness, behavior tests for switching

- **Mechanical:** a single test asserts the token mapping table from D1 is reflected in `globals.css` (no orphaned `dracula-*`-named CSS var declarations).
- **Behavioral:**
  - `ThemeContext` test: setting theme writes localStorage + document attribute + PATCH call.
  - `GlobalSettingsPage` Appearance section test: clicking a card triggers the context update; selected state visible.
  - Server `/api/hub/theme` GET/PATCH unit tests + invalid value rejection (allow-list enforcement, defense in depth).
  - xterm theme reconciliation test: mock `Terminal.options.theme` setter, assert called on theme change.
- **Visual sanity (manual + Playwright optional):** screenshot each theme on the main dashboard. Out of automated CI for v1; documented in `tasks.md`.

### D9 — Token-rename rollout: codemod, not manual edit

A throwaway Node script in `scripts/rename-theme-tokens.mjs` walks `client/src/**/*.{ts,tsx,css}` and applies the D1 mapping with word-boundary regex (`\bdracula-purple\b` → `accent-primary` etc.). Reviewer reads the diff once; CI typecheck + tests catch regressions. Script is committed alongside the change for auditability, then deleted in a follow-up cleanup commit.

## Risks / Trade-offs

- **Risk:** The 336-call rename misses occurrences in template literals or string-concatenated class names. → **Mitigation:** codemod uses word-boundary regex AND a final `grep -r 'dracula-' client/src` MUST return zero hits before merge; CI step added.
- **Risk:** xterm scrollback corruption when theme changes. → **Mitigation:** xterm.js docs confirm `term.options.theme = newTheme` is non-destructive; covered by behavioral test.
- **Risk:** Recharts `getComputedStyle` read at every render hurts perf on heavy dashboards. → **Mitigation:** read once per theme change via `useMemo` keyed on `themeId`.
- **Risk:** Anti-FOUC script reads stale localStorage and applies wrong theme; user briefly sees old theme until server reconciles. → **Mitigation:** acceptable; only happens if user changed theme on another machine. Reconcile is a single repaint.
- **Risk:** Aurora Light palette unreadable for some users (low contrast on hover states). → **Mitigation:** WCAG AA contrast check on text/background pairs during palette finalization; document in tasks.
- **Risk:** Coverage thresholds (80% server / 80% client lines) drop because of large untested CSS-var blocks. → **Mitigation:** CSS is excluded from coverage by default; new TS modules (`themes.ts`, `ThemeContext.tsx`) tested directly.
- **Risk:** `data-theme` collision with third-party libraries that read it. → **Mitigation:** none in current dep tree; documented constraint for future libs.
- **Trade-off:** No `prefers-color-scheme` detection in v1. New users on light-mode OSes see Dracula until they switch. Acceptable; defer to v2 with explicit "System" option.
- **Trade-off:** Single PR is large (rename + new themes + settings UI). Splitting would risk an intermediate state where `dracula-*` and `accent-*` coexist. We accept the larger PR for atomicity.

## Migration Plan

1. Land token rename + Dracula-as-default-under-new-names in a single commit (visually identical to today).
2. Add `aurora-light` and `obsidian-dark` blocks.
3. Add `ThemeContext`, `themes.ts`, hub endpoint, FOUC script.
4. Add `GlobalSettingsPage` Appearance section.
5. Wire xterm + Recharts + LogViewer + tour.css.
6. Update `CLAUDE.md` Conventions section with theme guidance.
7. Release as a `feat:` commit → minor version bump via release-please.

**Rollback:** revert single PR. No DB migration is destructive — `ui_theme` row is additive and orphaned rows are harmless.

## Open Questions

- Does `aurora-light` need a separate xterm palette, or is the existing dark xterm-on-light-app combination acceptable? **Tentative decision:** ship a real light xterm theme — anything else looks unprofessional. Tasks will include palette tuning.
- Should the Recharts axis/grid colors (currently faint dracula greys) become semantic too? **Tentative:** yes, map to `muted-foreground` / `border`.
- Where exactly to mount the FOUC script — `client/index.html` for dev, but the Tauri-packaged build serves a different entry? **Verify** during implementation that `vite build` preserves the inline script in the production bundle.
