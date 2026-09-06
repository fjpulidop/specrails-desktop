import { z } from 'zod'
import type { McpToolSpec } from './types'

export function missionTools(): McpToolSpec[] {
  return [{
    name: 'specrails_mission',
    title: 'Mission user updates',
    description: 'First-party mission only: acknowledge authenticated user updates received during the current running turn. For MCP mission_user_updates, read every block, replan, and acknowledge_updates with the exact latest revision in a separate call before invoking other tools. For the initial Mission input ID or native user messages carrying queueId, acknowledge_inputs with those inputIds only after reading them; this records a read receipt and does not release the MCP revision gate. Does not execute, retry or undo any action and cannot change permissions, provider or project pin.',
    tier: 'read',
    inputSchema: {
      action: z.enum(['acknowledge_updates', 'acknowledge_inputs']),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Required for acknowledge_updates: exact latest revision delivered in mission_user_updates. Never guess; an older acknowledgement cannot release newer messages.'),
      inputIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional().describe('Required for acknowledge_inputs: exact initial Mission input ID or queueId values from native user messages you have read in this invocation.'),
    },
    handler: (ctx, args) => {
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
