# Tasks: Hide SMASH-capable option in Explore mode for Codex projects

## 1. Provider capability utility

- [x] 1.1 [frontend] Create `client/src/features/providers/lib/provider-capabilities.ts` exporting `ProviderId` type and `isSmashCapable(provider: string | null | undefined): boolean` that returns `true` iff `provider === 'claude'`
  - **Files:** Create: `client/src/features/providers/lib/provider-capabilities.ts`

## 2. Guard SMASH-capable element in ContextScopeSlider

- [x] 2.1 [frontend] Add optional `smashCapable?: boolean` prop (default `true`) to `ContextScopeSliderProps` in `ContextScopeSlider.tsx`; update destructured signature and change the `scope-smash-hint` render condition from `{value.contractRefine && ...}` to `{value.contractRefine && smashCapable && ...}`
  - **Files:** Modify: `client/src/features/chat/components/ContextScopeSlider.tsx`

- [x] 2.2 [frontend] In `ProposeSpecModal.tsx`, import `isSmashCapable`, destructure `provider` from `useDefaultSpecModel`, derive `const smashCapable = isSmashCapable(provider)`, and pass `smashCapable={smashCapable}` to `ContextScopeSlider`
  - **Files:** Modify: `client/src/features/specs/components/ProposeSpecModal.tsx`

## 3. Server-side defence-in-depth

- [x] 3.1 [backend] In `server/project-router.ts`, inside `POST /:projectId/chat/conversations`, compute `safeRawScope` that forces `contractRefine: false` when `provider !== 'claude'` and pass it to `normalizeContextScope` in place of the raw `rawScope`
  - **Files:** Modify: `server/project-router.ts`

## 4. Tests and verification

- [x] 4.1 [frontend] Add unit tests for `isSmashCapable` in `client/src/features/providers/lib/__tests__/provider-capabilities.test.ts` covering: `'claude'` → true, `'codex'` → false, `null` → false, `undefined` → false, unknown string → false
  - **Files:** Create: `client/src/features/providers/lib/__tests__/provider-capabilities.test.ts`

- [x] 4.2 [frontend] Add or extend `ContextScopeSlider` tests to assert: `scope-smash-hint` is absent from the DOM when `smashCapable={false}` even if `contractRefine` is true; hint is present when both `contractRefine` and `smashCapable` are true
  - **Files:** Modify: `client/src/features/chat/components/__tests__/ContextScopeSlider.test.tsx`

- [x] 4.3 [frontend] Add or extend `ProposeSpecModal` tests to assert: when `useDefaultSpecModel` returns `provider='codex'`, the `scope-smash-hint` element is not in the rendered output at any preset level
  - **Files:** Modify: `client/src/features/specs/components/__tests__/ProposeSpecModal.test.tsx`

- [x] 4.4 [backend] Add a server test for `POST /chat/conversations` verifying that when `project.provider === 'codex'` the stored conversation's `context_scope.contractRefine` is `false` even when the request body sends `contractRefine: true`
  - **Files:** Modify: `server/project-router.test.ts`

- [x] 4.5 [frontend] Run `cd client && npx tsc --noEmit` and `cd client && npm run test:coverage` — confirm all thresholds pass (lines/statements ≥ 80%, functions ≥ 70%)
  - **Files:** (no file changes — verification step)

- [x] 4.6 [backend] Run `npm run typecheck` and `npm test` — confirm server coverage thresholds pass (lines/functions/statements ≥ 80%)
  - **Files:** (no file changes — verification step)
