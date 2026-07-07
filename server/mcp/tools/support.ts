import { z } from 'zod'
import { isMcpEnabled, isTierEnabled } from '../mcp-tiers'
import { apiCall, getActiveProject, requireProject } from './types'
import type { McpToolContext, McpToolSpec } from './types'
import { serializeProject } from './projects'

const SUPPORT_TOPICS = [
  'installation',
  'project_setup',
  'provider_cli',
  'mcp_connection',
  'agent_chat',
  'framework_install',
  'specs_backlog',
  'rails_jobs',
  'git_pr',
  'analytics_costs',
  'plugins_integrations',
  'general_usage',
] as const

type SupportTopic = typeof SUPPORT_TOPICS[number]

interface DiagnosticResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * Support triage and repair entry point. This is intentionally NOT a spec
 * creation path: it keeps user-help requests in the conversation and routes
 * framework repairs through explicit support actions.
 */
export function supportTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_support',
      title: 'Support & troubleshooting',
      description:
        'Support and troubleshooting for Specrails installation and usage problems. Use this when the user needs help setting up Specrails, adding/provisioning a project, fixing missing agents/skills/commands from the global specrails-core framework, provider CLI/MCP/agent-chat issues, rails/jobs/specs, or GitHub/PR/cost/plugin questions. ' +
        'Actions: triage (read-only support playbook + diagnostics), core_update_status/check/apply (global specrails-core framework update). ' +
        'This tool never creates specs; repair actions require the normal permission tier and explicit user confirmation.',
      tier: (a) => (String(a.action) === 'core_update_apply' ? 'ai-spawn' : 'read'),
      hintTier: 'read',
      inputSchema: {
        action: z
          .enum([
            'triage',
            'core_update_status',
            'core_update_check',
            'core_update_apply',
          ])
          .describe('Support operation to perform'),
        question: z
          .string()
          .optional()
          .describe('The user-facing problem or question to triage, in the user wording when possible'),
        topic: z
          .enum(SUPPORT_TOPICS)
          .optional()
          .describe('Optional explicit support topic; omit to infer from question'),
        projectId: z
          .string()
          .optional()
          .describe('Optional project id when the issue is project-specific; defaults to the active project when selected'),
        version: z
          .string()
          .optional()
          .describe('core_update_apply: optional target specrails-core version; omit to use the latest version found by core_update_check'),
        includeDiagnostics: z
          .boolean()
          .optional()
          .describe('When true or omitted, include read-only local diagnostics such as prerequisites, providers, settings, and projects. Project setup checkpoints are skipped for specrails-core installation triage because they are not a core health signal.'),
      },
      async handler(ctx, args) {
        const action = String(args.action)

        switch (action) {
          case 'core_update_status':
            return apiCall(ctx, 'GET', '/core-update/status')
          case 'core_update_check':
            return apiCall(ctx, 'POST', '/core-update/check', {})
          case 'core_update_apply': {
            const body = typeof args.version === 'string' && args.version.trim()
              ? { version: args.version.trim() }
              : {}
            const r = await apiCall(ctx, 'POST', '/core-update/update', body)
            return {
              ...(typeof r === 'object' && r !== null ? r : { result: r }),
              hint:
                'Core update is async and app-global. Progress streams as core_update.progress / framework.updated. This updates the global specrails-core framework; it is not a per-project setup/install action.',
            }
          }
          case 'triage':
            break
          default:
            throw new Error(`Unknown action "${action}".`)
        }

        const question = typeof args.question === 'string' ? args.question.trim() : ''
        const topic = isSupportTopic(args.topic) ? args.topic : inferTopic(question)
        const includeDiagnostics = args.includeDiagnostics !== false
        const diagnostics = includeDiagnostics
          ? await collectDiagnostics(ctx, args.projectId as string | undefined, topic)
          : { skipped: true }

        return {
          mode: 'support-triage',
          doNotCreateSpec: true,
          topic,
          question: question || null,
          supportPrompt: [
            'Treat this as a help/support conversation, not product backlog intake.',
            'Answer in the user language and solve the immediate setup or usage problem with concrete steps.',
            'Do not create or propose a spec unless the user explicitly pivots from troubleshooting to new product work.',
            'Prefer read-only diagnostics first. Ask at most two targeted questions if the next step depends on missing local context.',
            'If a fix requires write, ai-spawn, or destructive permissions, explain the exact action and ask for confirmation before calling another tool.',
            'For missing agents, skills, slash commands, or specrails-core framework files during a job, explain that these definitions live in the app-global specrails-core framework. Do not use project setup checkpoints as evidence of core health or as a reason to run project setup.',
          ],
          localDiagnostics: diagnostics,
          recommendedNextSteps: nextSteps(topic),
          suggestedReadTools: suggestedTools(topic),
          availableRepairActions: repairActions(topic),
          responseChecklist: [
            'State what the diagnostics show, including any unknowns or failed probes.',
            'Give the smallest next action the user can take in the app or terminal.',
            'Name the exact Specrails surface when relevant: Add Project, Setup, Settings > MCP, Agent Chat, Rails board, Job Detail, Analytics, Integrations.',
            'If the issue is already resolved by state, say so and explain how to verify it.',
          ],
        }
      },
    },
  ]
}

