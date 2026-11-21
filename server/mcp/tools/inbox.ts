import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, projectPath } from './types'
import { McpToolError, toolResponse, type NextCall } from './envelope'
import { companionTargetsFor } from '../../mobile/mobile-inbox'
import type { InboxItem } from '../../modules/inbox'

/**
 * `specrails_inbox`: the "Needs you" inbox for MCP clients — the same
 * read-model as the desktop inbox (GET /api/inbox) and the same closed set of
 * safe actions the paired phone offers (server/mobile/mobile-inbox.ts), each
 * forwarded over loopback to the very route the desktop UI uses. Merge,
 * discard, publish and settings stay on Desktop.
 */

const RUN_ID = /^[A-Za-z0-9-]{1,128}$/
const SOURCE_ID = /^(?:run:)?[A-Za-z0-9-]{1,128}$/
const MAX_ANSWER = 20_000
const MAX_RUN_CAP_USD = 10_000
const MAX_DETAIL_CHARS = 2_000

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

/** Bound a detail payload for a model: long strings and arrays are clipped, nesting is capped. */
export function bound(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}… [truncated]` : value
  if (Array.isArray(value)) {
    const items = value.slice(0, 30).map((item) => bound(item, depth + 1))
    return value.length > 30 ? [...items, `[${value.length - 30} more omitted]`] : items
  }
  if (value && typeof value === 'object') {
    if (depth >= 5) return '[nested detail omitted]'
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bound(item, depth + 1)]))
  }
  return value
}

/** The safe actions an item offers right now, as exact follow-up calls. */
export function inboxNextCalls(item: InboxItem): NextCall[] {
  const { ids, target } = companionTargetsFor(item)
  const next: NextCall[] = []
  for (const id of ids) {
    if (id === 'answer' && target.runId) {
      next.push({ tool: 'specrails_inbox', args: { action: 'question', projectId: item.projectId, runId: target.runId }, why: 'Read the agent’s pending question.' })
      next.push({ tool: 'specrails_inbox', args: { action: 'answer', projectId: item.projectId, runId: target.runId, answer: '<the person’s answer>' }, why: 'Answer it so the run continues (write).' })
    }
    if (id === 'resume' && target.runId) next.push({ tool: 'specrails_inbox', args: { action: 'resume', projectId: item.projectId, runId: target.runId }, why: 'Continue the paused run (ai-spawn, costs tokens).' })
    if (id === 'retry' && target.sourceId && typeof target.railIndex === 'number') next.push({ tool: 'specrails_inbox', args: { action: 'retry', projectId: item.projectId, sourceId: target.sourceId, railIndex: target.railIndex }, why: 'Relaunch the same rail on the same source (ai-spawn).' })
  }
  next.push({ tool: 'specrails_inbox', args: { action: 'open', itemId: item.id }, why: 'Full detail of what this item points at.' })
  return next
}

function present(item: InboxItem): Row {
  const { ids } = companionTargetsFor(item)
  return {
    id: item.id, projectId: item.projectId, projectName: item.projectName, kind: item.kind, title: item.title,
    detail: item.detail, at: item.at, version: item.version, action: item.action, subjectId: item.subjectId,
    conversationId: item.conversationId,
    ...(item.diagnosis ? { diagnosis: { kind: item.diagnosis.kind, confidence: item.diagnosis.confidence, detail: item.diagnosis.detail, remedies: item.diagnosis.remedies } } : {}),
    ...(item.cap ? { cap: item.cap } : {}),
    ...(typeof item.railIndex === 'number' ? { railIndex: item.railIndex } : {}),
    ...(item.decision ? { decision: item.decision } : {}),
    actions: [...ids.filter((id) => id !== 'create-pr'), 'open'],
    next: inboxNextCalls(item),
  }
}

async function readInbox(ctx: McpToolContext): Promise<InboxItem[]> {
  const snapshot = record(await apiCall(ctx, 'GET', '/inbox'))
  return (Array.isArray(snapshot.items) ? snapshot.items : []) as InboxItem[]
}

function countKinds(items: readonly InboxItem[]): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')
}

async function pendingQuestion(ctx: McpToolContext, base: string, runId: string): Promise<{ run: Row; question: Row }> {
  const status = record(await apiCall(ctx, 'GET', `${base}/agent-runtime/runs/${encodeURIComponent(runId)}`))
  const run = record((Array.isArray(status.runs) ? status.runs : [])[0])
  return { run, question: record(run.pendingQuestion) }
}

function requireRunId(args: Row, action: string): string {
  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (!RUN_ID.test(runId)) throw new McpToolError('invalid_input', `${action} requires "runId" (the item's subjectId).`)
  return runId
}

