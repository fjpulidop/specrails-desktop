# Native window surfaces

In the desktop app, a modal surface can open as a real OS window instead of an
in-page Radix modal. The browser build keeps the modal. Settings, Job
detail and the live board (`live-board`: in the desktop app every way in opens or focuses this window, never the in-page dialog; a second-screen board
whose card actions are reported to the main window, which the host brings
forward through `focus_opener_on_result`) are the surfaces. Loops and Plugins, which already had their
own windows (`loop_windows.rs`), now open there instead of in their Mission-mode
modals (`useNativeWindowHandoff`). Every other dialog still follows the
[modal standard](modal-standard.md) unchanged.

| Piece | Where |
|---|---|
| Host: open, permissions, result and close events | [`src-tauri/src/surface_windows.rs`](../../src-tauri/src/surface_windows.rs) |
| Client transport (route, open, events, geometry, preference mirroring) | [`client/src/lib/native-surfaces.ts`](../../client/src/lib/native-surfaces.ts) |
| Opener API: `useNativeSurface` / `<Surface>` | [`client/src/components/ui/surface.tsx`](../../client/src/components/ui/surface.tsx) |
| Window presentation of a dialog: `SurfaceWindowFrame` | [`client/src/components/ui/dialog.tsx`](../../client/src/components/ui/dialog.tsx) |
| Surface window content per id | [`client/src/SurfaceWindowContent.tsx`](../../client/src/SurfaceWindowContent.tsx) |
| Tests | [`surface.test.tsx`](../../client/src/components/ui/__tests__/surface.test.tsx), `surface_windows::tests` |

## The constraint

Each native window is its own webview and JS context. React state, callbacks
and contexts do not cross windows. A surface therefore crosses the boundary as:

1. **An id and string params.** They become the window's URL,
   `index.html?surfaceWindow=<id>&requestId=<id>&<param>=<value>`. The host
   accepts only the params a surface declares (`SURFACES` in
   `surface_windows.rs`), each at most 256 printable characters.
2. **A result channel.** The surface calls `reportSurfaceResult(value)` (≤ 64 KB
   JSON). The host knows the caller's window label from the IPC message, looks
   up that window's request and emits `surface-window:event`
   `{ kind: 'result', requestId, result }` **to the opener only**. A window can
   answer only its own request.
3. **A close event.** When the window is destroyed (close button, Escape, ⌘W,
   crash) the host emits `{ kind: 'closed', requestId }` to the opener and
   focuses the opener window.

Callbacks become results. Settings' "Replay tour" and "Open budget" used to
call opener callbacks. In a window they report `{ action: 'openOnboarding' }`
or `{ action: 'openBudget' }`, then close. `App.tsx` handles them.

## Opening a surface

```tsx
<Surface
  id="app-settings"
  open={settingsOpen}
  params={{ section, settingId }}
  onClose={() => setSettingsOpen(false)}
  onResult={handleSettingsResult}
>
  <SettingsDialog open={settingsOpen} onClose={…} />   {/* web build / fallback */}
</Surface>
```

`useNativeSurface(options)` is the hook form. It returns `true` while a native
window presents the surface; the caller then renders nothing. `JobDetailModal`
uses the hook internally, so every existing call site gets the window with no
change.

The native path is taken only when all of these hold
(`nativeSurfaceEnabled`):

- the app runs in Tauri (`isTauri()`);
- the id is in `NATIVE_SURFACE_IDS` (client) and `SURFACES` (host);
- this window is not itself a surface window (surfaces never nest windows);
- `localStorage['specrails.nativeSurfaces']` is not `'off'` (support switch).

If `surface_window_open` fails (an older host, a refused caller), the hook logs
a warning and renders the modal. Nothing is lost.

Who may open: the main window and mission windows
(`mission_windows::is_trusted_interface`). Surface, loop and plugin windows
cannot, and fall back to the in-window modal.

## Bootstrapping the window

**No visible loading gap.** The host creates the window hidden, on the opener's
dialog panel color (`surfacePanelColor`, sent as `background`). The page shows
it (`revealCurrentSurfaceWindow`) two frames after the framed dialog is in the
DOM, so the first visible frame is the real content. If the page never gets
there, the host shows the window after 2.5 s anyway. Boot is kept short: the
token and the UI language load in parallel, and the surface content is in the
main chunk (not lazy). The project list is still fetched once before Job
detail renders, because the isolated `DesktopProvider` resets the API project
until it knows its projects.

