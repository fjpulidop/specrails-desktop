# continuity

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/ResumeAfterRestartDialog.tsx](components/ResumeAfterRestartDialog.tsx)

## Feature dependencies

- [inbox](../inbox/README.md)
- [missions](../missions/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Pick up where you left off

After a restart (the app was closed, an update was installed, or it stopped
unexpectedly), `ResumeAfterRestartDialog` lists, once per launch:

- **Mission turns that were cut.** The server keeps a durable marker per turn in
  flight and turns it into a resume offer on the next start
  ([server module](../../../../server/modules/continuity/README.md)). Resuming
  sends a short continuation message (in the person's language) through the
  normal send path, so the mission continues its own provider session. The
  queue id is derived from the interrupted turn, so a retry never sends twice.
- **Rail and loop runs the restart paused.** The runs that were running at a
  graceful shutdown, matched to their Inbox items; Resume is the Inbox's own
  action (the run card's Resume route), so restart-pause semantics stay as they are.

Nothing resumes without a click. "Not now" dismisses the mission offers; paused
runs stay in the Inbox. The API lives in [lib/continuity-api.ts](../../lib/continuity-api.ts)
because the update card also uses it ("Install when nothing is running").

The dialog is the only modal allowed at launch ([startup queue](../../lib/startup-queue.ts)):
it reports whether it has offers (offers defer the product tour to the next clean
launch) and holds the queue while open, so attention toasts wait and the update
offer does not appear. Escape or an outside click only hides it for this launch.
