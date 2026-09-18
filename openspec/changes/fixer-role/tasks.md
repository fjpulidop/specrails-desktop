## 1. Core
- [x] 1.1 Fixer stance for correction rounds (feedback + excerpts first, relevant tasks only, no plan dump) — `Compact fixer:` log
- [x] 1.2 `RuntimeConfig.fixer` (config validation reuse, schema), `AgentRequest.stance`
- [x] 1.3 Role invoker `agentOverride`/`stance`; developer node routes verify-failed / review-rejected rounds to the fixer (+ workflow test)

## 2. Desktop
- [x] 2.1 Server: type, validator, launch override, default-model fill, `[runtime] fixer:` banner; schema synced
- [x] 2.2 Client: Fixer phase in the stepper + card (Inherit developer / Own engine), i18n ×8, tests
- [x] 2.3 Docs: `docs/local-providers.md` roles table + CLAUDE.md
