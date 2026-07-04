import type { AgentChatManager } from './agent-chat-manager'

// ─── Agent-chat manager registry (safe-pr-review-flow) ────────────────────────
//
// The AgentChatManager instance is a non-exported local of index.ts's startup,
// but the rails layer (rail-isolated-launch / the pr-decision endpoint) must
// reach it to post/update the inline PR-decision card into the launching
// conversation. This process-wide singleton is the reference path — mirroring
// the `setActiveProject` pattern in mcp/tools/types.ts — so rails code never
// imports index.ts (circular). It stays null in tests and when agent chat is
// disabled; callers use `getAgentChatManager()?.…` (null-safe).

let _manager: AgentChatManager | null = null

export function setAgentChatManager(m: AgentChatManager | null): void {
  _manager = m
}

export function getAgentChatManager(): AgentChatManager | null {
  return _manager
}