function isSupportTopic(value: unknown): value is SupportTopic {
  return typeof value === 'string' && (SUPPORT_TOPICS as readonly string[]).includes(value)
}

function inferTopic(question: string): SupportTopic {
  const q = question.toLowerCase()
  if (/\b(mcp|claude desktop|cursor|external ai|token|settings.*mcp)\b/.test(q)) return 'mcp_connection'
  if (/\b(agent chat|chat panel|shift\+tab|permission level|observe|operate|autonomous)\b/.test(q)) return 'agent_chat'
  if (/\b(specrails-core|core framework|missing agents?|missing skills?|no agents?|no skills?|slash command|command not found|propose-feature|opsx|framework files?|reinstall)\b/.test(q)) return 'framework_install'
  if (/\b(claude|codex|gemini|provider|engine|cli|auth|login|api key|path)\b/.test(q)) return 'provider_cli'
  if (/\b(add project|project setup|setup wizard|provision|checkpoint|install config)\b/.test(q)) return 'project_setup'
  if (/\b(install|installation|setup|prerequisite|node|npm|npx|git)\b/.test(q)) return 'installation'
  if (/\b(rail|job|launch|run|queue|stuck|failed|logs?)\b/.test(q)) return 'rails_jobs'
  if (/\b(github|git|pr|pull request|remote|branch|merge|integrate locally)\b/.test(q)) return 'git_pr'
  if (/\b(cost|spend|budget|analytics|tokens?)\b/.test(q)) return 'analytics_costs'
  if (/\b(plugin|integration|serena|marketplace)\b/.test(q)) return 'plugins_integrations'
  if (/\b(spec|ticket|backlog|draft|todo|done|review)\b/.test(q)) return 'specs_backlog'
  return 'general_usage'
}

