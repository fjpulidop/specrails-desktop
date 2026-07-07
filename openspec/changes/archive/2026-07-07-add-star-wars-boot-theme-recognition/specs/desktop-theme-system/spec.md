## MODIFIED Requirements

### Requirement: No flash of wrong theme on app boot

On every app page load, the document root SHALL have its `data-theme` attribute set to the user's chosen theme before the React application hydrates. The chosen theme value SHALL be cached in `localStorage` under a documented key whenever the server-side value changes. The anti-FOUC boot allow-list SHALL recognize every built-in theme id that can be selected by the app, including `star-wars`, and the inline splash screen SHALL define matching pre-React splash variables for every built-in theme that may be applied by the boot script.

#### Scenario: Returning Star Wars user sees the Star Wars theme on first paint
- **WHEN** `localStorage.getItem('specrails-desktop:ui-theme')` returns `star-wars` before React hydrates
- **THEN** the anti-FOUC boot script applies `document.documentElement.dataset.theme = 'star-wars'` instead of falling back to another theme

#### Scenario: Star Wars splash variables are available before React hydrates
- **WHEN** the boot script applies `html[data-theme="star-wars"]` and the inline splash screen renders
- **THEN** the splash screen resolves Star Wars-specific background, foreground, primary, secondary, and muted variables from `client/index.html`
