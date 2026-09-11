## Context

Desktop already manages providers, worktrees, queues and delivery. It will use the Core runtime for explicitly configured implementation runs, and keep existing paths for legacy runs. Both macOS and Windows and Claude/Codex/Gemini/Kimi remain supported.

## Goals / Non-Goals

**Goals:** project UI/API for provider and role configuration, local endpoint support, shared engine integration, persisted phase status and controlled resume, compatibility with existing jobs and user changes.

**Non-Goals:** replacing all existing chats/loop graphs, adding a cloud service requirement, publishing releases or PRs automatically.

## Decisions

- Project config lives in artifactRoot/.specrails/agent-runtime.json and follows Core's schema. GET/PUT /agent-runtime/config validate before atomic persistence, never accept raw API keys. UI offers all four CLI providers and an editable OpenAI-compatible provider template.
- Load/use the packaged Core runtime through a bridge so the engine is not reimplemented in Desktop. A compatible runtime can come from bundled Core or the local development checkout via explicit configuration; installed package resolution is supported. Missing enabled runtime fails visibly.
- Intercept only complete implementation requests with runtime enabled, using the existing frozen Core context/worktree. Each phase invokes a bounded role, preserves Core receipt gates, and emits readable and structured events. Existing outer loop observes one runtime owner and does not independently schedule its phases.
- Preserve original run identifiers and expose stored status and explicit continuation. Paused/interrupted phases are durable; tool permissions and candidate validity are rechecked on resume. The run owns cancellation and child processes.
- Existing delivery remains with Desktop. Runtime settings do not grant publishing rights or bypass sandbox/tool policy.

## Risks / Trade-offs

- Runtime unavailable in older bundle -> discover capability and report upgrade path, never silently execute legacy when runtime was requested.
- Nested scheduling -> only role invocations beneath Core engine; disable resident whole-pipeline transport on migrated runs.
- Duplicated cost reporting -> root events include per-attempt identity; aggregate is explicitly one accounting surface, phase logs do not insert duplicate invocations.
- Cross-platform packaging -> verify packed Core module entry and dependencies, use existing Node/process helpers.

## Migration Plan

New config is opt-in and absent config preserves existing behavior. Ship controls, bridge and tests together. Reuse existing job/rail lifecycle and completion validation. Document local endpoint setup and recovery including limitations of previously interrupted legacy runs.