The window loads the same bundle, so `main.tsx` runs as usual: `initAuth()`
reads the desktop token, `installFetchInterceptor()` and `initI18n()` apply the
persisted language, and `applyA11yPrefs()` sets density and motion before the
first paint. `ThemeProvider` reads the persisted theme. `AppRoutes` sees
`?surfaceWindow=` and renders `SurfaceWindowRoutes`: WebSocket, theme,
language, an **isolated** `DesktopProvider`, tooltips and toasts, and no app
shell.

Project context: the window never inherits "the active project". Entity
surfaces carry an explicit `projectId` param (Job detail falls back to the
opener's active project when the caller gave none). The window selects it in
its own isolated `DesktopProvider`, so `getApiBase()` and WebSocket project
filters work as in the main window, and selecting it never changes the main
window's project.

## Presentation inside the window

`SurfaceWindowFrame` marks the window. The first dialog that mounts inside it
is the window's content. It keeps the Radix contract (focus trap, initial
focus, Escape, `aria-*`), but:

- no scrim, no size token, no resize grips: the panel fills the window
  (`SURFACE_WINDOW_PANEL_CLASS`), and the OS resizes the window;
- no in-page close button: the window closes with the OS controls (and Escape);
- the header is the window's title bar (`data-tauri-drag-region`). On macOS the
  traffic lights have the top strip to themselves and the title row starts
  right below them.

Dialogs opened inside it (confirms, pickers) are ordinary in-window modals on
their normal layers. Raw-primitive surfaces (Job detail) read
`useSurfaceWindowFrame()` and apply the same rules.

## Chrome and modality per OS

Surface windows use the OS window controls only; the page never draws its own
close, minimize or zoom buttons.

| OS | Chrome | Relationship to the opener |
|---|---|---|
| macOS | Native traffic lights over our header (`TitleBarStyle::Overlay`, hidden title) at their standard place, in a ~28pt strip at the top. The header's title row starts right below them, at its normal left padding (`surfaceHeaderInset` in `dialog.tsx`). `traffic_light_position` is not used: it did not take effect on these owned windows | Child `NSWindow` (`parent`): moves with the opener and stays above it |
| Windows | Native title bar (decorations on), then our header | Owned window: always above its owner and minimized with it |
| Linux | Native title bar, as on Windows | Transient for the opener (GTK); the window manager decides stacking |

If the traffic-light strip changes, adjust `surfaceHeaderInset` so the title row stays right below it.

**The opener is not disabled.** Settings and Job detail are tasks you do next
to your work: reading a run while the board updates is the point. Disabling
the main window would add a lockout risk (a crashed child) for no gain. A true
macOS sheet is not available from Tauri's window API. Decisions that must block
(confirms) stay in-window `ConfirmDialog`s, or use
`@tauri-apps/plugin-dialog` `ask`/`confirm`, which are app-modal native alerts.
Surface windows already have `dialog:allow-ask`/`allow-confirm`.

## Focus, Escape, geometry, single instance

- **Escape** reaches the Radix content in the window and closes it like the
  modal did (`onOpenChange(false)` → `onClose` → close the window). Nested
  dialogs close first.
- **Focus return.** The host focuses the opener window when a surface closes.
  `useNativeSurface` remembers the element focused at open and refocuses it on
  the `closed` event.
- **Opener-driven close.** If the opener sets `open` back to false, the hook
  closes the window. If the opener unmounts, the window stays open as an
  independent window.
- **Geometry.** The window saves its logical size and position to
  `localStorage['specrails.surface.<id>.geometry']` (debounced, not while
  maximized). The next open passes it to the host. The host clamps the size to
  the surface minimum and ignores a position that no longer lands on a
  connected monitor (it centers instead).
- **Single instance.** One Settings window app-wide (reopening focuses it).
  One window per job for Job detail (`(surface, params)` key). A reused window
  keeps its original request id, and the host returns it, so a new opener
  follows the live window's events. At most 16 surface windows.

## Preferences across windows

Windows share `localStorage`, but WebKit does not reliably fire `storage`
events across webviews. A surface window mirrors its own `setItem` and
`removeItem` calls (`mirrorSurfaceStorageWrites`). The main window replays them
as `storage` events (`replaySurfaceStorageWrites`). Theme, language,
accessibility, effects and editor preferences changed in a Settings window
apply live in the main window (`ThemeProvider` and `LanguageProvider` listen
for `storage`). Server-backed state (projects, webhooks, provider connections)
already reaches every window through the API and WebSocket.

