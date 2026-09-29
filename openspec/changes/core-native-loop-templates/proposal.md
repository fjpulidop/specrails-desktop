## Why

The loop template gallery shipped 44 starters, but only eight have a Core
definition variant. The other 36 (`opsx-lifecycle` and 35 ported patterns) were
legacy Desktop-traversal graphs. A Core that no longer advertises engine 1
refuses fresh legacy runs (`legacy_engine_unavailable`), so cloning one of them
produced a loop that could not start until it was converted. Many also
duplicated each other or the editable built-in loops (`opsx-lifecycle` is the
legacy Quick SDD graph; `ship-and-green`/`spec-first-ship` overlap Implement),
and two `*-weekly` entries implied scheduling the loops module does not have.
The owner decided to keep only the Core-native starters.

## What Changes

- The template catalog is exactly the eight starters in
  `CORE_STARTER_TEMPLATE_IDS`. With `engineV2` + `workflowDefinitions` they are
  served as Core definitions; older Core packages still receive their legacy
  graphs.
- Remove `opsx-lifecycle` from the gallery. `opsxLifecycleGraph` stays as the
  legacy variant of the `factory:sdd-quick-openspec` built-in.
- Delete the 35 ported templates, `PortSpec` and `compilePortSpec`, and their
  catalog strings in the 8 locales.
- The 15-value category taxonomy is unchanged; the gallery shows only
  categories present in the catalog.
- Loops previously cloned from a removed template keep their own graph and are
  unaffected. `POST /loops/from-template/:id` answers 404 for removed ids.

## Capabilities

### Modified Capabilities

- `loop-template-catalog`: catalog restricted to Core-native starters; porting
  and `opsx-lifecycle` registration removed.
- `opsx-lifecycle-loop`: the lifecycle graph is no longer a gallery template.

## Impact

`server/modules/loops/runtime/loop-templates.ts`, removed
`loop-templates-ported.ts`, template tests, boundary manifest, source map and
`client/src/locales/*/loops.json`.