export function inboxTools(): McpToolSpec[] {
  return [{
    name: 'specrails_inbox',
    title: 'Needs you inbox',
    description:
      'What needs the person across all projects (agent questions, deliveries to review, failed/blocked runs, reached spend caps, Jira write-backs) and the safe actions on them. ' +
      'Actions: list (read; filter by projectId/kind; each item names its actions and exact next calls), open (read; full detail of what itemId points at), question (read; the pending question of runId), ' +
      'answer (write; answer a paused run\'s question), resume (ai-spawn; continue a paused/interrupted run, optional runCap:"ignore" or runCapUsd), retry (ai-spawn; relaunch the same rail on the same source). ' +
      'PR decisions, merge and discard stay in the app.',
    hintTier: 'read',
    tier: (args) => args.action === 'answer' ? 'write' : args.action === 'resume' || args.action === 'retry' ? 'ai-spawn' : 'read',
    inputSchema: {
      action: z.enum(['list', 'open', 'question', 'answer', 'resume', 'retry']).describe('Operation to perform'),
      projectId: z.string().optional().describe('list: only this project. question/answer/resume/retry: the item\'s projectId (defaults to the active project)'),
      kind: z.enum(['review', 'question', 'failed', 'blocked', 'budget', 'jira']).optional().describe('list: only this kind'),
      limit: z.number().int().min(1).max(100).optional().describe('list: maximum items (default 20)'),
      itemId: z.string().min(1).max(400).optional().describe('open: the item id from list'),
      runId: z.string().min(1).max(128).optional().describe('question/answer/resume: the run id (the item\'s subjectId)'),
      answer: z.string().min(1).max(MAX_ANSWER).optional().describe('answer: the person\'s answer, verbatim'),
      runCap: z.enum(['ignore']).optional().describe('resume: continue past the per-run cap this time'),
      runCapUsd: z.number().positive().max(MAX_RUN_CAP_USD).optional().describe('resume: raise the per-run cap to this amount (USD)'),
      sourceId: z.string().min(1).max(140).optional().describe('retry: the delivery id, or run:<id>, from the item\'s next call'),
      railIndex: z.number().int().min(0).max(1000).optional().describe('retry: the rail to relaunch'),
    },
    async handler(ctx, args) {
      const action = args.action as string
      switch (action) {
        case 'list': {
          const all = await readInbox(ctx)
          const filtered = all.filter((item) => (!args.projectId || item.projectId === args.projectId) && (!args.kind || item.kind === args.kind))
          const limit = typeof args.limit === 'number' ? args.limit : 20
          const items = filtered.slice(0, limit)
          const first = items[0]
          return toolResponse({ items: items.map(present), total: filtered.length, totalAllProjects: all.length }, {
            summary: filtered.length
              ? `${filtered.length} thing${filtered.length === 1 ? '' : 's'} need${filtered.length === 1 ? 's' : ''} the person: ${countKinds(filtered)}.${first ? ` Newest: “${first.title}” in ${first.projectName}.` : ''}`
              : 'Nothing needs the person right now.',
            truncated: filtered.length > items.length,
            next: first ? inboxNextCalls(first).slice(0, 3) : [{ tool: 'specrails_status', args: {}, why: 'See what is running instead.' }],
          })
        }
        case 'open': {
          const itemId = typeof args.itemId === 'string' ? args.itemId : ''
          if (!itemId) throw new McpToolError('invalid_input', 'open requires "itemId" from list.')
          const all = await readInbox(ctx)
          const item = all.find((candidate) => candidate.id === itemId)
          if (!item) {
            throw new McpToolError('not_found', `Inbox item "${itemId}" is no longer waiting (it may have been handled).`, {
              choices: all.slice(0, 20).map((candidate) => ({ itemId: candidate.id, title: candidate.title })),
              next: [{ tool: 'specrails_inbox', args: { action: 'list' }, why: 'Current items.' }],
            })
          }
          const base = `/projects/${encodeURIComponent(item.projectId)}`
          let detail: unknown = null
          let source: string | null = null
          if (item.action === 'open-review') {
            source = 'review packet'
            detail = await apiCall(ctx, 'GET', `${base}/rails/pr-deliveries/${encodeURIComponent(item.subjectId)}/packet`)
          } else if (item.kind === 'question') {
            source = 'pending question'
            const { question } = await pendingQuestion(ctx, base, item.subjectId)
            detail = typeof question.question === 'string' ? { question: question.question, requestedAt: question.requestedAt ?? null } : { pending: false }
          } else if (item.action === 'open-run' || item.action === 'resume-run') {
            source = 'loop run'
            detail = record(await apiCall(ctx, 'GET', `${base}/loop-runs/${encodeURIComponent(item.subjectId)}`)).loopRun ?? null
          } else if (item.action === 'raise-cap') {
            source = 'budget'
            detail = await apiCall(ctx, 'GET', `${base}/budget`)
          }
          const extra: NextCall[] = item.action === 'raise-cap'
            ? [{ tool: 'specrails_analytics', args: { action: 'budget_set', projectId: item.projectId }, why: 'Raise the cap if the person agrees (write).' }]
            : item.action === 'retry-jira' ? [{ tool: 'specrails_jira', args: { action: 'outbox', projectId: item.projectId }, why: 'Inspect the failed Jira write-back.' }]
              : (item.kind === 'failed' || item.kind === 'blocked') && item.action !== 'open-review' ? [{ tool: 'specrails_jobs', args: { action: 'diagnose_failure', projectId: item.projectId, jobId: item.subjectId }, why: 'Why it stopped.' }] : []
          return toolResponse({ item: present(item), source, detail: bound(detail) }, {
            summary: `${item.kind === 'question' ? 'Question' : item.kind[0].toUpperCase() + item.kind.slice(1)} in ${item.projectName}: “${item.title}”${item.detail ? ` — ${item.detail}` : ''}.`,
            status: item.kind,
            ids: { itemId: item.id, projectId: item.projectId, subjectId: item.subjectId },
            next: [...extra, ...inboxNextCalls(item).filter((call) => call.args.action !== 'open')],
          })
        }
        case 'question': {
          const runId = requireRunId(args, 'question')
          const base = projectPath(ctx, args.projectId as string | undefined)
          const { question } = await pendingQuestion(ctx, base, runId)
          const pending = typeof question.question === 'string' && question.answeredAt === undefined
          return toolResponse(pending ? { pending: true, question: question.question, requestedAt: question.requestedAt ?? null } : { pending: false }, {
            summary: pending ? `The run is waiting for an answer: ${String(question.question).slice(0, 240)}` : 'This run has no pending question.',
            status: pending ? 'waiting' : 'no_question',
            ids: { runId },
            next: pending ? [{ tool: 'specrails_inbox', args: { action: 'answer', projectId: args.projectId, runId, answer: '<the person’s answer>' }, why: 'Answer with the person’s words (write).' }] : [],
          })
        }
        case 'answer': {
          const runId = requireRunId(args, 'answer')
          const answer = typeof args.answer === 'string' ? args.answer.trim() : ''
          if (!answer) throw new McpToolError('invalid_input', 'answer requires a non-empty "answer".')
          const base = projectPath(ctx, args.projectId as string | undefined)
          const { run, question } = await pendingQuestion(ctx, base, runId)
          if (typeof question.question !== 'string' || question.answeredAt !== undefined) {
            throw new McpToolError('conflict', 'This run has no pending question (it may already be answered).', {
              next: [{ tool: 'specrails_inbox', args: { action: 'list' }, why: 'See what is still waiting.' }],
            })
          }
          const definition = run.engineVersion === 2
          const path = definition ? `${base}/loop-runs/${encodeURIComponent(runId)}/resume` : `${base}/agent-runtime/runs/${encodeURIComponent(runId)}/resume`
          const result = await apiCall(ctx, 'POST', path, { answer, ...(definition && typeof question.stepId === 'string' ? { interruptId: question.stepId } : {}) })
          return toolResponse(result, {
            summary: 'Answer delivered; the run continues.', status: 'answered', ids: { runId },
            next: [{ tool: 'specrails_watch', args: { ref: runId, projectId: args.projectId, kind: 'loop_run' }, why: 'Follow the run until it settles.' }],
          })
        }
        case 'resume': {
          const runId = requireRunId(args, 'resume')
          if (args.runCap !== undefined && args.runCapUsd !== undefined) throw new McpToolError('invalid_input', 'Choose runCap:"ignore" or runCapUsd, not both.')
          const base = projectPath(ctx, args.projectId as string | undefined)
          const body: Row = {}
          if (args.runCap === 'ignore') body.runCap = 'ignore'
          if (typeof args.runCapUsd === 'number') body.runCapUsd = args.runCapUsd
          const result = await apiCall(ctx, 'POST', `${base}/loop-runs/${encodeURIComponent(runId)}/resume`, body)
          return toolResponse(result, {
            summary: 'Resume requested; the run continues in the background.', status: 'resuming', ids: { runId },
            next: [{ tool: 'specrails_watch', args: { ref: runId, projectId: args.projectId, kind: 'loop_run' }, why: 'Follow the run until it settles.' }],
          })
        }
        case 'retry': {
          const sourceId = typeof args.sourceId === 'string' ? args.sourceId : ''
          if (!SOURCE_ID.test(sourceId)) throw new McpToolError('invalid_input', 'retry requires "sourceId" (a delivery id or run:<id>) from the item\'s next call.')
          if (typeof args.railIndex !== 'number') throw new McpToolError('invalid_input', 'retry requires "railIndex".')
          const base = projectPath(ctx, args.projectId as string | undefined)
          const result = await apiCall(ctx, 'POST', `${base}/rails/${args.railIndex}/relaunch`, { sourceId })
          const jobId = record(result).jobId ?? record(result).loopRunId
          return toolResponse(result, {
            summary: `Retry launched on rail ${args.railIndex}.`, status: 'launched',
            ids: { railIndex: args.railIndex, ...(typeof jobId === 'string' ? { jobId } : {}) },
            next: typeof jobId === 'string' ? [{ tool: 'specrails_watch', args: { ref: jobId, projectId: args.projectId }, why: 'Follow the new attempt.' }] : [{ tool: 'specrails_rails', args: { action: 'list', projectId: args.projectId }, why: 'See the relaunched rail.' }],
          })
        }
        default:
          throw new McpToolError('invalid_input', `Unknown action "${action}".`)
      }
    },
  }]
}
