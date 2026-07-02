import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

/**
 * Chat / Explore conversations for a project. A domain-facade tool over the
 * per-project chat routes in `server/project-router-chat.ts`. The agent-refine
 * (AI-edit) routes under `/profiles/catalog/:agentId/refine` are intentionally
 * NOT here — they belong to the agents domain.
 *
 * `send` is the only cost-incurring action: it 202-accepts and streams the
 * assistant reply over WebSocket, so it returns a watch hint keyed on the
 * conversation id.
 */
export function chatTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_chat',
      title: 'Chat / Explore',
      description:
        'Manage a project\'s chat & Explore-Spec conversations and drive their AI turns. ' +
        'EXPLORE RECIPE: create(kind:\'explore\', contextScope) → send the bootstrap text "/specrails:explore-spec\\n\\n<idea>" ' +
        'with {lightweight:true, maxTurns:20} → watch chat_done per turn → spec_draft to read the accumulated draft → ' +
        'persist via specrails_specs(commit_draft, conversationId=<this conversation>) which preserves origin linkage, ' +
        'Contract Refine and "Continue Explore". NOTE: spec_draft state is in-memory; it returns {draft:null} after a server restart. ' +
        'Actions: list_conversations, get (conversation + messages), create (kind sidebar|explore, optional provider/model/contextScope), ' +
        'update (rename title / change model), ' +
        'send (cost-incurring — spawns the AI CLI and streams the reply async over WS), abort (interrupt the in-flight turn), ' +
        'delete (destructive — removes the conversation, its messages, and clears linked draft origin), minimize (arm Explore idle-kill timer), ' +
        'restore (cancel the idle-kill timer), spec_draft (read the in-memory Explore spec-draft state), messages (persisted history only).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (action === 'delete') return 'destructive'
        if (action === 'send') return 'ai-spawn'
        if (action === 'create' || action === 'update' || action === 'abort' || action === 'minimize' || action === 'restore') return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            'list_conversations',
            'get',
            'create',
            'update',
            'send',
            'abort',
            'delete',
            'minimize',
            'restore',
            'spec_draft',
            'messages',
          ])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        conversationId: z.string().optional().describe('Conversation id (required for get/update/send/abort/delete/minimize/restore/spec_draft/messages)'),
        // create params
        kind: z.enum(['sidebar', 'explore']).optional().describe('Conversation kind for create (default sidebar)'),
        provider: z.string().optional().describe('AI engine for create — must be installed on the project (alias of aiEngine); defaults to the primary provider'),
        model: z.string().optional().describe('Model for create/update — must be valid for the conversation\'s provider'),
        contextScope: z
          .record(z.unknown())
          .optional()
          .describe(
            'Explore-only context scope flags for create: {full: repo-wide investigation, specrails: specs context, ' +
            'openspec: openspec context, mcp: load project .mcp.json (spawns from repo cwd, slower), ' +
            "userMcp: user's approved MCP servers, contractRefine: append Contract Layer on commit}",
          ),
        // update params
        title: z.string().optional().describe('New title for update'),
        // send params
        text: z.string().optional().describe('User message text for send (required)'),
        lightweight: z.boolean().optional().describe('Use the lightweight system prompt for send'),
        maxTurns: z.number().optional().describe('Max agent turns for send'),
        attachments: z
          .object({
            ticketKey: z.string().describe('Ticket key the attachments belong to'),
            ids: z.array(z.string()).describe('Uploaded attachment ids'),
          })
          .optional()
          .describe('Attachment references for send'),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string
        const convId = args.conversationId as string | undefined
        const requireConv = (): string => {
          if (!convId) throw new Error(`Action "${action}" requires a "conversationId".`)
          return convId
        }
        switch (action) {
          case 'list_conversations':
            return apiCall(ctx, 'GET', `${base}/chat/conversations`)
          case 'get':
            return apiCall(ctx, 'GET', `${base}/chat/conversations/${requireConv()}`)
          case 'messages':
            return apiCall(ctx, 'GET', `${base}/chat/conversations/${requireConv()}/messages`)
          case 'spec_draft':
            return apiCall(ctx, 'GET', `${base}/chat/conversations/${requireConv()}/spec-draft`)
          case 'create': {
            const body: Record<string, unknown> = {}
            if (args.kind !== undefined) body.kind = args.kind as string
            if (args.provider !== undefined) body.aiEngine = args.provider as string
            if (args.model !== undefined) body.model = args.model as string
            if (args.contextScope !== undefined) body.contextScope = args.contextScope
            return apiCall(ctx, 'POST', `${base}/chat/conversations`, body)
          }
          case 'update': {
            const body: Record<string, unknown> = {}
            if (args.title !== undefined) body.title = args.title as string
            if (args.model !== undefined) body.model = args.model as string
            return apiCall(ctx, 'PATCH', `${base}/chat/conversations/${requireConv()}`, body)
          }
          case 'send': {
            const text = args.text as string | undefined
            if (!text || !text.trim()) throw new Error('send requires non-empty "text".')
            const body: Record<string, unknown> = { text: text.trim() }
            if (args.lightweight !== undefined) body.lightweight = args.lightweight as boolean
            if (args.maxTurns !== undefined) body.maxTurns = args.maxTurns as number
            if (args.attachments !== undefined) body.attachments = args.attachments
            const r = (await apiCall(ctx, 'POST', `${base}/chat/conversations/${requireConv()}/messages`, body)) as Record<string, unknown>
            return {
              ...r,
              conversationId: requireConv(),
              hint: `Turn accepted (202). The assistant reply streams over WebSocket — use specrails_watch with conversationId "${requireConv()}" to await completion (chat_done / chat_error). Each send spawns a fresh AI CLI turn (cost); Explore turns accumulate the spec_draft.`,
            }
          }
          case 'abort':
            return apiCall(ctx, 'DELETE', `${base}/chat/conversations/${requireConv()}/messages/stream`)
          case 'delete':
            return apiCall(ctx, 'DELETE', `${base}/chat/conversations/${requireConv()}`)
          case 'minimize':
            return apiCall(ctx, 'POST', `${base}/chat/conversations/${requireConv()}/minimize`)
          case 'restore':
            return apiCall(ctx, 'POST', `${base}/chat/conversations/${requireConv()}/restore`)
          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