## Toasts

A surface window renders its own toaster: a toast shows in the window where
the person acted. (Relaying them to the opener hid them: a failed Continue
in the Job detail window landed in the main window behind it, and nobody saw
it.)

When the surface window closes itself (its close button, Escape, "do X, then
close"), it hands the toasts still on screen to its opener
([`lib/surface-toasts.ts`](../../client/src/lib/surface-toasts.ts)):
`useTrackSurfaceToasts` keeps the on-screen list (sonner's `useSonner`), and
`handOffSurfaceToasts` relays each as text through `surface_window_toast`
before the window closes. The host delivers it to the opener only
(`surface-window:toast`); the opener (`useShowSurfaceToasts`, main and mission
windows) shows it under a stable `surface:<window>:<id>` id. A handed-off
toast has no action button (the window that would run it is gone), and a
loading toast is not handed off (its update would never come). Toasts with no
text (fully custom JSX) are not handed off.

In every window, toasts stay bottom-right and stay clickable over an open
modal ([modal standard](modal-standard.md), layers).

## Permissions (least privilege)

`capabilities/default.json` stays bound to the `main` webview only
(`invoke_guard` tests pin this). Each surface window gets a capability bound to
its exact random label (`surface-<id>-<128-bit hex>`), created when the window
opens, like loop and mission windows. That is tighter than a static
`surface-*` glob, which would match any webview later created with that
prefix.

The live board window has no extra permission or command: it reads the API and reports
`{ action: 'primary' | 'open', card }` results that the main window runs.

| Granted to every surface window | Extra for `app-settings` |
|---|---|
| `core:event:default`, `core:window:default`, close, minimize, toggle-maximize, start-dragging, set-title, show, set-focus; `dialog:allow-message/confirm/ask`; clipboard read/write text; `shell:allow-open` for http(s) and editor URL schemes | `updater:default`, `process:allow-restart` (the Updates section) |

Custom commands (`invoke_guard`): a surface window may call
`surface_window_result`, `surface_window_toast`, `desktop_reveal_path` and `desktop_save_text`, plus
its surface's own list (`check_app_update` and `restart_app` for Settings). It
can never open windows, browsers or missions, spawn the sidecar, or change
tray state. The attention host commands (`desktop_notify`, `desktop_set_badge`,
`desktop_focus_state`) are main-window only: the settings window changes the
prefs through `PATCH /api/attention-prefs` and the main window applies them. Navigation is locked to the app origin and to its own
`surfaceWindow=<id>` page. New windows are denied.

## Adding a surface

1. Add it to `SURFACES` in `surface_windows.rs` (title, size, minimum, params,
   extra commands and permissions, singleton or per target) and to
   `NATIVE_SURFACE_IDS`.
2. Render it in `SurfaceWindowContent.tsx`: read params, select the project if
   it has one, turn callbacks into `surface.report(...)` plus `surface.close()`.
3. Wrap the opener in `<Surface>`, or call `useNativeSurface` inside the modal
   component.
4. Test the web fallback and the result mapping.

## Not converted yet

These keep the in-page modal. Grouped by the work each needs:

- **Entity modals.** Spec detail (`TicketDetailModal`, opened through
  `TicketDetailModalProvider`), compare view, agent activity log, loop and
  blueprint previews. They have serializable ids. Spec detail needs its
  mutations (move, launch, SMASH) to report results or go through the API.
- **Full-screen shells.** Review packet and Runtime graph. Review packet carries
  delivery decisions that need a result contract. Loops and Plugins are done
  through their existing windows; folding `loop_windows.rs` into `SURFACES`
  (owned windows, one permission model) is a later clean-up.
- **Workspace modals.** Docs, Analytics, Add Spec, Agents catalog, Project
  settings (`ProjectSettingsDialog`) and background-process logs. Docs and
  Analytics are URL-driven places (`?overlay=`) and need their deep links kept.
- **Forms and pickers.** Add project, launch dialogs, rail and target-PR
  dialogs, integrations. They are short, return a value and stay modal, or
  become small owned windows once a result shape exists.
- **Confirms.** `ConfirmDialog` call sites. Candidates for the native
  `plugin-dialog` `ask` in Tauri, keeping `ConfirmDialog` in the browser.
- **Capture and media.** Browser capture, web view, native browser pane and
  lightboxes. They stay in-window: they position native child webviews in the
  main window.
