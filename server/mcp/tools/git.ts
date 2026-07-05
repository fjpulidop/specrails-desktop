import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'
import { GIT_DIAGNOSTIC_ACTIONS, gitDiagnosticHelp, isGitDiagnosticAction } from '../../git-diagnostics'

/**
 * Read-only git / GitHub (gh) diagnostics for a project, run through the app's
 * OWN bundled git/gh against the repo. This is the sanctioned MCP path for the
 * operator agent to inspect version-control state — it does NOT need (and should
 * not use) a raw shell for this. Every action is a FIXED, read-only command; the
 * caller only names an action, never arguments. Repo MUTATIONS (push, pr create,
 * commit) are intentionally NOT here — those belong to the ask-first PR flow
 * (specrails_rails PR decisions), which is auditable and confirmation-gated.
 */
export function gitTools(): McpToolSpec[] {
  const help = gitDiagnosticHelp()
  const actionLines = GIT_DIAGNOSTIC_ACTIONS.map((a) => `${a} (${help[a]})`).join('; ')
  return [
    {
      name: 'specrails_git',
      title: 'Git & GitHub diagnostics',
      description:
        "READ-ONLY git/GitHub diagnostics for a project, via the app's bundled git/gh — use this " +
        "(not a raw shell) to answer questions like \"is this repo connected to GitHub?\", \"what's the " +
        'remote?\", \"is gh authenticated?\", \"what changed?\", or to inspect PRs. Runs against the ' +
        "project's real repo. All actions are read-only and never prompt. " +
        `Actions: ${actionLines}. ` +
        'These are NOT for mutating the repo — pushing / creating PRs / committing go through the ' +
        'ask-first PR flow (specrails_rails PR decisions), never here.',
      hintTier: 'read',
      tier: 'read',
      inputSchema: {
        action: z
          .enum(GIT_DIAGNOSTIC_ACTIONS as unknown as [string, ...string[]])
          .describe('Which read-only diagnostic to run'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string
        if (!isGitDiagnosticAction(action)) {
          throw new Error(`Unknown action "${action}". Allowed: ${GIT_DIAGNOSTIC_ACTIONS.join(', ')}.`)
        }
        const qs = new URLSearchParams({ action })
        const r = (await apiCall(ctx, 'GET', `${base}/git/diagnostic?${qs.toString()}`)) as Record<string, unknown>
        // A non-zero exit is a NORMAL, informative outcome (e.g. `gh repo view`
        // when the repo has no GitHub remote) — surface it plainly so the agent
        // reports the real state instead of treating it as an error.
        return {
          ...r,
          hint: r.ok === false
            ? 'The command exited non-zero — this is often meaningful (e.g. no GitHub remote, or gh not authenticated). Read stderr/stdout and report the real state to the user; do not treat it as a tool failure.'
            : undefined,
        }
      },
    },
  ]
}
