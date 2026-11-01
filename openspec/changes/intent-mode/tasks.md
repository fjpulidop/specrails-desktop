## 0. OpenSpec bookkeeping

- [x] 0.1 Archive `flow-mode` (task 6.3 smoke carried by 8.4 here) and rename canonical `openspec/specs/flow-mode` → `intent-sessions`, rewording Flow → Intent sessions

## 1. Mechanical rename (no behaviour change)

- [ ] 1.1 `git mv server/modules/flow server/modules/intent`, `client/src/features/flow client/src/features/intent`; update imports, boundary manifests, architecture tests, AGENTS feature map, source map
- [ ] 1.2 Rename exported types/functions/components/CSS token/i18n keys Flow → Intent; keep frozen identifiers (D6) and list them in the module README
- [ ] 1.3 HTTP `/intent/*` alias of `/flow/*`; MCP intent-named operations with Flow aliases; guide lists intent names
- [ ] 1.4 Visible copy Flow → Intent in the eight locales (board label "In Intent", header, chip, palette, notifications)
- [ ] 1.5 Gates: typecheck, server modules + affected suites, client suites

## 2. Intent domain and storage

- [ ] 2.1 Pure `intent` domain (server, shared shape mirrored in client): validate/normalise/bounds, Markdown render and tolerant parse with round-trip tests
- [ ] 2.2 Ticket `intent` field (store schema bump, additive), API create/update validation, MCP `specrails_specs` intent support, Jira description includes rendered intent
- [ ] 2.3 Spec detail Intent section (view/edit, open questions with answers), "Add intent", card open-questions mark; i18n eight locales

## 3. Default door: mission interview

- [ ] 3.1 `intent-draft` fence parser + IntentDraftCard (readings one-click, Explore/Delegate equal weight, legacy problem-frame still renders)
- [ ] 3.2 Operator prompt: analyst interview, intent before spec, dictated solution → constraint/open question (static constant)
- [ ] 3.3 `commit_draft` gate accepts answered intent-draft or legacy frame; attaches newest answered intent to the spec; one intent → one spec

## 4. Default door: Add Spec Intent mode

- [ ] 4.1 `ProposeSpecModal` Intent mode as default, placeholder and labels; i18n
- [ ] 4.2 `generate-spec` `intent: true`: one generation returning intent + spec, parse, fallback without intent; premium contract rule "specs from an intent derive from it"

## 5. Paths

- [ ] 5.1 Explore: Intent session start from an intent (placeholder spec with intent, title from problem); seed briefing leads with intent
- [ ] 5.2 Flow → Spec summary leads with the intent within the byte limit
- [ ] 5.3 Settlement rewrite keeps the intent and merges `intent-answers` deterministically
- [ ] 5.4 Delegate: Implement briefing carries intent + reviewer outcome/success-signal instruction

## 6. intent.md in the delivered change

- [ ] 6.1 Materialise `intent.md` into the run's active or archived change before the delivery commit; path guards treat it as own change; warning on failure; skip without OpenSpec/change

## 7. Documentation

- [ ] 7.1 User guide `8-flow-mode.md` → `8-intent-mode.md` in eight locales (intent concept, interview, Explore/Delegate, intent.md) + index links
- [ ] 7.2 `docs/internals/flow-mode.md` → `intent-mode.md`; module READMEs; API reference; configuration; AGENTS map; source map

## 8. Verification and delivery

- [ ] 8.1 Root and client `test:coverage`, typecheck, build, check:package, audit:architecture, audit:source
- [ ] 8.2 Review pass of the diff (correctness + rename completeness: no visible "Flow")
- [ ] 8.3 Commits on `feat/intent-mode`, push, PR
- [ ] 8.4 Real smoke in the running app (Explore and Delegate from an intent) — by the user
