## Why

Custom agents today can be edited only by hand in `AgentStudio` or regenerated one-shot via `POST /catalog/generate` (90s timeout, no resume, replaces body wholesale). Tickets already have a premium iterative AI editing experience (`ai-edit-diff-review` capability) that streams, diffs, and refines across turns. Custom agents are a core asset of specrails-hub and deserve the same level of polish — iterative refinement, side-by-side diff before save, staged progress feedback, and full keyboard accessibility.

## What Changes

- Add an **AI Edit** action to each custom agent on the Agents Catalog, alongside the existing **Duplicate** and **Edit** buttons.
- Launch a full-screen overlay (not a small modal) with a chat pane on the left and a live word-level diff pane on the right of `custom-<id>.md`.
- Multi-turn refinement using `claude --resume <sessionId>` so each follow-up is fast and context-aware.
- Apply the proposed body via the existing `PATCH /api/projects/:projectId/profiles/catalog/:agentId`, reusing `agent_versions` bump and validation.
- Emit token-stream deltas plus staged status pills (Reading → Drafting → Validating → Optional Test) for premium progress feedback.
- Optional auto-test (default ON, smart mode: only run when AI signals "ready" and >5s since last test) using the existing `POST /catalog/test` path.
- Full keyboard accessibility (⌘⏎ apply, Esc discard, J/K diff hunks, focus trap, `aria-live` chat, reduce-motion respected).
- "Open in Studio" escape hatch hands the in-flight draft to `AgentStudio` for manual fine-tuning.

## Capabilities

### New Capabilities
- `ai-refine-custom-agents`: Iterative, session-resumed AI refinement of an existing custom agent (`.claude/agents/custom-*.md`) with side-by-side diff review, optional auto-test, and apply path that reuses the existing catalog write + version bump.

### Modified Capabilities
- `agent-studio`: Adds **AI Edit** entry point from the catalog card and a "received from refine session" handoff mode so a draft produced in the refine overlay can be opened in the Studio for manual editing.

## Impact

- **Server**: new `server/modules/agents/runtime/agent-refine-manager.ts` (mirrors `proposal-manager.ts` pattern: spawn `claude` with `--resume`, stream stream-json over WS, persist session). New REST surface under `/api/projects/:projectId/profiles/catalog/:agentId/refine` (start, refine, cancel, apply-preview). New table `agent_refine_sessions(id, agent_id, session_id, base_version, draft_body, status, created_at, updated_at)` in per-project `jobs.sqlite`. New WS messages: `agent_refine_stream`, `agent_refine_phase`, `agent_refine_ready`, `agent_refine_error`, `agent_refine_cancelled`. Cron-like cleanup for refine sessions older than 24h with status=draft.
- **Client**: new `AiRefineOverlay` component (full-screen overlay launched from `AgentsCatalogTab`). New `useAgentRefine` hook (mirrors `useProposal`). Diff renderer (word-level, color-blind safe with +/− glyphs). Reuses `AgentStudio` when "Open in Studio" is clicked (new `?draftFromRefine=<sessionId>` query param).
- **Cross-cutting**: no changes to `specrails-core`. Inline system prompt lives in hub (`agent-refine-manager.ts`), no new slash command. Frontmatter `name` field server-locked on apply (rename remains a separate explicit action).
- **Risk**: concurrent disk edit while overlay open → mtime check on apply, "rebase?" prompt. Diff virtualization above ~500 lines. Auto-test latency mitigated by Smart mode debounce.
