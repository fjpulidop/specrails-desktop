## 1. Server
- [x] 1.1 `server/loop-role-engines.ts`: sentinel, roles, load/validate/save, `resolveLoopRoleEngine` (+ tests)
- [x] 1.2 `PUT /rails/:i/engine` accepts `roles`
- [x] 1.3 Launch: roles mode — no override, verifier → loop engine, decider → `deciderEngine`, freestyle 400, mismatch 400 (+ tests)
- [x] 1.4 `LoopRunRequest.deciderEngine` threaded through `rail-isolated-launch` and used by the Decider (+ test, step title names the engine)
- [x] 1.5 `GET/PUT /:projectId/agent-runtime/loop-roles`
- [x] 1.6 MCP `specrails_rails` description mentions `roles`

## 2. Client
- [x] 2.1 `ROLES_ENGINE`/`isRolesEngine` in `lib/provider-capabilities.ts`
- [x] 2.2 `RailEngineSelector` Roles option (+ test)
- [x] 2.3 `RailRow` roles chip, selectors hidden under roles
- [x] 2.4 `DashboardPage` engine change + launch body under roles
- [x] 2.5 Settings ▸ Specrails Agents ▸ Loop roles block (+ test)
- [x] 2.6 i18n ×8

## 3. Docs
- [x] 3.1 `docs/local-providers.md` hybrid section, CLAUDE.md bullet
