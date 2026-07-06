## Context

`client/src/lib/themes.ts` is the documented single source of truth for theme registration (xterm/chart/status palettes — surfaces that cannot read CSS variables). `client/src/globals.css` is the CSS-variable source of truth for every other surface (`@theme` declares the token names once; each `[data-theme="<id>"]` block redefines them). Two existing themes demonstrate the two extension points this change reuses verbatim:
- `matrix` — a phosphor-green palette plus a decorative canvas effect (`MatrixRain.tsx`) registered in `ThemeEffectLayer.tsx`'s `THEME_EFFECTS` map, plus a `--matrix-glow` `:focus-visible` drop-shadow rule gated behind `prefers-reduced-motion`.
- `specrails` — a brand palette with no decorative effect, proving the effect registry entry is optional (`THEME_EFFECTS` is `Partial<Record<ThemeId, ComponentType>>`).

Both the client (`THEME_IDS` in `themes.ts`) and server (`THEME_ID_ALLOWLIST` in `server/desktop-router.ts`) keep a manually-synchronized allow-list — confirmed by reading `server/desktop-router.ts:71`, which matches the ticket's technical considerations exactly (no path drift for this file, unlike the ticket's placeholder "(unspecified exact path)").

The existing `openspec/specs/desktop-theme-system/spec.md` capability spec still says "exactly four built-in themes ... dracula, aurora-light, obsidian-dark, and matrix" — this is pre-existing drift from when `specrails` shipped as a fifth theme without a spec update. This change's delta spec corrects that requirement's prose (six themes) rather than compounding the drift with a seventh unreflected theme.

## Goals / Non-Goals

