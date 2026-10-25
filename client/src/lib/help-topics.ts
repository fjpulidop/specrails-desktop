import type { DocsTarget } from './docs-events'

/**
 * Where each in-app "Learn more" hint lands in the user guide. A topic maps to
 * a guide page (`docs/guide/<locale>/<category>/<n>-<slug>.md`) and to a
 * heading carrying an explicit, locale-independent anchor (`## Title {#anchor}`).
 *
 * Adding a topic: add it here, give the target heading its `{#anchor}` in all
 * 8 locales' guide, and add `help.topics.<id>` to `common.json` in all 8
 * locales. `help-topics.test.ts` fails on a dead anchor or a missing name.
 */
export const HELP_TOPICS = {
  themes: { category: 'settings', slug: 'themes', anchor: 'themes' },
  codeExplorer: { category: 'insights', slug: 'code-explorer', anchor: 'code-explorer' },
  integratedTerminal: { category: 'insights', slug: 'the-integrated-terminal', anchor: 'integrated-terminal' },
  agents: { category: 'agents', slug: 'meet-the-agents', anchor: 'agents' },
  aiProviders: { category: 'integrations', slug: 'ai-providers', anchor: 'ai-providers' },
  mcpServer: { category: 'integrations', slug: 'mcp-server', anchor: 'mcp-server' },
  mobileCompanion: { category: 'integrations', slug: 'mobile-companion', anchor: 'mobile-companion' },
  plugins: { category: 'integrations', slug: 'plugins', anchor: 'plugins' },
  existingProjects: { category: 'settings', slug: 'existing-projects', anchor: 'existing-projects' },
  projectRules: { category: 'settings', slug: 'existing-projects', anchor: 'project-rules' },
  updates: { category: 'settings', slug: 'updates', anchor: 'updates' },
  providerCapabilities: { category: 'pipeline', slug: 'picking-an-engine-per-rail', anchor: 'provider-capabilities' },
  projectEnvironment: { category: 'settings', slug: 'project-environment', anchor: 'project-environment' },
  telemetry: { category: 'settings', slug: 'pipeline-telemetry-and-diagnostics', anchor: 'telemetry' },
  dailyBudget: { category: 'insights', slug: 'analytics-and-cost-tracking', anchor: 'daily-budget' },
  specsBoard: { category: 'specs', slug: 'specs-and-the-backlog', anchor: 'specs-backlog' },
  specTimeline: { category: 'specs', slug: 'specs-and-the-backlog', anchor: 'spec-timeline' },
  recentlyDeleted: { category: 'specs', slug: 'specs-and-the-backlog', anchor: 'recently-deleted' },
  railLoops: { category: 'pipeline', slug: 'rails-and-jobs', anchor: 'rail-loops' },
  flowMode: { category: 'integrations', slug: 'flow-mode', anchor: 'flow-mode' },
  flowHandOff: { category: 'integrations', slug: 'flow-mode', anchor: 'flow-hand-off' },
  contextScope: { category: 'specs', slug: 'add-spec-explore-mode', anchor: 'context-scope' },
  launchForecast: { category: 'pipeline', slug: 'rails-and-jobs', anchor: 'launch-forecast' },
  loopBuilder: { category: 'pipeline', slug: 'the-loop-builder', anchor: 'loop-builder' },
  accessibility: { category: 'settings', slug: 'accessibility', anchor: 'accessibility' },
  shortcuts: { category: 'getting-started', slug: 'the-dashboard-tour', anchor: 'shortcuts' },
  inbox: { category: 'getting-started', slug: 'the-dashboard-tour', anchor: 'shortcuts' },
} as const satisfies Record<string, DocsTarget & { anchor: string }>

export type HelpTopicId = keyof typeof HELP_TOPICS

export function helpTarget(topic: HelpTopicId): DocsTarget {
  const { category, slug, anchor } = HELP_TOPICS[topic]
  return { category, slug, anchor }
}

/** App settings section → its guide topic (sections without a guide page, or whose own fields carry a hint, are absent). */
export const APP_SETTINGS_HELP = {
  appearance: 'themes',
  effects: 'themes',
  code: 'codeExplorer',
  terminal: 'integratedTerminal',
  specrailsAgents: 'agents',
  subscriptionUsage: 'aiProviders',
  mcp: 'mcpServer',
  mobile: 'mobileCompanion',
  projects: 'existingProjects',
  updates: 'updates',
} as const satisfies Record<string, HelpTopicId>

/** Project settings section → its guide topic. */
export const PROJECT_SETTINGS_HELP = {
  agentRuntime: 'providerCapabilities',
  subagents: 'agents',
  environment: 'projectEnvironment',
  telemetry: 'telemetry',
  rules: 'projectRules',
  terminal: 'integratedTerminal',
  recentlyDeleted: 'recentlyDeleted',
} as const satisfies Record<string, HelpTopicId>
