# Native window surfaces

In the desktop app, a modal surface can open as a real OS window instead of an
in-page Radix modal. The browser build keeps the modal. App Settings, Project Settings, Job
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

Callbacks become results. Settings' "Replay tour" used to call an opener
callback. In a window it reports `{ action: 'openOnboarding' }`, then closes.
`App.tsx` handles it.

**Shell requests.** `openAppSettings`, `openProjectSettings` and
`openBudgetPanel` ([`lib/app-settings-events.ts`](../../client/src/lib/app-settings-events.ts))
ask the app shell through window events, and a surface window has no shell.
Every surface window forwards them
([`lib/surface-shell-requests.ts`](../../client/src/lib/surface-shell-requests.ts)):
it reports `{ action: 'shell', request }` and closes (the live board stays
open; the host brings its opener forward), so the opener, focused by the host
on close, shows the place in front. A project-settings request carries the
surface's `projectId` (Job detail's "Configure" opens the run's project, at
the requested section; the shell switches project first when it differs).
The opener listens app-wide (`listenSurfaceShellRequests` in `AppRoutes`), not
per `<Surface>`: a window whose opener component unmounted still reaches it.
The result is validated (known kinds, app-settings sections, ≤ 256-char
fields) and replayed as the same local window event.

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
(`mission_windows::is_trusted_interface`, and `surface_window_open` is in the
mission windows' command list). Surface, loop and plugin windows
cannot, and fall back to the in-window modal.

## Bootstrapping the window

**No visible loading gap.** The host creates the window hidden, on the opener's
dialog panel color (`surfacePanelColor`, sent as `background`). The page shows
it (`RevealWhenPainted` → `revealCurrentSurfaceWindow`) as soon as the framed
dialog is in the DOM and its fonts are ready, in a macrotask after the commit:
the window paints its current DOM the moment it is shown, so the first visible
frame is the real content. Not `requestAnimationFrame`: WebKit runs no animation
frames in a hidden window, so a frame-based reveal never fired and every window
waited for the host's fallback. If the page never gets there, the host shows the
window after 2.5 s anyway.

**Opening is instant** through the spare window (below). A cold window (no spare
ready yet) takes about 0.8 s: create the webview, load the bundle, mount. Boot is
kept short: the token and the UI language load in parallel. Each surface's
component is in its own chunk and renders once that chunk has loaded, as a plain
component, not `React.lazy`: a lazy component suspends on its first render even
when its chunk is loaded, and React then holds the revealed content back (its
Suspense throttle, ~300 ms) on every open. The project list is still fetched once
before Job detail renders, because the isolated `DesktopProvider` resets the API
project until it knows its projects.

### The spare window (instant open)

One hidden window is kept loaded: `index.html?surfaceWindow=spare`, the surface
shell (WebSocket, theme, language, isolated `DesktopProvider`, toaster) with
every surface's chunk loaded and no surface (`SpareSurfaceWindowContent`). It
reports `surface_window_spare_ready` once it listens for its surface.

`surface_window_open` takes a ready spare when it opens a new window: it
registers it as that surface's window, adds the surface's extra permissions,
sets title, minimum size and size, centers it on the opener, and emits
`surface-window:assign` `{ surface, requestId, params }` to it. The page takes
that surface's URL (`history.replaceState`, so a reload reopens the surface and
route readers see it), replays the `localStorage` preferences changed since it
loaded as `storage` events (theme, language, accessibility…), refreshes the
project list when the surface names a project it does not know yet, renders the
surface and shows itself once painted, like a cold window. Click to painted
window: about 0.1 s (Settings), against ~0.8 s cold and 2.6 s before the reveal
fix.

The page confirms the assignment at once (`surface_window_spare_ready` again);
a spare that does not confirm within 0.5 s (its page died) is destroyed and the
window opens the cold way, so a dead spare never shows a blank window. Surface
windows are built with `background_throttling(Disabled)` (macOS 14+): WebKit
otherwise throttles a hidden page, suspends it and unloads it after about five
minutes, so a waiting spare could stop answering, and a cold window booting
hidden while the app is inactive could stall.

A spare is used once: it becomes that surface's window and closes with it, so no
state carries over between opens. The host loads the next spare 1.5 s later.
The main window asks for the first one 3 s after startup
(`surface_window_prewarm`; mission windows do not). On Windows and Linux a
spare's parent is the window that asked for it, so only that window can take it;
on macOS surface windows have no parent and any opener can. Without a ready spare
the window opens the cold way. Cost: one hidden webview (~70 MB).

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
is the window's content. The claim happens when the dialog commits, never while
rendering (`useSurfaceWindowFrame`): React throws renders away (something under
the dialog suspends, a concurrent render restarts) and mounts the dialog again
with a new id, and a claim made by a discarded render was never released, so
the window showed the in-page modal (scrim, card) for good. It keeps the Radix contract (focus trap, initial
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
| macOS | Native traffic lights over our header (`TitleBarStyle::Overlay`, hidden title) at their standard place, in a ~28pt strip at the top. The header's title row starts right below them, at its normal left padding (`surfaceHeaderInset` in `dialog.tsx`). `traffic_light_position` is not used: it did not take effect on these owned windows | No `parent`: a child `NSWindow` is minimized together with its parent as one group, so minimizing a surface window would minimize the whole app. It stays above its opener instead: when the opener comes forward, the host orders its open surface windows right above it (`keep_above_opener`), as an owned window behaves on Windows. Other apps' windows keep their place; it does not move with the opener and minimizes on its own. The host focuses the opener when the window closes |
| Windows | Native title bar (decorations on), then our header | Owned window: always above its owner; minimizing the opener minimizes it, minimizing it alone leaves the opener up |
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
- **Geometry.** The window saves its logical size (not its position) to
  `localStorage['specrails.surface.<id>.geometry']` (debounced, not while
  maximized, minimized or fullscreen). The next open passes it to the host,
  which clamps it to the surface minimum. Every new window opens centered on
  the window that opened it, both axes (`center_on_opener` /
  `centered_frame` in `surface_windows.rs`): computed from the opener's
  current frame, kept inside the opener monitor's work area (a window larger
  than the work area shrinks to it, never below its minimum; one that would
  spill over an edge slides in). The math runs in the desktop's uniform space:
  points on macOS, physical pixels on Windows/X11, so secondary displays and
  mixed scale factors place correctly. A minimized opener centers it on its
  monitor's work area; if the host cannot position windows (Wayland) it stays
  screen-centered. A reused window (single instance) keeps its place.
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

## The guide ("Learn more")

`openDocs()` ([`lib/docs-events.ts`](../../client/src/lib/docs-events.ts)) asks the
app shell for the guide through a window event. A surface window has no app
shell, so it mounts `SurfaceDocsHost`
([`features/docs`](../../client/src/features/docs/components/SurfaceDocsHost.tsx)):
every `HelpHint` / `openDocs()` call inside a surface opens the same Docs dialog,
at the same section, as an in-window modal over the surface (surfaces never
nest windows, and the surface floats above its opener, where the guide would be
hidden). Replay tour is hidden there: the tour runs in the main window. In the
browser and the modal fallback the shell's listener (`App.tsx`) handles it as
before.

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

The spare window gets the base set at creation; the surface's extra permissions
are added when it is assigned. Until then it may call only
`surface_window_spare_ready`.

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
