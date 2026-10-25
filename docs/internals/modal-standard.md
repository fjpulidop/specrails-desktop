# Modal standard

Every modal surface in the client follows one standard: one primitive, five
sizes, one anatomy, one scrim, named layers and one entrance animation. The
primitive lives in [`client/src/components/ui/dialog.tsx`](../../client/src/components/ui/dialog.tsx);
the layer scale lives in [`client/src/lib/layers.ts`](../../client/src/lib/layers.ts).
Tests for the contract: [`dialog-standard.test.tsx`](../../client/src/components/ui/__tests__/dialog-standard.test.tsx),
[`dialog-movable.test.tsx`](../../client/src/components/ui/__tests__/dialog-movable.test.tsx)
and the source guard [`modal-standard-guard.test.ts`](../../client/src/components/ui/__tests__/modal-standard-guard.test.ts).

## When a modal is the right pattern

Use a modal for a decision (confirm, launch) or a protected, focused task
(Add Spec, Settings). Do not use one for something a user consults while
working.

| Surface | Pattern |
|---|---|
| Confirms, launch dialogs, Add Spec | Modal |
| Settings | Modal (AGENTS.md: app settings are a modal; project settings are a route in board mode and `ProjectSettingsDialog` in Agent Mode, which has no routed dashboard) |
| Spec detail, Job detail | Entity modal (`layer="entity"`), resizable, geometry persisted |
| Loops, Plugins, Review packet | `fullscreen` modal with the standard header and a visible close. Candidates for routes. |
| Docs, Analytics, agent activity log, background-process logs | `workspace` modal today. These are read while working, so they are candidates for a right-side sheet. |
| Move to rail, Subscription usage, floating agent chat | Non-modal popovers and panels. Not dialogs. |

The route and sheet conversions are deliberately not done yet. Each needs its
own plan that keeps deep links working (`lib/global-route-mode-transition.ts`
and the Mission-mode review entry).

## Primitive

Every modal is a Radix dialog, either through `DialogContent` or, for full-screen
shells with custom key handling, through `DialogPrimitive.Content` wrapped in
`DialogLayerProvider`. Radix provides the focus trap, initial focus, Escape
stacking (only the top layer closes), `aria-labelledby`/`aria-describedby` and
`hideOthers`, so the page behind is inert. Do not hand-roll
`createPortal(<div role="dialog" aria-modal>)`. The source guard test rejects
new hand-rolled `aria-modal` dialogs outside `components/ui`.

Focus return is built in. On close, `DialogContent` refocuses the element that
had focus at open. If that node was remounted while the modal was open (sidebar
buttons are), it refocuses the live element with the same `id`, `data-testid`
or `aria-label`. Give modal triggers one of these.

## Sizes

Pass `size` to `DialogContent`. Call sites do not set `max-w-*`, `w-*` or `h-*`.

| Size | Geometry | Use |
|---|---|---|
| `confirm` | `max-w-md` (448px), auto height | All confirms |
| `form` | `max-w-lg` (512px), auto height | Short forms and pickers |
| `wide` (default) | `max-w-2xl` (672px), auto height up to 85dvh | Previews and multi-section forms |
| `workspace` | `92vw × 82vh`, `max-w-5xl` | Settings, Project settings, Docs, Analytics, Add Spec, Agents catalog, background-process logs |
| `fullscreen` | `96vw × 92vh` | Loops, Plugins, Review packet, Runtime graph |

Below 640px every size fills the window minus a 16px gutter, and `workspace`
and `fullscreen` fill it minus 8px. Heights are capped below the desktop title
bar (`lib/modal-safe-area.ts`).

## Anatomy

