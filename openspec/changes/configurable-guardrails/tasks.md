## 1. Core
- [x] 1.1 `guardrails.ts` catalog + `validateGuardrailSettings` + `guardrailEnabled` (+ tests)
- [x] 1.2 `RuntimeConfig.guardrails` in config/schema/types; `AgentRequest.guardrails` → `CompactEnv.guardrails`
- [x] 1.3 Every configurable guard gated (`on(env, id)`), host guards from config in the verify node, `verifyPipeline({ idleTimeoutMs })`
- [x] 1.4 `runtime-api` advertises `configurableGuardrails: 1` + catalog (+ behavioural test: frozen-plan-writes off)

## 2. Desktop
- [x] 2.1 Vendored schema synced; `RuntimeConfig.guardrails`; `forCoreRuntime` capability gate in bridge + settings router
- [x] 2.2 `GET /:projectId/agent-runtime/guardrails`
- [x] 2.3 Guardrails block in project settings ▸ Agent engine (+ tests, i18n ×8)
- [x] 2.4 Docs: `docs/local-providers.md` section + CLAUDE.md bullet
