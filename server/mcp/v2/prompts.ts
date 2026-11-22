import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * MCP prompts of the v2 surface (slash commands in Claude Code:
 * `/mcp__specrails__start-my-day`; prompts in Codex). Each is a short recipe
 * over the v2 catalog. They describe calls only: every call keeps its tier and
 * the confirmation protocol, and nothing here approves anything. The calls
 * named are checked against the catalog (prompts.test.ts).
 */

const user = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] })

/** `, project:"shop-api"` when the person named one. */
const projectArg = (project?: string) => (project?.trim() ? `, project:${JSON.stringify(project.trim())}` : '')
const CLOSE = 'Answer in my language (pass it as lang). Show every preview before you confirm anything, and wait for my yes.'
/** The menu rule every prompt ends with: choices the person answers by keyboard (a number) or in their own words. */
const MENU = 'Give me every decision as a menu: your client\'s question tool, else a numbered list (recommended first, last "Something else — write it" in my language: menuOther); I answer with a number or my own words. End every step with next choices.'

export interface V2Prompt {
  name: string
  title: string
  description: string
  args: Record<string, string>
  render: (args: Record<string, string | undefined>) => GetPromptResult
}

export const V2_PROMPTS: readonly V2Prompt[] = [
  {
    name: 'start-my-day',
    title: 'Start my day',
    description: 'What needs me, what is running and what it costs, with one proposal per item.',
    args: { project: 'Only this project (optional)' },
    render: ({ project }) => user([
      'Brief me on Specrails.',
      `1. specrails_overview(action:"app"${projectArg(project)}): what needs me, what runs, failures, spend today and quotas.`,
      `2. specrails_inbox(action:"list"${projectArg(project)}): what waits, most urgent first.`,
      '3. Reply in at most 10 lines: what is running and today\'s spend, then a numbered menu of the items that need me (what, why it waits), most urgent first.',
      '4. When I pick one, show its choices (data.choices / state.offers: label and effect, recommended first). Run an offer only after I choose; then specrails_wait(action:"until") on its refs instead of checking back.',
      MENU,
      CLOSE,
    ].join('\n')),
  },
  {
    name: 'review-waiting',
    title: 'Review what is waiting',
    description: 'Deliveries and questions waiting for me, one at a time, with the recommended decision.',
    args: { project: 'Only this project (optional)' },
    render: ({ project }) => user([
      'Walk me through what waits for my review.',
      `1. specrails_deliveries(action:"list"${projectArg(project)}) and specrails_inbox(action:"list", filter:{kind:["question","review"]}${projectArg(project)}).`,
      '2. Take them one at a time. For a delivery: specrails_deliveries(action:"get", ref) for the packet; use view:"detail" with fields ["changes","ci","merge_preview"] only if I ask or the summary flags a risk.',
      '3. Tell me what changed, the checks and the risk, then the decisions as a menu (label and effect, recommended first). A question: its options as the menu.',
      '4. Act only on my word: specrails_deliveries(action:"decide", ref, decision) or specrails_inbox(action:"answer", ref, …); my own words on a delivery are a request for changes (decision request_changes, note). Merge, PRs and discards always need my confirmation.',
      MENU,
      CLOSE,
    ].join('\n')),
  },
  {
    name: 'ship-milestone',
    title: 'Ship a milestone',
    description: 'Generate, add and launch the next milestone of a blueprint project, then follow its chain.',
    args: { project: 'The project (optional when one is selected)', milestone: 'Milestone number (default: the next one)' },
    render: ({ project, milestone }) => user([
      `Ship ${milestone?.trim() ? `milestone ${milestone.trim()}` : 'the next milestone'} of this project with Specrails.`,
      `1. specrails_blueprint(action:"milestones"${projectArg(project)}): states, counts and the next step${milestone?.trim() ? ` for milestone ${milestone.trim()}` : ''}.`,
      '2. If its specs are not generated yet: specrails_blueprint(action:"milestone_generate"), show me the specs, and on my yes specrails_blueprint(action:"milestone_commit").',
      '3. specrails_blueprint(action:"chain_launch", milestone): show the preview (rails, provider, cost) and launch only after my yes.',
      '4. Follow it with specrails_wait(action:"until", refs:[the chain ref]); on a hold, specrails_blueprint(action:"chain_get"): tell me the reason and give me its offers as a menu.',
      MENU,
      CLOSE,
    ].join('\n')),
  },
  {
    name: 'why-stuck',
    title: 'Why is this run stuck',
    description: 'Explain why a run waits, stopped or failed, and propose one next step.',
    args: { run: 'Run ref (run:<project>/<id>); default: the most recent run that needs me' },
    render: ({ run }) => user([
      run?.trim() ? `Explain why ${run.trim()} is stuck.` : 'Find the most recent Specrails run that is blocked, failed or waiting for me, and explain why.',
      `1. ${run?.trim() ? `specrails_runs(action:"get", ref:${JSON.stringify(run.trim())})` : 'specrails_runs(action:"list", filter:{needsYou:true}) and pick the latest, then specrails_runs(action:"get", ref)'}: status, hold and offers.`,
      '2. If it failed or stopped: specrails_runs(action:"diagnose", ref) for the diagnosis and saved analysis. If it waits for a limit or a question, the hold says which.',
      '3. Answer in at most 6 lines: the cause (observed vs. likely), then its offers as a menu, the recommended first with why and its cost if it starts AI work.',
      '4. Do not resume, retry, switch provider or generate a new analysis until I choose.',
      MENU,
      CLOSE,
    ].join('\n')),
  },
  {
    name: 'implement',
    title: 'Implement specs',
    description: 'Launch one or more specs on rails after a cost preview, then report when they settle.',
    args: { specs: 'Spec refs or numbers, comma-separated', project: 'Their project (optional with refs)' },
    render: ({ specs, project }) => user([
      `Implement ${specs?.trim() ? `these specs: ${specs.trim()}` : 'the spec I name'} with Specrails.`,
      `1. specrails_specs(action:"get", ref) for each${projectArg(project)}; stop and tell me if one is a draft, already running or done.`,
      '2. specrails_runs(action:"launch", target:{specIds:[…]}, dryRun:true): show me the rails, provider and cost forecast.',
      '3. Ask as a menu (1. Launch · 2. Change provider or rails · 3. Something else). On my yes, launch with the confirmToken. Then specrails_wait(action:"until", refs:[the run refs]) and report each outcome; a finished run becomes a delivery for my review.',
      MENU,
      CLOSE,
    ].join('\n')),
  },
  {
    name: 'spend',
    title: 'What did we spend',
    description: 'Spend, subscription usage and limits in plain words, with what is close to a limit.',
    args: { project: 'Only this project (optional)' },
    render: ({ project }) => user([
      'How much are we spending on AI with Specrails, and how close are we to any limit?',
      `1. specrails_insights(action:"spend"${projectArg(project)}) for billed vs. estimated spend and the costliest work.`,
      '2. specrails_insights(action:"usage") for subscription windows and resets; specrails_insights(action:"budget_get") for the spend limits.',
      '3. Answer in at most 8 lines with numbers, labelling estimates as estimates. Change no limit unless I ask.',
      '4. End with a short menu of next steps (e.g. see the costliest runs, set a spend limit, nothing).',
      MENU,
      CLOSE,
    ].join('\n')),
  },
]

export function registerV2Prompts(server: McpServer): void {
  for (const prompt of V2_PROMPTS) {
    const argsSchema = Object.fromEntries(Object.entries(prompt.args).map(([name, description]) => [name, z.string().max(200).optional().describe(description)]))
    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema }, (args: Record<string, string | undefined>) => prompt.render(args))
  }
}