```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent size="form">
    <DialogHeader icon={<Rocket />} actions={/* optional */}>
      <DialogTitle>Launch all specs?</DialogTitle>
      <DialogDescription>Each spec starts on its own rail.</DialogDescription>
    </DialogHeader>
    <DialogBody>…</DialogBody>
    <DialogFooter start={<CostEstimate />}>
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button ref={primaryRef}>Launch 3 specs</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- The panel is a flex column with no padding. The header and footer never
  scroll. `DialogBody` is the only scrolling region.
- **Header** (`px-5 py-4`, bottom border): optional 16px accent icon, then the
  title (16px semibold) and an optional description (13px muted, at most two
  lines), then right-aligned actions, then the close button.
- **Close**: one 28×28 button with a 16px icon. It sits in the header row, or
  top-right when a surface renders no header. Hide it
  (`showCloseButton={false}`) only when the footer has an explicit Cancel or
  Close.
- **Footer** (`px-5 py-3`, top border): the `start` slot holds left-aligned
  secondary info or a destructive action such as Delete. On the right, Cancel
  (`variant="ghost"`) comes first, then the primary action (`default`, or
  `destructive` when it destroys data). Footer buttons use the Button default
  size. On narrow viewports the footer stacks with the primary on top.
- **Initial focus**: the primary for confirms and launch dialogs
  (`onOpenAutoFocus` → `primaryRef`), the first field for forms. `⌘↵` submits,
  and the primary shows the kbd hint.
- **Confirms** use `ConfirmDialog` (`components/ui/confirm-dialog.tsx`). It
  takes `tone` (`destructive` by default, `default` for non-destructive
  confirms such as merge or recover), `layer`, `busy`, `confirmDisabled`,
  `secondaryAction` and test ids. Initial focus goes to the confirm button.

## Copy

The title names the object or the decision ("Discard local changes?"). The
primary names the verb ("Discard changes"), never "OK" or "Confirm". The
description states the consequence, not instructions about the UI. Every
dialog has a `DialogDescription`, either visible or `sr-only`. A dialog that
truly has none passes `aria-describedby={undefined}`.

## Layers

| Layer | z | Members |
|---|---|---|
| `base` | 50 | Ordinary dialogs (default) |
| floating chat | 60 (grips 61) | Floating agent panel |
| `entity` | 65 | Spec detail, Job detail, compare, agent activity log, loop and blueprint previews |
| `stacked` | 70 | Anything opened from inside an entity modal or the floating panel: Flow prompts, SMASH, nested confirms |
| dock | 75 | Minimized chats dock (stays clickable over modals) |
| `capture` | 80 | Browser capture, web view, native browser pane, background-process logs, runtime graph |
| `media` | 100 | Lightboxes |
| toast | 110 | Toasts. Sonner portals to `<body>` (its own rule in `globals.css` pins it even higher) and switches to top-right while a modal is open, so a toast never covers a modal footer |

Pass `layer` to `DialogContent` (or to `ConfirmDialog`). A dialog rendered
inside another dialog inherits a layer automatically. Inside an `entity` modal
it climbs to `stacked`. Inside any other layer it stays on that layer, and
portal order puts the newer dialog on top. Do not write `z-[NN]` on overlay
surfaces. Use `DIALOG_LAYER_CLASS` / `LAYER_CLASS` from `lib/layers.ts`.

Two consequences of Radix modality to know about:

- While any modal is open, Radix sets `pointer-events: none` on `<body>` and
  hides everything outside the panel from assistive tech. The minimized chats
  dock paints above modals (layer 75) but is not clickable until the modal
  closes. Making it interactive would need an outside-interaction allowance in
  `dialog.tsx`.
- A raw-primitive surface (`DialogPrimitive.Content`) only gets automatic focus
  return when it captures the opener itself. Spec detail, Job detail, the
  lightbox (`MediaLightbox` in `features/chat/components/AttachmentPreviewLightbox.tsx`)
  and the browser-capture shell (`CaptureDialogShell` in
  `features/browser/components/browser-capture/NativeBrowserPane.tsx`) do.

## Shared surfaces

- `ConfirmDialog` (`components/ui/confirm-dialog.tsx`) for every confirm.
- `MediaLightbox` for every image/PDF preview (media layer, media scrim).
- `CaptureDialogShell` for the browser capture, web view and native browser
  pane (capture layer). It forwards Tab/Space/arrow keys to the remote page
  (`forwardsKey`) and only closes on a press on the scrim itself.

## Scrim, surface, motion

- Scrim: `bg-scrim backdrop-blur-sm`. `--color-scrim` is `rgb(0 0 0 / .6)` on
  dark themes and `rgb(15 15 40 / .35)` on Aurora Light. Lightboxes use
  `bg-scrim-media` (`rgb(0 0 0 / .85)`).
- Surface: `bg-popover`, `border-border/30`, `rounded-xl`, `shadow-xl`.
  `shadow-2xl` is reserved for the floating chat. Modals do not use
  `glass-card`.
- Motion: one entrance, fade plus 0.98 scale over 180ms with an exponential
  ease-out, and a 120ms exit. Both are off under `prefers-reduced-motion`. The
  `modal-panel` and `modal-scrim` classes in `globals.css` apply them through
  the standalone `scale` property, so they compose with Tailwind v4's
  `translate` centering. Non-Radix surfaces opt in with `modal-enter`.

## Resizing

Only the `workspace` size is resizable (`movableResizable`), plus Spec detail
and Job detail, which own their geometry. The modal stays centered and resizes
from corner and edge grips. There is no whole-panel drag. The grips render
inside the panel (`ResizeGrips placement="inset"`), so they paint above the
panel's own scrim and sit inside the focus trap, which keeps keyboard resize
(arrows, Shift for large steps, Home/End, 0 to reset) reachable. Pass
`persistKey="specrails.modal.<surface>"` so a workspace remembers its size.
Confirms, forms and previews are never movable. Below 900px the grips are
hidden.

## Type floor

The minimum for any text run inside a modal is 12px. 11px is allowed only on
`h-5` chips and pills at ≥70% foreground, and those carry a `data-chip`
attribute (see [mission rail cards](mission-rail-cards.md)). Chart axes are
12px. The guard test rejects `text-[9px]`, `text-[10px]` and `text-[10.5px]`
in modal files.
