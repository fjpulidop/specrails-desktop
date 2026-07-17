## 1. Factory Loop Surface

- [x] 1.1 Add a `factory:sdd-quick-openspec` factory loop entry named `SDD Quick (OpenSpec)` in `server/loop-factory.ts`, mapped to rail `loop` mode and backed by the OpenSpec lifecycle graph.
- [x] 1.2 Preserve compatibility for existing `factory:openspec` references, either as a visible legacy entry or a hidden alias that still resolves through `getFactoryLoop` / `factoryLoopMode`.
- [x] 1.3 Update factory loop tests to cover the new id, display name, mode mapping, and compatibility behavior.
- [x] 1.4 Update any loop gallery or factory-loop ordering tests that assert exact factory loop lists.

## 2. OpenSpec Change Targeting

- [x] 2.1 Extend the loop spec context to expose a whitelisted `openspecChangeName` field sourced from local ticket metadata.
- [x] 2.2 Update `interpolateSpec` tests so `{{spec.openspecChangeName}}` resolves when present and unknown metadata remains hidden.
- [x] 2.3 Update the SDD Quick OpenSpec lifecycle prompt so an existing `openspecChangeName` causes `opsx:ff` to continue that change instead of creating a duplicate.
- [x] 2.4 Add tests for SDD Quick prompts with and without `openspecChangeName`.

## 3. Lifecycle Guardrails

- [x] 3.1 Update the OpenSpec lifecycle prompt text to state that OpenSpec artifacts are authoritative and contract-changing implementation must amend artifacts before code changes.
- [x] 3.2 Ensure the verify step prompt reports FAIL when implementation diverges from OpenSpec artifacts.
- [x] 3.3 Keep archive execution gated on captured `run.changeId`; add or update tests that missing change id cannot archive an unknown change.

## 4. Operator Policy

- [x] 4.1 Update `server/agent-operator-prompt.ts` so small work is classified as Freestyle, SDD Quick (OpenSpec), Implement, or Batch before launch.
- [x] 4.2 Add prompt rules that Freestyle is only valid for ticket-local implementation-only changes when OpenSpec artifacts are relevant.
- [x] 4.3 Add prompt rules that SDD Quick (OpenSpec) requires a local ticket and, when known, stores the target OpenSpec change name in ticket metadata before launch.
- [x] 4.4 Update operator prompt tests to assert the new strategy name, Freestyle guardrail, ticket metadata requirement, and ai-spawn confirmation framing.
- [x] 4.5 Add a prompt guardrail and tests so the operator never offers direct code editing for tiny changes; it must update or create a local ticket and route through the lightest valid rail.
- [x] 4.6 Add a PR-aware relaunch guardrail so active PR branch/diff OpenSpec artifacts are inspected before choosing Implement vs SDD Quick.

## 5. MCP and Rail Launch Flow

- [x] 5.1 Verify `specrails_rails(launch, mode:'loop', loopId:'factory:sdd-quick-openspec')` works through the existing rails facade and origin-conversation PR card path.
- [x] 5.2 Update MCP tool descriptions or guide text to mention `SDD Quick (OpenSpec)` as the product-facing strategy for OpenSpec-governed small changes.
- [x] 5.3 Add server tests covering an MCP rail launch of the new factory id and the expected loop run creation.

## 6. Verification

- [x] 6.1 Run targeted unit tests for loop factory, loop interpolation, loop lifecycle, rails launch, and operator prompt behavior.
- [x] 6.2 Run the relevant typecheck/build command for the touched server/client scope.
- [x] 6.3 Manually inspect the new OpenSpec artifacts and confirm `openspec status --change add-sdd-quick-openspec` reports the change apply-ready.
- [x] 6.4 Prevent provider `agent-memory` and `agent-memory/explanations` artifacts from being staged into isolated rail PR branches.
