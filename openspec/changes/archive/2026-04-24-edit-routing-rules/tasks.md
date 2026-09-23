## 1. Server: lock default rule to sr-developer

- [x] 1.1 In `server/modules/agents/runtime/profile-manager.ts` `validateStructural`, reject profiles whose `default: true` rule has `agent !== 'sr-developer'`
- [x] 1.2 Add unit test in `server/modules/agents/runtime/profile-manager.test.ts` covering reject case + accept case
- [x] 1.3 Verify `server/modules/agents/runtime/profiles-router.test.ts` POST/PATCH flows still pass; add a 400 regression test for `{default:true, agent:'custom-foo'}`

## 2. Client dialog: add edit mode to RoutingRuleDialog

- [x] 2.1 Add `mode: 'add' | 'edit'` and `initial?: { tags: string[]; agent: string }` props to `RoutingRuleDialog`
- [x] 2.2 Pre-fill tags + agent from `initial` when `open && mode === 'edit'`
- [x] 2.3 Title and primary button label switch: "Add routing rule" / "Add rule" vs "Edit routing rule" / "Save changes"
- [x] 2.4 Keep existing reset-on-open behavior for `mode === 'add'`

## 3. Client editor: wire tag edit + lock default rule

- [x] 3.1 Add `setRoutingRuleTags(idx, tags)` handler in `ProfileEditor`
- [x] 3.2 Add `editRoutingIdx: number | null` state; open dialog in edit mode when set
- [x] 3.3 Guard `removeRoutingRule`, `setRoutingRuleAgent`, `moveRoutingRule` to no-op when target rule is `default: true`
- [x] 3.4 In `RoutingRow`, render pencil button on hover for tag rules only; wire `onEdit`
- [x] 3.5 In `RoutingRow`, when rule is `default: true`: hide agent select (or render read-only), hide ✕, hide reorder arrows, render "core" hint next to existing "default" badge
- [x] 3.6 Confirm default badge + new "core" hint don't visually collide

## 4. Tests

- [x] 4.1 `ProfileEditor.test.tsx`: editing tags on a tag rule updates tags in place and preserves index
- [x] 4.2 `ProfileEditor.test.tsx`: pencil button absent on default rule
- [x] 4.3 `ProfileEditor.test.tsx`: delete/reorder/agent-change on default rule is a no-op
- [x] 4.4 `RoutingRuleDialog.test.tsx` (create if absent): edit-mode pre-fills tags and agent from `initial`

## 5. Verify

- [x] 5.1 `npm run typecheck` passes
- [x] 5.2 `npm test` passes
- [x] 5.3 Manual smoke: open Agents → Profiles → edit a tag on `default` profile's `frontend` rule; edit succeeds and persists after refresh
- [x] 5.4 Manual smoke: default rule row shows no pencil/✕/arrows and agent is `sr-developer`
