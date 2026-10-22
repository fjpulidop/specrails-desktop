## 1. Evidence

- [x] 1.1 Trace what `capabilities.freestyle` gates (rails-router launch, loop command admission, built-in loop listing, QueueManager freestyle prompt) and why Codex/Gemini were off (#563)
- [x] 1.2 Add the opt-in live test `loop-factory-freestyle.live.test.ts` (production `runDefinition`, real bridge, built Core, real CLIs)
- [x] 1.3 Run it on Codex and Gemini with cheap models and record status, steps, decider outcome and usage
- [x] 1.4 Smoke the loops-disabled one-shot path (`rail-job` args + `_buildFreestylePrompt` prose) on both CLIs

## 2. Fix and enable

- [x] 2.1 Pass `GEMINI_CLI_TRUST_WORKSPACE=true` to Core spawns (`coreProviderEnv`), explicit value wins; unit test
- [x] 2.2 Flip `freestyle: true` on the Codex and Gemini adapters; interactive stays gated on `persistentStdin`
- [x] 2.3 Client `providerSupportsFreestyle` covers every bundled CLI plus local engines; tests
- [x] 2.4 Rails-router and catalog tests: Codex/Gemini launch non-interactive Freestyle; a provider without the capability is still rejected

## 3. Docs and verification

- [x] 3.1 Update rails and engine guides (8 locales), provider matrix, running pipelines, customizing, configuration, runtime internals, loops README
- [x] 3.2 `npm run typecheck`, targeted server and client suites, live test on both providers
