import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * Short MCP prompts (slash-command style recipes) that chain the Specrails
 * tools. They only describe calls; every call keeps its own permission tier,
 * and nothing here grants a permission.
 */

const user = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] })
const scope = (projectId?: string) => (projectId ? `, projectId:"${projectId}"` : '')

export const PROMPTS = {
  'diagnose-failure': {
    title: 'Diagnose a failed job',
    description: 'Explain why a job failed and recommend one next step, without retrying anything.',
    render: ({ jobId, projectId }: { jobId?: string; projectId?: string }) => user([
      jobId
        ? `Explain why Specrails job ${jobId} failed.`
        : 'Find the most recent failed Specrails job (specrails_status lists recent failures) and explain why it failed.',
      `1. specrails_jobs(action:"diagnose_failure", jobId${scope(projectId)}) for the diagnosis and the saved AI analysis.`,
      `2. specrails_jobs(action:"logs", jobId${scope(projectId)}) for the failed step's lines.`,
      `3. If it ran on the Core runtime, specrails_runs(action:"diagnose", jobId${scope(projectId)}) for the recovery assessment.`,
      'Answer in at most 6 short lines: the cause (observed vs. hypothesis), then ONE recommended next action and why.',
      'Do not resume, retry, relaunch or generate an AI analysis (ai-spawn) unless the person asks.',
    ].join('\n')),
  },
  'launch-spec': {
    title: 'Launch a spec on a rail',
    description: 'Prepare the implementation of one spec on a free rail and launch it after the person confirms.',
    render: ({ specId, projectId }: { specId?: string; projectId?: string }) => user([
      `Implement spec #${specId ?? '<id>'} with Specrails.`,
      `1. specrails_specs(action:"get", id:${specId ?? '<id>'}${scope(projectId)}): read it; stop if it is a draft or already on review.`,
      `2. specrails_board(${projectId ? `projectId:"${projectId}"` : ''}): pick a free rail (say "Rail N" = railIndex + 1), or plan specrails_rails(action:"create_rail") when none is free.`,
      '3. Tell the person the rail, the provider and that it costs tokens; wait for a yes.',
      '4. specrails_rails(action:"set_tickets", railIndex, ticketIds:[id]) then specrails_rails(action:"launch", railIndex) (ai-spawn).',
      '5. specrails_watch(ref:<jobId or loopRunId>) and report the outcome; a delivery waits for the person\'s review.',
    ].join('\n')),
  },
  'triage-inbox': {
    title: 'Triage the inbox',
    description: 'Summarize what waits for the person and propose an action for each item.',
    render: () => user([
      'Triage what Specrails needs from me.',
      '1. specrails_inbox(action:"list") for every waiting item, oldest first.',
      '2. For questions, specrails_inbox(action:"question") to read them; for failures, specrails_jobs(action:"diagnose_failure"); for reviews, specrails_rails(action:"review_packet").',
      '3. Reply with one line per item: what it is, why it waits, and the action you propose (answer, resume, retry, review in the app).',
      'Do not answer, resume or retry anything until I choose; PR decisions, merge and discard stay in the app.',
    ].join('\n')),
  },
} as const

export function registerPrompts(server: McpServer): void {
  const optionalId = z.string().max(200).optional()
  server.registerPrompt('diagnose-failure', {
    title: PROMPTS['diagnose-failure'].title, description: PROMPTS['diagnose-failure'].description,
    argsSchema: { jobId: optionalId.describe('The failed job id (omit for the latest failure)'), projectId: optionalId.describe('Its project') },
  }, (args) => PROMPTS['diagnose-failure'].render(args))
  server.registerPrompt('launch-spec', {
    title: PROMPTS['launch-spec'].title, description: PROMPTS['launch-spec'].description,
    argsSchema: { specId: z.string().max(20).describe('Numeric spec id'), projectId: optionalId.describe('Its project') },
  }, (args) => PROMPTS['launch-spec'].render(args))
  server.registerPrompt('triage-inbox', {
    title: PROMPTS['triage-inbox'].title, description: PROMPTS['triage-inbox'].description,
  }, () => PROMPTS['triage-inbox'].render())
}
