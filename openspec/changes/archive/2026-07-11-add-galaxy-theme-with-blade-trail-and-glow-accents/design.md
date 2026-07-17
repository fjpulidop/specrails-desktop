# Design - add-galaxy-theme-with-blade-trail-and-glow-accents

## Context
The repo is a TypeScript desktop app with a React/Vite client, Express server, Vitest tests, and an OpenSpec capability named `desktop-theme-system`. Earlier rounds already implemented the decorative theme, blade trail, starfield, and glow behavior under legacy ids; this pass must rename identifiers and copy without changing palette values or behavior, while preserving existing users' preferences through one-time migration.

Scope: both

## Goal
Ship the same visual theme behavior under trademark-safe ids (`galaxy`, `code-rain`) and migrate persisted legacy ids before users see an incorrect or default theme.

## Non-Goals
- Do not retune palette HSL values, xterm colors, chart colors, job-status colors, canvas animation timing, or starfield density.
- Do not add a user-facing accent variant toggle.
- Do not add sounds, intro animations, or custom cursor icons.
- Do not translate external guide documentation in this ticket.
- Do not continue accepting legacy ids on write paths after migration support is added.

## Design

### Architecture
The client theme registry remains the source of truth for React-visible ids and non-CSS palettes. `THEME_IDS` changes from the legacy ids to current ids, and the exported `LEGACY_THEME_ID_MAP` provides a small read-side translation table for boot-time and React-time recovery. CSS selectors, effect registry keys, component filenames, tests, and localization keys move to the current ids so normal runtime code sees only `galaxy` and `code-rain`.

The boot script in `client/index.html` must duplicate the tiny migration map before the allow-list check because it runs before bundled code is available. The server keeps its duplicated allow-list, but adds the same legacy mapping in GET/read paths and persists migrated values back to `desktop_settings` when possible. PATCH and MCP set operations continue to validate only current ids.

### Data shapes

```ts
export const THEME_IDS = [
  'dracula',
  'aurora-light',
  'obsidian-dark',
  'code-rain',
  'specrails',
  'galaxy',
] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const LEGACY_THEME_ID_MAP: Record<string, ThemeId> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}
```

```ts
const THEME_ID_ALLOWLIST = new Set<string>([
  'dracula',
  'aurora-light',
  'obsidian-dark',
  'code-rain',
  'specrails',
  'galaxy',
])

const LEGACY_THEME_ID_MAP: Record<string, string> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}
```

### State & lifecycle
On pre-React boot, read localStorage. If the stored value is a legacy id, translate it, write the translated id back to localStorage, and apply the translated `data-theme` before first paint. In `ThemeContext`, treat `data-theme` and localStorage legacy values the same way as an extra fallback and persist the current id after migration. On `GET /api/theme`, read `ui_theme`; if it is legacy, respond with the current id and write the current id back to the DB. PATCH and MCP write paths reject legacy ids.

### Public API / surface

```ts
// client/src/lib/themes.ts
export const LEGACY_THEME_ID_MAP: Record<string, ThemeId>
export function isThemeId(v: unknown): v is ThemeId
```

```http
GET /api/theme
200 { "theme": "galaxy" | "code-rain" | ... }

PATCH /api/theme
body { "theme": "galaxy" | "code-rain" | ... }
400 for "star-wars", "matrix", or any unknown id
```

```ts
// server/mcp/tools/app-settings.ts
theme?: z.enum(['specrails', 'dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'galaxy'])
```

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Keep visual values identical and rename only ids/copy | Lowest regression risk; satisfies users with existing preference once migration lands | Leaves no opportunity to improve palette polish in this pass | Yes |
| Rework palette while renaming | Could improve aesthetics | Violates the ticket's requirement that Round 4 behavior remain identical | No |
| Accept legacy ids forever on PATCH | Simplifies clients that still submit old ids | Weakens the current allow-list contract and hides stale callers | No |
| Read-side migration with write-back | Preserves existing users and keeps write contract strict | Requires small duplicated maps in boot script and server | Yes |

The chosen approach is a narrow rename plus migration because the theme behavior already exists and the risk is stale identity/copy, not visual implementation.

## Risks
- Renaming test fixture strings that are unrelated to theme ids could create unnecessary churn; mitigate by limiting broad text cleanup to files touched by this ticket and leaving unrelated words like "matrix" in algorithmic/test descriptions alone unless they are theme/brand references.
- The boot script cannot import the registry; mitigate by keeping a small inline map and testing that the inline allow-list matches `THEME_IDS`.
- Server and MCP allow-lists may drift; mitigate by updating both duplicated lists and adding tests for accepted current ids and rejected legacy ids.
- `data-theme` selectors are easy to miss in CSS opacity-collapse rules; mitigate with targeted `rg` checks for legacy selectors and old glow variable names.
- File renames may leave stale imports; mitigate with typecheck/build after the TDD cycles.

## Open questions
- None.