**Goals:**
- Ship a sixth theme, `star-wars`, that is visually distinct from all five existing themes and reads as "elegant and fine" rather than gimmicky (per the ticket's stated complexity risk).
- Ship `LightsaberTrail`, a new canvas cursor-trail effect with different rendering logic from `MatrixRain` (a thin glowing line following recent pointer positions, not a field of falling glyphs), sharing the exact same lifecycle contract (reduced-motion opt-out, visibility-driven pause, `pointer-events:none`, `z-index:-1`).
- Preserve OCP: zero changes to any component outside `themes.ts`, `globals.css`, `ThemeEffectLayer.tsx`, and the new `LightsaberTrail.tsx`.
- Keep client/server theme-id allow-lists synchronized.

**Non-Goals:**
- A user-facing Jedi-blue vs. Sith-red primary-accent toggle (ticket: out of scope — ships as one cohesive theme).
- Sound effects, an animated intro/crawl, or a custom cursor icon (ticket: out of scope).
- Localizing `docs/guide/*/settings/1-themes.md` (ticket: explicit fast-follow).
- Any change to `ThemePickerGrid.tsx`, `ThemeContext.tsx`, or `theme-palette.ts` — confirmed by reading all three that they are already fully generic over `THEME_IDS`/`THEMES`.

## Decisions

### D1: Palette hue assignment
The ticket fixes four slots explicitly: Jedi blue → `primary`/`ring`/`info` (a single shared hue, not two distinct blues — the ticket's parenthetical groups them together, unlike every other theme where `primary` and `info` are distinct hues; this is an intentional one-off to keep the "cohesive blade-blue" identity strong), Sith red → `destructive`, a gold accent → `highlight`, Force-green → `success`. Two slots are left to architect judgment: `secondary` and `warning`.
- **`accent-secondary` → violet (`hsl(280 65% 64%)`)**, a deliberate homage to Mace Windu's purple lightsaber. This gives the palette a 5th distinct hue family (blue / red / gold / green / violet) so status chips, priority pills, and sort controls stay individually recognizable, mirroring the "matrix semantic accent slots remain visually distinct" precedent requirement already in the base spec.
- **`accent-warning` → blaster-orange (`hsl(28 95% 56%)`)**, distinct enough from the gold highlight (`hsl(45 90% 55%)`) by hue (28° vs 45°) to stay individually recognizable side-by-side, matching the pattern the `matrix` theme uses for its warning/highlight pair (35° vs 51°).
- Background hue is `224°` (blue-black "deep space"), chosen to sit between `obsidian-dark` (`222°`, already blue-tinted near-black) and `specrails` (`240°`, navy-indigo) without colliding with either — verified via the existing "distinct dark theme" test pattern in `themes.test.ts`.

Alternative considered: reusing `matrix`'s green for `success` verbatim. Rejected — the two themes are independent and a shared literal HSL value is fine, but tuning `star-wars`'s Force-green slightly warmer/less saturated (`hsl(140 65% 50%)` vs matrix's `hsl(145 100% 70%)`) keeps `star-wars`'s own preview swatch legible against its bluer background without needing to reference the other theme's constants (each theme module stays a self-contained literal-value block, matching the existing five).

### D2: `LightsaberTrail` rendering approach
Mirrors `MatrixRain`'s architecture (single `<canvas>`, imperative `requestAnimationFrame` loop, pointer-tracked reveal state) but with fundamentally different draw logic:
- Maintain a short ring buffer of recent pointer positions (`{x, y, t}`), capped (e.g. 24 samples) and age-culled (e.g. 220ms TTL) — same shape as `MatrixRain`'s `echoes` array, reused for the "trail" concept but driving a **stroked path**, not per-glyph reveal alpha.
- Each frame, draw the buffer as a single tapered, glowing polyline: `ctx.shadowBlur` + `ctx.shadowColor` for the blade glow, decreasing `lineWidth` and `globalAlpha` from head (newest sample) to tail (oldest), using a `lineCap: 'round'` stroke so the line reads as one continuous, softly rounded blade rather than a rain-drop dot chain.
- Color is intentionally **not** theme-id-branched inside the component (preserving `MatrixRain`'s documented no-branching contract) — the component accepts no theme prop and hardcodes its own blue/white blade gradient (`ctx.createLinearGradient` from a core near-white to the Jedi-blue hue), because `ThemeEffectLayer` only ever mounts this component under the `star-wars` theme (enforced by the registry, not by the component reading `data-theme` itself).
- Reduced-motion and visibility handling copy `MatrixRain`'s exact pattern: bail out of the `useEffect` entirely (no canvas draw, no RAF) when `prefers-reduced-motion: reduce` matches; register `visibilitychange` to cancel/resume the RAF loop.

Alternative considered: a shared `useCursorTrail` hook parameterized by a `draw` callback, shared between `MatrixRain` and `LightsaberTrail`. Rejected for this change — `MatrixRain` is explicitly documented as self-contained and out of scope to refactor here; introducing a shared hook is a larger, separate refactor with its own risk surface, and the ticket's acceptance criteria only ask for a new sibling component, not a `MatrixRain` refactor. Flagged as a reasonable future cleanup, not undertaken now.

### D3: Blade-glow border treatment — zero new markup
The ticket's example targets ("active nav item", "active card outline") are already expressed today via **existing, generic utility hooks** with no new class or data-attribute needed:
- react-router's `<NavLink>` (used by `ProjectRightSidebar.tsx` and other nav surfaces) sets `aria-current="page"` on the active link automatically — confirmed by reading `ProjectRightSidebar.tsx`. Scoping a rule to `[data-theme="star-wars"] a[aria-current="page"]` picks up every active nav link app-wide with zero component changes.
- The `border-accent-primary` Tailwind utility is already applied conditionally by ~19 different components as their "selected / active" visual marker (confirmed via a repo-wide grep — `RailsBoard`, `TicketGridView`, `ThemePickerGrid`, `TicketDetailModal`, etc.). Scoping a rule to `[data-theme="star-wars"] .border-accent-primary` gives every one of those "active card outline" surfaces a consistent blade-glow border under this theme, again with zero component changes.

This keeps the OCP invariant intact: the new theme's border treatment rides purely on markup/attributes the app already emits, matching the ticket's explicit constraint that "no app component outside the theme-effects registry and the two CSS/registry files branches on the 'star-wars' theme id."

Alternative considered: adding a new `active-glow` utility class and threading it through each "active" component. Rejected — unnecessary surface area and a direct violation of the ticket's OCP acceptance criterion; the existing `aria-current`/`border-accent-primary` hooks already cover the two example surfaces losslessly.

### D4: Locale parity for the new tagline
`ThemePickerGrid.tsx` reads `t('appearance.taglines.${id}', { defaultValue: t.tagline })`, so a missing translation key does not break the UI — it silently falls back to the English tagline string embedded in the descriptor. Nonetheless, this change adds a `star-wars` key to the `appearance.taglines` block in all 8 locale files (matching the existing 5 keys per locale) rather than relying on the fallback, because (a) the repo's locale-parity test enforces that every locale mirrors English's key tree only for keys that exist in English — omitting the key from English entirely would pass that test, but leaving user-facing English strings out of the translation files for a shipped, non-experimental theme is inconsistent with this project's documented "no hardcoded user-visible strings" convention and its own precedent (all five other themes have a translated tagline in all 8 locales).

### D5: Server allow-list — no path deviation
The ticket's Technical Considerations section flags the server-side `ThemeId` validator location as "(unspecified exact path)" pending confirmation. Reading `server/desktop-router.ts` confirms it lives exactly where the file's own inline comment says it should (`// Theme allow-list. Mirror of THEME_IDS in client/src/lib/themes.ts`, `THEME_ID_ALLOWLIST` at line 71, consumed at line ~885 for the `PATCH /api/theme` handler with a `specrails` fallback default). No deviation — this is a one-line addition to the existing `Set`.

## Risks / Trade-offs

- **[Risk]** A canvas cursor-trail effect can read as gimmicky if the glow is too thick/saturated or the trail too long → **Mitigation**: keep the blade thin (max line width ≈ 3–4px at the head, tapering to 0), short TTL (≈180–220ms) so the trail reads as a quick flourish rather than a persistent smear, and a modest `shadowBlur` (≈8–12px) so the glow is a soft halo, not a bloom. Tunable constants, isolated at the top of `LightsaberTrail.tsx` exactly like `MatrixRain`'s tuning constants, so a follow-up visual pass is cheap.
- **[Risk]** Sharing the Jedi-blue hue across `primary`/`ring`/`info` (per the ticket's explicit grouping) breaks the pattern every other theme uses (distinct `primary` vs `info` hues), which existing tests assert implicitly by checking non-CSS-surface population but not hue distinctness between those two specific slots → **Mitigation**: this is an intentional, ticket-directed deviation from the general pattern; no existing test asserts `primary !== info`, so it introduces no regression. Documented here so a future contributor does not "fix" it as a bug.
- **[Risk]** `client/src/lib/__tests__/themes.test.ts` has several hardcoded arrays (`THEME_IDS` exact-equality, the `darks` list, the `scheme` list) that will fail to compile/pass once `star-wars` is added unless updated in the same change → **Mitigation**: called out explicitly in tasks.md as a required file touch, not an incidental side effect.
- **[Trade-off]** Not extracting a shared cursor-trail hook between `MatrixRain` and `LightsaberTrail` duplicates ~30 lines of pointer-tracking/visibility/RAF boilerplate → accepted per D2; refactoring `MatrixRain` is out of scope for this ticket and would expand the review surface unnecessarily.

## Migration Plan

Purely additive — no data migration, no breaking API change, no feature flag needed (mirrors how `matrix` and `specrails` shipped). Rollback is trivial: revert the commit; no persisted state references `star-wars` unless a user has already selected it, and `GET /api/theme` already falls back to `specrails` for any value outside the current allow-list (existing `desktop-router.ts` behavior, unit-tested), so a rollback that removes `star-wars` from the allow-list degrades gracefully for any user who had it selected.

## Open Questions

None — the ticket's Contract Layer and the real-file grounding above resolve every ambiguity the ticket itself did not already close. The two "architect judgment" palette slots (`secondary`, `warning`) are resolved in D1 with documented rationale (also captured as a persisted agent-memory explanation record for traceability).
