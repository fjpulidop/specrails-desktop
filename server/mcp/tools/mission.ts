import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { getAgentChatManager } from '../../modules/missions/runtime/agent-chat-registry'

export function missionTools(): McpToolSpec[] {
  return [{
    name: 'specrails_mission',
    title: 'Mission user updates',
    description: 'First-party mission only: acknowledge authenticated user updates received during the current running turn. For MCP mission_user_updates, read every block, replan, and acknowledge_updates with the exact latest revision in a separate call before invoking other tools. For the initial Mission input ID or native user messages carrying queueId, acknowledge_inputs with those inputIds only after reading them; this records a read receipt and does not release the MCP revision gate. Does not execute, retry or undo any action and cannot change permissions, provider or project pin. ' +
      'When the mission says Specrails launches its sub-agents: subagent_start (description, instructions, optional contextTurns) delegates a task to a sub-agent on the configured provider; subagent_wait returns finished results (results you never wait for arrive later as a message); subagent_list shows them; subagent_stop stops them. These actions are refused in missions whose agent launches its own sub-agents.',
    // Delegation is gated by the project's "Allow sub-agents" / "Run sub-agents with" settings, like native sub-agents.
    tier: 'read',
    inputSchema: {
      action: z.enum(['acknowledge_updates', 'acknowledge_inputs', 'subagent_start', 'subagent_wait', 'subagent_list', 'subagent_stop']),
      description: z.string().min(1).max(200).optional().describe('subagent_start: a short name for the task, shown to the user'),
      instructions: z.string().min(1).max(64 * 1024).optional().describe('subagent_start: the complete, self-contained task for the sub-agent'),
      agentType: z.string().min(1).max(100).optional().describe('subagent_start: optional label for the kind of work (e.g. "review")'),
      contextTurns: z.number().int().min(0).max(10).optional().describe('subagent_start: how many recent turns of this conversation to hand over'),
      subagentIds: z.array(z.string().min(1).max(200)).max(50).optional().describe('subagent_wait / subagent_stop: limit to these sub-agents (default: all of this mission)'),
      timeoutSeconds: z.number().int().min(0).max(300).optional().describe('subagent_wait: how long to wait (default 60, max 300); call again to keep waiting'),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Required for acknowledge_updates: exact latest revision delivered in mission_user_updates. Never guess; an older acknowledgement cannot release newer messages.'),
      inputIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional().describe('Required for acknowledge_inputs: exact initial Mission input ID or queueId values from native user messages you have read in this invocation.'),
    },
    handler: (ctx, args) => {
      // Delegation actions are async; the acknowledge actions stay synchronous (callers rely on sync throws).
      if (typeof args.action === 'string' && args.action.startsWith('subagent_')) return delegationAction(ctx, args)
      if (args.action === 'acknowledge_inputs') {
        if (!ctx.firstPartyAgent || !ctx.acknowledgeAgentInputsRead) throw new Error('This action requires an active first-party mission turn.')
        return ctx.acknowledgeAgentInputsRead(args.inputIds as string[])
      }
      if (args.action !== 'acknowledge_updates') throw new Error(`Unknown action: ${String(args.action)}`)
      if (!ctx.firstPartyAgent || !ctx.acknowledgeAgentUpdates) throw new Error('This action requires an active first-party mission turn.')
      return ctx.acknowledgeAgentUpdates(args.revision as number)
    },
  }]
}

async function delegationAction(ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (!ctx.firstPartyAgent || !ctx.originConversationId) throw new Error('This action requires an active first-party mission turn.')
  const manager = getAgentChatManager()
  if (!manager) throw new Error('Missions are not available.')
  const conversationId = ctx.originConversationId
  const ids = Array.isArray(args.subagentIds) ? args.subagentIds as string[] : undefined
  switch (args.action) {
    case 'subagent_start': {
      if (typeof args.description !== 'string' || typeof args.instructions !== 'string') throw new Error('subagent_start needs a description and instructions.')
      return manager.delegateSubagent(conversationId, {
        description: args.description, prompt: args.instructions,
        ...(typeof args.agentType === 'string' ? { agentType: args.agentType } : {}),
        ...(typeof args.contextTurns === 'number' ? { contextTurns: args.contextTurns } : {}),
      })
    }
    case 'subagent_wait':
      return manager.waitSubagents(conversationId, ids, (typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 60) * 1000)
    case 'subagent_stop':
      return { stopped: await manager.stopSubagents(conversationId, ids) }
    case 'subagent_list':
      return {
        subagents: (manager.sessionState(conversationId)?.subagents ?? [])
          .filter((node) => node.delegated)
          .map((node) => ({ subagentId: node.subagentId, description: node.description, phase: node.phase, provider: node.delegated!.driver, model: node.delegated!.model, result: node.resultSummary })),
      }
  }
  throw new Error(`Unknown action: ${String(args.action)}`)
}
