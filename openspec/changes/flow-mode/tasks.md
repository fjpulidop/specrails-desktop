## 1. Contracts

- [x] 1.1 Agent sessions ACL: `interrupt` delivery, driver `capabilities.interrupt`, `flowSessions` in initialize and the session contract (tolerant `checkSessionContract`)
- [x] 1.2 Flow availability (`flowSessions` + `deriveChange`) in the agent-sessions domain and runtime probe

## 2. Flow module (server)

- [x] 2.1 `domain.ts`: state machine, saga steps, effects, invariants, reconciliation
- [x] 2.2 `ports.ts` and `application.ts`: start/pause/resume/discard/hand-off sagas with compensation, `onFlowDelivered`, reconcile, diff and cost read models
- [x] 2.3 Migration 72 `flow_sessions` and `adapters/sqlite.ts`
- [x] 2.4 `adapters/http.ts`: project-scoped routes and error mapping
- [x] 2.5 `adapters/bindings.ts`: placeholder spec, worktree reservation/freeze/release/diff, agent session, rail launch, usage, notifier, hand-off authority, missions turn context
- [x] 2.6 Composition: project registry (per project, reconciliation before admission), project router, missions port in `index.ts`; `flow.state` WebSocket event

## 3. Integrations (server)

- [x] 3.1 Ticket store: `source: 'flow'`, `metadata.flow`, schema 1.5; Jira create blocked while the Flow is active or paused
- [x] 3.2 Delivery: `requiredFlowWorktree`, `FlowWorktreeMismatchError`, `adopted` ownership, atomic transfer and rollback; rails launch `flowId`
- [x] 3.3 Missions: `FlowTurnContext`, Flow persona, Flow Core session policy, interrupt delivery in the runner and the send route, no legacy path
- [x] 3.4 Accounting: surface `flow` in the vocabulary and the agent-mission spending split

## 4. Tests and docs (server)

- [x] 4.1 Domain, application (fakes, compensation, idempotency), SQLite, HTTP and binding tests
- [x] 4.2 Hand-off launch tests (mismatch 409, transaction rollback, adopted release) and rails route tests
- [x] 4.3 Missions tests (null port unchanged, workspace-write + worktree cwd + interrupt, capability gating)
- [x] 4.4 Docs: `docs/internals/flow-mode.md`, module READMEs, API reference, AGENTS feature map, boundary manifest, source map

## 5. Client

- [x] 5.1 `client/src/features/flow`: FlowEntryCard, FlowBar, FlowHandOffCard, FlowOfferCard, FlowContext and `flow-api.ts`; missions extension seam (`MissionExtensionsContext`)
- [x] 5.2 Mission panel integration (`data-flow`), composer interrupt delivery, board "In Flow" label, `flow-offer` operator option + fence promotion + intents
- [x] 5.3 i18n in the eight locales, accessibility, client tests, user guide (eight locales)

## 6. Flow -> Spec loop and settlement

- [x] 6.1 `factory:flow-spec` loop with `derive-change`, conversation summary file
- [x] 6.2 Settlement effects (spec rewrite, Jira create and review), packet "Derivation"
- [ ] 6.3 Real smoke with Claude and Codex end to end
