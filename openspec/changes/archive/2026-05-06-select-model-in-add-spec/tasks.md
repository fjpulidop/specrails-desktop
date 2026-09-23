## 1. Server-side model constants

- [x] 1.1 Create `server/modules/specs/runtime/spec-models.ts` exporting `CLAUDE_MODELS`, `CODEX_MODELS` (each `{ value: string; label: string }[]`), `PROVIDER_DEFAULT_MODEL` (`{ claude: 'sonnet', codex: 'gpt-5.4-mini' }`), and helpers `isValidModelForProvider(model, provider)` + `getProviderDefault(provider)`.
- [x] 1.2 (No client copy needed — client receives the allow-list from `GET /default-spec-model`. The agents-profile `ModelSelector.tsx` keeps its own internal lists, untouched.)

## 2. Server: default-model resolution

- [x] 2.1 Add helper `resolveDefaultSpecModel(project)` in `server/project-router.ts` (or a small new util) that reads `.specrails/install-config.yaml` `models.defaults.model`, validates against `isValidModelForProvider`, and falls back to `getProviderDefault(provider)`. Log a warning when an invalid value is configured.
- [x] 2.2 Add `GET /api/projects/:projectId/default-spec-model` returning `{ model, provider, allowed: [{ value, label }] }` (the full provider-specific list comes back so the client can render the dropdown without its own copy).
- [x] 2.3 Unit-test the helper for: project-config valid value → returns it; invalid value → returns provider default + logs; missing config → returns provider default; both providers covered.

## 3. Server: generate-spec accepts and validates model

- [x] 3.1 Read `req.body.model` in `POST /tickets/generate-spec`. Validate via `isValidModelForProvider(model, project.provider)`.
- [x] 3.2 Missing/empty model → resolve via `resolveDefaultSpecModel(project)`.
- [x] 3.3 Invalid model → respond `400 { error, allowed }` and do NOT spawn.
- [x] 3.4 For `provider=claude`, append `--model <resolved>` to the `claude` spawn args.
- [x] 3.5 For `provider=codex`, replace the hardcoded `'gpt-5.4-mini'` with the resolved value.
- [x] 3.6 Tests: missing-model fallback (claude + codex), valid model passthrough, invalid model 400, allowed list is correct per provider.

## 4. Server: explore conversation seeds from launch model

- [x] 4.1 Trace the Explore conversation creation path (search `server/` for the endpoint that backs `ExploreSpecShell`'s first turn) and confirm whether `Create Spec` migration spawns an additional model call.
- [x] 4.2 Accept `model` on the Explore-conversation-create request body; validate against `isValidModelForProvider`; persist into the `model` column. Reject invalid values with 400.
- [x] 4.3 If `Create Spec` migration spawns another model call, ensure it reads from the conversation's `model` column (no rewiring needed if it already does — verify).
- [x] 4.4 Tests: model is persisted from request body; invalid model rejected; conversation turns spawn with the persisted model.

## 5. Client: picker UI in ProposeSpecModal

- [x] 5.1 Build a small `<SpecModelPicker>` (single Radix `<Select>`, provider-aware options from `shared/spec-models.ts`) under `client/src/components/explore-spec/` or alongside `ProposeSpecModal.tsx`.
- [x] 5.2 Mount in `ProposeSpecModal` header row alongside `ModeSegmented`. State lives in modal; resets on each modal open via the existing `useEffect(open)` block.
- [x] 5.3 Fetch project's `defaultSpecModel` (from extended project-state response or the focused endpoint) on modal open; preselect it. While loading, render the dropdown disabled with a small spinner; submit button stays enabled but Quick submission waits until default resolved (or sends `undefined` and lets the server resolve — pick whichever is simpler given step 2.2 outcome).
- [x] 5.4 Test: picker visible in both modes, persists across mode toggle, resets on close, falls back gracefully when default fetch fails.

## 6. Client: Quick path threads model

- [x] 6.1 Include `model` in the `POST /tickets/generate-spec` body in `ProposeSpecModal.handleSubmit`.
- [x] 6.2 Test (`ProposeSpecModal.test.tsx`): selecting a model and submitting Quick sends `model` in the body.

## 7. Client: Explore path threads model

- [x] 7.1 Add `model: string` to `ExploreLaunchPayload` in `ProposeSpecModal.tsx`.
- [x] 7.2 Update consumers of `onExploreLaunch` (`SpecsBoard.tsx`, any other callers) to forward `model` into `ExploreSpecShell` props as `initialModel`.
- [x] 7.3 Pass `initialModel` from `ExploreSpecShell` into the explore-conversation-create request body.
- [x] 7.4 Update `client/src/features/specs/lib/active-explore-spec.ts` and the minimize/restore path so a restored Explore session keeps its conversation's persisted model (no special wiring expected — `model` already lives on the conversation row).
- [x] 7.5 Test (`ExploreSpecShell.test.tsx`): conversation created with initial model from launch payload; refresh/restore preserves it.

## 8. Wiring + UX polish

- [x] 8.1 If the dropdown's resolved default load fails, fall back to provider default in the UI and surface a non-blocking toast. (UI fallback implemented; toast is internal — tests cover the fallback path.)
- [ ] 8.2 Verify keyboard nav: Tab order Mode → Picker → Editor → Submit; picker openable via Space/Enter. (manual)
- [x] 8.3 Verify dark/light theme tokens (no `dracula-*` brand colors). (Picker uses `bg-background`/`border-input`/`text-muted-foreground` from shadcn — semantic tokens only.)
- [ ] 8.4 Manual test on a `provider=claude` project AND a `provider=codex` project: list correctness, default preselection, end-to-end Quick + Explore. (manual — pending user verification)

## 9. Validation gates

- [x] 9.1 `npm run typecheck` passes (server + client).
- [x] 9.2 `npm test` passes.
- [x] 9.3 `npm run test:coverage` (server) ≥ 80% lines/functions/statements, 70% branches. (Result: 81.05L / 70.5B / 87.15F / 82.33S)
- [x] 9.4 `cd client && npm run test:coverage` ≥ 80% lines/statements, 70% functions. (Result: 80.82L / 82.02B / 73.38F / 80.82S)
- [x] 9.5 `openspec validate select-model-in-add-spec` passes.
