## Why

Users need implementation to cost less and complete correctly with fewer interventions. Desktop already exposes roles and usage, but does not explain effective model selection, check reuse or escalation; some configuration paths can overwrite per-role assignments or discard verification metadata.

## What Changes

- Negotiate Core efficiency capabilities and preserve explicit project role choices and full verification metadata from settings through admission.
- Expose optional role escalation/effort and conservative verification execution policy without adding an AI verifier or QA role.
- Use one evidence and execution-summary presentation in mission and board logs, with provenance, limitations and reasons for reruns/escalation.
- Preserve terminal metrics after original worktree cleanup and distinguish successful execution from independently accepted output and host delivery.
- Pin the executing runtime for saved jobs and validate paired package/bundle compatibility before enabling new behavior.

## Capabilities

### New Capabilities
- `implementation-efficiency-controls`: Capability-gated configuration, stable effective settings and saved-runtime compatibility.
- `implementation-evidence-visibility`: Shared logs, durable evidence summaries and honest cost/outcome history.

### Modified Capabilities

None. Existing job controls, delivery ownership and metrics semantics remain authoritative.

## Impact

Core loader/bridge/settings/config schema, continuation controls and accounting, client settings/types/locales, shared mission/board log components and integration/package tests. Depend on the paired Core `implementation-efficiency` change. Reuse existing durable job events instead of creating a second run database.

Planning only in this change preparation. Implementation is requested for GPT-6 Astra with reasoning effort medium; this does not select that model for customers' runtime roles.