async function collectDiagnostics(ctx: McpToolContext, projectId: string | undefined, topic: SupportTopic): Promise<Record<string, unknown>> {
  const projects = ctx.registry.listContexts().map((c) => serializeProject(c.project))
  const selectedProjectId = projectId ?? getActiveProject(ctx) ?? undefined
  const out: Record<string, unknown> = {
    mcp: {
      enabled: isMcpEnabled(ctx.desktopDb),
      tierWrite: isTierEnabled(ctx.desktopDb, 'write'),
      tierAiSpawn: isTierEnabled(ctx.desktopDb, 'ai-spawn'),
      tierDestructive: isTierEnabled(ctx.desktopDb, 'destructive'),
    },
    activeProjectId: getActiveProject(ctx),
    projectCount: projects.length,
    projects,
    prerequisites: await safeDiagnostic(() => apiCall(ctx, 'GET', '/setup-prerequisites?diagnostic=1')),
    availableProviders: await safeDiagnostic(() => apiCall(ctx, 'GET', '/available-providers')),
    coreUpdate: await safeDiagnostic(() => apiCall(ctx, 'GET', '/core-update/status')),
  }

  if (!selectedProjectId) {
    out.project = {
      ok: false,
      error: 'No active project or projectId was provided. Project-specific diagnostics need specrails_select_project or projectId.',
    }
    return out
  }

  const project = safeLocal(() => serializeProject(requireProject(ctx, selectedProjectId).project))
  out.project = project
  if (project.ok && topic !== 'framework_install') {
    out.setupCheckpoints = await safeDiagnostic(() =>
      apiCall(ctx, 'GET', `/projects/${selectedProjectId}/setup/checkpoints`),
    )
  } else if (topic === 'framework_install') {
    out.setupCheckpoints = {
      skipped: true,
      reason:
        'Skipped intentionally: project setup checkpoints are not a specrails-core health check. Pending checkpoints or 0 agent/command counts must not be used to diagnose global core installation.',
    }
  }
  return out
}

