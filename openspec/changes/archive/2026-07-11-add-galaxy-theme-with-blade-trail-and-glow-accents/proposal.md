# Add Galaxy theme with blade trail and glow accents

## Why
The desktop theme system already contains the visual work for a deep-space decorative theme and a terminal-rain theme, but the current identifiers and copy still use legacy branded terminology. Existing users may also have old theme ids persisted in localStorage or the desktop settings database, so a direct rename would risk a wrong first paint or a lost preference.

## What changes
- Rename the old decorative theme id to `galaxy` and the terminal-rain theme id to `code-rain` across client registries, CSS selectors, tests, localized settings copy, boot-time splash styling, and server allow-lists.
- Rename theme effect components and internal identifiers to generic names while preserving the existing palette values, canvas behavior, glow treatments, and background visibility rules.
- Add client and server read-side migration so persisted legacy ids (`star-wars`, `matrix`) resolve to the new ids before first paint or API response, with write-back where possible.
- Keep write paths strict: new PATCH requests and MCP settings writes accept only current ids.

## Impact
- Affected specs: `desktop-theme-system`
- Affected code: The change touches the theme registry and palette tests, global theme CSS, boot script, theme context boot-read logic, theme effect component filenames/imports, view-local theme checks for the starfield, localized settings/setup strings, and server theme allow-list/read handlers including the MCP app settings tool.
- Out of scope: user-facing accent variant toggles, sound effects, animated intro sequences, custom cursor icons, icon redesign, and localized theme documentation under `docs/guide/*/settings/1-themes.md`.
