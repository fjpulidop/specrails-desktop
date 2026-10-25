# onboarding

First run that produces a real result: the **sample project**. The Welcome screen
offers *Try it on a sample project* next to *Add your project*; this capability owns
that flow end to end. The server side is
[server/modules/onboarding](../../../../server/modules/onboarding/README.md).

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/SampleGuide.tsx](components/SampleGuide.tsx)
- [components/SampleProjectEntry.tsx](components/SampleProjectEntry.tsx)

## Feature dependencies

- [jobs](../jobs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## The flow

1. **Entry** ([SampleProjectEntry](components/SampleProjectEntry.tsx)): a button on the
   Welcome screen with the cost said up front: a labelled static estimate
   ("≈ $0.30–$1 · estimate"), or "no API cost" when a local engine is the only
   ready engine. Looking around is free.
2. **Dialog** ([SampleProjectDialog](components/SampleProjectDialog.tsx)): says what is
   created (a tiny tic-tac-toe repo, three specs), shows the **folder** (default
   `~/Specrails Samples/tic-tac-toe`, editable, never overwritten) and the cost of a later
   run ([SampleCostStatement](components/SampleCostStatement.tsx)). Creating spends nothing.
3. **Land on the Board** ([useActivateSample](hooks/useActivateSample.ts)): the sample
   project becomes the active project and the UI switches to Board mode, where the
   specs, rails and Review packet are visible.
4. **Guide** ([SampleGuide](components/SampleGuide.tsx)): exactly three steps, *spec ->
   rail -> review*, a non-modal card that outlines the real board elements
   (`data-tour="specs-list"` / `"rail-1"`). Dismiss or finish collapses it to a pill
   (*Show guide*, *Now add your own project*, *Remove sample*). Progress is per viewer
   (`localStorage`, try/catch, [sample-guide-state](lib/sample-guide-state.ts)).
5. **Run the first spec** ([RunFirstSpec](components/RunFirstSpec.tsx)): one call to
   action on the rail step. It assigns the first sample spec to a free rail and calls the
   ordinary `POST /rails/:n/launch` with the **preset** the server chose: Quick SDD
   (`factory:sdd-quick-openspec`), the cheapest priced model of the cheapest ready cloud
   provider, and a per-run soft cap (`runCapUsd`, $1: the run pauses and asks, through the
   existing budget gate) - or a configured local engine, which has no cap. Both are offered
   when both exist.
6. **No provider ready?** The readiness is validated before the run is offered. If nothing
   can run (nothing installed, or signed out) the same place offers **Watch a recorded run**
   ([RecordedRunDialog](components/RecordedRunDialog.tsx)): a bundled recording replayed with
   the demo-mode log fixtures (`demo-mode/fixtures/tour-log`), ending at a Review packet and
   labelled a recording throughout. "Check again" re-probes the providers.
7. **Remove** ([RemoveSampleDialog](components/RemoveSampleDialog.tsx)): unregisters the
   project; deleting the folder is a separate, unchecked, irreversible choice.

## Where the old tour went

The platform tour (the onboarding wizard) is no longer on the Welcome screen. Replay it from
**Docs (Help) -> Replay tour**, from the command palette (*Replay tour*), or from Settings ->
Appearance. They all ask the shell through `lib/onboarding-events.ts` (`replayTour()`).

## Invariants

- The sample is **one at a time** and app-wide (`desktop_settings` `onboarding.sample`); a second
  create returns the existing one. The guide only shows while the sample is the active project.
- Cost statements follow the launch-forecast rule: a dollar figure only when the provider is
  positively metered; a plan-billed provider says "no extra charge"; a local engine "no API cost".
  Everything is labelled an estimate. The run is capped, never silently unbounded.
- Nothing here launches a paid run by itself; the person presses *Run the first spec*.
- 8 locales in `locales/*/onboarding.json`; the three sample specs are translated server-side.

Run the adjacent tests with `npm run test --prefix client -- src/features/onboarding`.
