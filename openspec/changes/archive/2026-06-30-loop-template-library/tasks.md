## 1. Category taxonomy + template model — capability `loop-template-catalog`

- [x] 1.1 Add `LoopCategory` union + `LOOP_CATEGORIES` (the 15 values) to `server/loop-templates.ts`; add `category: LoopCategory` to the `LoopTemplate` interface.
- [x] 1.2 Categorise the 8 existing templates (ship-and-green→CI, verify-pass→Testing, ci-watch→CI, lint-and-fix→Quality, type-safe→Quality, coverage-climb→Testing, build-fix→CI, deploy-check→DevOps); ids/names unchanged.
- [x] 1.3 `server/loops-router.ts`: include `category` in the `GET /api/loop-templates` payload.
- [x] 1.4 Client: add optional `category` to `LoopTemplateSummary` (`client/src/lib/loops-api.ts`).

## 2. Porting transform + the ~40 templates — capability `loop-template-catalog`

- [x] 2.1 Add a `PortSpec`-style declarative shape + a `compilePortSpec()` helper in `server/loop-templates.ts` that builds a validated graph via the existing `aiLoopGraph`/`fixLoopGraph` layout grammar (`loopBack: 'last' | 'verify'`).
- [x] 2.2 Author ~32 NET-NEW Specrails-owned templates from the corpus patterns (`.claude/loops-corpus.json`), one per source loop minus the 8 already present, covering every category. Original naming + prompt text (NO verbatim source prose). Each: `category`, `tags`, gate steps via `{{cmd:*}}`, mutating steps inject `{{const:GUARDRAILS}}`, Decider goal = the exit condition.
- [x] 2.3 Confirm total catalog `>= 40` and every category represented.

## 3. Magic commands — capability `loop-magic-commands`

- [x] 3.1 Add optional `providerNative?: Record<string,string>` to `LoopCommand` (`server/loop-command-catalog.ts`); extend `expandCommands()` so `providerNative[provider]` wins for listed providers and falls back to `template` for unlisted ones, WITHOUT changing existing-command expansion.
- [x] 3.2 Add `{{cmd:loop}}` = `{ providerNative:{ claude:'/loop', codex:'$goal' }, template:<autonomous-loop preamble> }`, not `claudeOnly`.
- [x] 3.3 Add the distilled common commands (`test`, `lint`, `typecheck`, `build`, `coverage`, `format`, `commit`, `push`, `pr` [scope `all`], `ci-status`, `audit`, `docs-sync`, `review`) as Specrails-authored, tooling-agnostic templates; mutating ones embed `{{const:GUARDRAILS}}`.
- [x] 3.4 Verify `dominantTicketScope` / `referencesClaudeOnlyCommand` still behave correctly with the new entries.

## 4. Guardrails constant — capability `loop-constants-guardrails`

- [x] 4.1 Add `GUARDRAILS` to `BUILTIN_CONSTANTS` (`server/loop-constants.ts`) with the canonical hardened anti-gaming block; confirm `assertValidName` already reserves it (built-in ⇒ reserved).

## 5. Discovery UI — capability `loop-template-discovery`

- [x] 5.1 Pure filter module `client/src/lib/loop-template-filter.ts`: `filterTemplates(templates, { query, categories })` (substring over name/desc/tags/category; category OR; combined AND with query) + a `categoryCounts(templates)` helper.
- [x] 5.2 `LoopsPage.tsx`: search input + category chips row (counts, multi-select, clear) above the Templates grid; wire to the filter module; persist last filter to `localStorage` best-effort.
- [x] 5.3 Template card: render category badge + tags; localized no-results empty state with a clear-filter action.
- [x] 5.4 `TemplatePreviewModal.tsx`: show the category badge alongside the existing tags.

## 6. Internationalization (all 8 locales)

- [x] 6.1 `client/src/locales/en/loops.json`: add `gallery.search.placeholder`, `gallery.allCategories`, `gallery.noResults`, `gallery.clearFilter`, `gallery.resultCount`, and `categories.<Name>` for all 15 categories (English source of truth).
- [x] 6.2 Mirror the new keys into es, fr, de, pt, it, zh, ja (identical key tree + placeholders).
- [x] 6.3 Confirm `client/src/lib/__tests__/locale-parity.test.ts` passes for the extended namespace.

## 7. Tests

- [x] 7.1 `server/loop-templates.test.ts`: replace the hardcoded-id assertion with structural checks (valid category ∈ taxonomy, non-empty tags/description, graph validates, exactly one continue+one stop branch per Decider) + a `>= 40` count floor + every-category-covered check + guardrails-on-mutating-steps check.
- [x] 7.2 `server/loop-command-catalog.test.ts`: `{{cmd:loop}}` resolves to `/loop` (claude), `$goal` (codex), preamble (gemini); `providerNative` precedence + existing-command regression; each distilled command non-empty per provider + tooling-agnostic; palette payload includes them.
- [x] 7.3 `server/loop-constants.test.ts`: `GUARDRAILS` listed as built-in/read-only; custom `GUARDRAILS` create rejected (reserved); `{{const:GUARDRAILS}}` resolves.
- [x] 7.4 Client: `loop-template-filter.test.ts` (query/category/combined/empty); `LoopsPage.test.tsx` updated for the filter header, chips, card badge, and no-results state.

## 8. Verification

- [x] 8.1 `npm run typecheck` clean (server + client).
- [x] 8.2 `npm test` + `npm run test:coverage` (server ≥80% lines/functions/statements, 70% branches).
- [x] 8.3 `cd client && npm run test:coverage` (client ≥80% lines/statements, 70% functions).
- [x] 8.4 `openspec validate loop-template-library --strict` passes.
- [ ] 8.5 Manual: open `/loops`, search + chip-filter the catalog, clone a ported template, confirm `{{cmd:loop}}`/`{{cmd:test}}`/`{{const:GUARDRAILS}}` chips appear and resolve in a dry-run preview.