async function safeDiagnostic(fn: () => Promise<unknown>): Promise<DiagnosticResult> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function safeLocal(fn: () => unknown): DiagnosticResult {
  try {
    return { ok: true, data: fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function nextSteps(topic: SupportTopic): string[] {
  switch (topic) {
    case 'installation':
      return [
        'Read prerequisites and availableProviders from localDiagnostics.',
        'If Node/npm/npx/git are missing, tell the user to install them, restart Specrails, then recheck.',
        'If a provider CLI is missing, install and authenticate that CLI before retrying project setup.',
      ]
    case 'project_setup':
      return [
        'Check whether the project is registered and whether setupCheckpoints.isInstalling is still true.',
        'If setup is running, tell the user to wait or poll checkpoints; if failed, surface the last log lines and retry only the failed setup step.',
        'If no project is selected, ask for the repo path and provider choices before using specrails_setup.',
      ]
    case 'provider_cli':
      return [
        'Compare availableProviders with the providers installed on the project.',
        'Ask the user to verify the provider CLI in a fresh terminal only when the local probe is missing or ambiguous.',
        'For auth failures, direct them to the provider CLI login/API-key flow, then re-open or retry Specrails setup.',
      ]
    case 'mcp_connection':
      return [
        'Check localDiagnostics.mcp.enabled and explain that external clients also need the Settings > MCP config and token.',
        'If MCP is off, tell the user to enable it in Settings > MCP; do not try to mutate the MCP enable flag through this tool.',
        'If a tier blocks an action, name the exact tier to enable in Settings > MCP.',
      ]
    case 'agent_chat':
      return [
        'Explain the in-app permission ladder: observe, edit, operate, autonomous.',
        'If a tool was refused, tell the user which level to switch to with Shift+Tab.',
        'If Agent Chat cannot operate, check MCP enabled state and installed provider state first.',
      ]
    case 'framework_install':
      return [
        'For specrails-core installation questions, evaluate only global core status and prerequisites. Do not treat project setup checkpoints as evidence of a core problem.',
        'If global core status is current/healthy and the user has not provided an actual job error, say the core installation looks healthy and ask for the concrete failing job/error before recommending repair.',
        'If a job explicitly reports missing agents, missing skills, unresolved slash commands, or missing /specrails:* commands, explain that those definitions come from the app-global specrails-core framework.',
        'If an update is available, offer core_update_check followed by core_update_apply with confirmation. If no update is available but the job still fails with missing core definitions, give the manual fallback: run `npx specrails-core@latest update` from the project root, then retry, or collect the job diagnostic for a framework-loading bug.',
        'Never recommend specrails_setup(install) or a project reinstall solely because setup/checkpoints show pending or 0 agents/commands.',
      ]
    case 'rails_jobs':
      return [
        'Use read tools for rails/jobs status before guessing: specrails_rails, specrails_jobs, and specrails_watch only when the user asks to wait.',
        'For a failed or stuck job, inspect the Job Detail logs and report the real failure.',
        'Do not relaunch or stop anything without confirmation and the required permission level.',
      ]
    case 'git_pr':
      return [
        'Use specrails_git read-only diagnostics for remote, status, branch, gh_auth, gh_repo, and PR questions.',
        'Explain that PR creation/integration belongs to the rail PR-decision surface, not this support tool.',
        'If there is no GitHub remote, explain local-only delivery and Integrate locally.',
      ]
    case 'analytics_costs':
      return [
        'Use specrails_analytics(spending) for actual cost questions.',
        'Distinguish app-wide budget settings from per-project analytics budget caps.',
        'Prefix cost with ~ when the provider reports estimates.',
      ]
    case 'plugins_integrations':
      return [
        'Use specrails_plugins read actions before suggesting install/uninstall.',
        'For degraded plugins, report health details and avoid blocking rail launches.',
        'Mutating plugin actions need explicit confirmation and the matching permission level.',
      ]
    case 'specs_backlog':
      return [
        'Use specrails_specs list/get to explain current backlog state.',
        'Only create or edit specs if the user asks for backlog work, not when they are asking how Specrails works.',
        'Do not patch pipeline-managed statuses unless the user explicitly asks and understands the consequence.',
      ]
    case 'general_usage':
      return [
        'Use specrails_guide and specrails_search to find the relevant domain.',
        'Explain the UI path first, then offer to perform safe read/write actions from chat when appropriate.',
        'Keep the answer short and operational; ask one targeted question if the requested surface is unclear.',
      ]
  }
}

function suggestedTools(topic: SupportTopic): string[] {
  switch (topic) {
    case 'installation':
      return ['specrails_support', 'specrails_setup(prerequisites)', 'specrails_setup(available_providers)']
    case 'project_setup':
      return ['specrails_projects(list|get)', 'specrails_setup(checkpoints)', 'specrails_setup(prerequisites)']
    case 'provider_cli':
      return ['specrails_setup(available_providers)', 'specrails_setup(prerequisites)', 'specrails_projects(get)']
    case 'mcp_connection':
      return ['specrails_settings(get)', 'specrails_guide', 'specrails_describe']
    case 'agent_chat':
      return ['specrails_settings(get)', 'specrails_projects(list|get)', 'specrails_guide']
    case 'framework_install':
      return ['specrails_support(triage|core_update_status|core_update_check)', 'specrails_jobs(get)', 'specrails_jobs(diagnostic)']
    case 'rails_jobs':
      return ['specrails_rails', 'specrails_jobs', 'specrails_watch']
    case 'git_pr':
      return ['specrails_git(remote|status|branch|gh_auth|gh_repo|gh_pr_list|gh_pr_view)']
    case 'analytics_costs':
      return ['specrails_analytics(spending)', 'specrails_settings(get)']
    case 'plugins_integrations':
      return ['specrails_plugins(list|health|preview)', 'specrails_projects(get)']
    case 'specs_backlog':
      return ['specrails_specs(list|get)', 'specrails_guide']
    case 'general_usage':
      return ['specrails_guide', 'specrails_search', 'specrails_describe']
  }
}

function repairActions(topic: SupportTopic): string[] {
  if (topic === 'framework_install') {
    return [
      'specrails_support(core_update_check) then specrails_support(core_update_apply) - apply requires operate/ai-spawn and only makes sense when a newer global specrails-core framework is available.',
      'Manual fallback when no update is available but a real job still cannot load core definitions: run `npx specrails-core@latest update` from the project root, then retry or collect a job diagnostic.',
    ]
  }
  if (topic !== 'project_setup' && topic !== 'installation') return []
  return [
    'specrails_setup(install, projectId) - operate/ai-spawn: use only for actual project setup/provisioning, not for specrails-core global installation questions.',
    'specrails_support(core_update_check) then specrails_support(core_update_apply) - apply requires operate/ai-spawn: updates the app-global specrails-core framework when a newer version is available.',
  ]
}
