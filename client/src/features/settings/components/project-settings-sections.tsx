import type { ComponentType } from 'react'
import { SlidersHorizontal, Wallet, Activity, TerminalSquare, KeyRound, GitBranch, Bot, Network, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import { SettingAnchor } from './SettingAnchor'
import { ProjectSubagentsSection } from './SubagentsSettingsSection'
import { TerminalSettingsSection } from './TerminalSettingsSection'
import { RecentlyDeletedSection } from './RecentlyDeletedSection'
import { ProjectRepositoriesSection } from './ProjectRepositoriesSection'
import { AgentRuntimeSettingsSection } from './AgentRuntimeSettingsSection'
import { ProjectAgentEnvModeSection } from './AgentEnvModeSection'
import { ProjectAnchoringSection, ProjectRulesSection } from './ProjectAnchoringSections'
import {
  ProjectTelemetrySection,
  ProjectPrePromptsSection,
  ProjectIntegrationBranchSection,
  ProjectBudgetSection,
  ProjectAgentAuditSection,
  ProjectWorktreeEnvSection,
  ProjectReviewWipSection,
} from './ProjectSettingsSections'

function ProjectTerminalSection() {
  return <TerminalSettingsSection mode="project" />
}

export interface ProjectSettingsSection {
  id: string
  icon: LucideIcon
  /** settings-namespace key for the nav label. */
  labelKey: string
  /** Section bodies rendered in order inside the pane. */
  panes: readonly ComponentType[]
}

/**
 * Single source of truth for project settings. The /settings route (both UI
 * modes) renders every pane in this order on one page, with a sticky section
 * index beside it (a select below 900px). Adding a section here adds it to
 * the page and to that index.
 */
export const PROJECT_SETTINGS_SECTIONS = [
  { id: 'general', icon: SlidersHorizontal, labelKey: 'projectDialog.nav.general', panes: [ProjectRepositoriesSection, ProjectPrePromptsSection] },
  { id: 'agentRuntime', icon: Bot, labelKey: 'projectDialog.nav.agentRuntime', panes: [AgentRuntimeSettingsSection] },
  { id: 'subagents', icon: Network, labelKey: 'projectDialog.nav.subagents', panes: [ProjectSubagentsSection] },
  { id: 'branch', icon: GitBranch, labelKey: 'projectDialog.nav.branch', panes: [ProjectIntegrationBranchSection] },
  { id: 'environment', icon: KeyRound, labelKey: 'projectDialog.nav.environment', panes: [ProjectWorktreeEnvSection, ProjectAgentEnvModeSection] },
  { id: 'budget', icon: Wallet, labelKey: 'projectDialog.nav.budget', panes: [ProjectBudgetSection, ProjectReviewWipSection] },
  { id: 'telemetry', icon: Activity, labelKey: 'projectDialog.nav.telemetry', panes: [ProjectTelemetrySection, ProjectAgentAuditSection] },
  { id: 'rules', icon: ShieldCheck, labelKey: 'projectDialog.nav.rules', panes: [ProjectAnchoringSection, ProjectRulesSection] },
  { id: 'terminal', icon: TerminalSquare, labelKey: 'projectDialog.nav.terminal', panes: [ProjectTerminalSection] },
  { id: 'recentlyDeleted', icon: Trash2, labelKey: 'projectDialog.nav.recentlyDeleted', panes: [RecentlyDeletedSection] },
] as const satisfies readonly ProjectSettingsSection[]

export type ProjectSettingsSectionId = (typeof PROJECT_SETTINGS_SECTIONS)[number]['id']

/**
 * `data-setting-id` of each pane (see `lib/settings-registry.ts`): the ⌘K `/`
 * scope lands on these. A test pins this map to the registry.
 */
export const PROJECT_PANE_ANCHORS: ReadonlyMap<ComponentType, string> = new Map<ComponentType, string>([
  [ProjectRepositoriesSection, 'repositories'],
  [ProjectPrePromptsSection, 'prePrompt'],
  [AgentRuntimeSettingsSection, 'verificationCommands'],
  [ProjectSubagentsSection, 'subagentsProject'],
  [ProjectIntegrationBranchSection, 'integrationBranch'],
  [ProjectWorktreeEnvSection, 'worktreeEnv'],
  [ProjectAgentEnvModeSection, 'agentEnv'],
  [ProjectBudgetSection, 'projectBudget'],
  [ProjectReviewWipSection, 'reviewLimit'],
  [ProjectTelemetrySection, 'telemetry'],
  [ProjectAgentAuditSection, 'agentAudit'],
  [ProjectAnchoringSection, 'anchoring'],
  [ProjectRulesSection, 'projectRules'],
  [ProjectTerminalSection, 'terminalProject'],
  [RecentlyDeletedSection, 'recentlyDeleted'],
])

/** A pane wrapped in its ⌘K anchor. */
export function ProjectSettingsPane({ Pane }: { Pane: ComponentType }) {
  const anchor = PROJECT_PANE_ANCHORS.get(Pane)
  return anchor ? <SettingAnchor id={anchor}><Pane /></SettingAnchor> : <Pane />
}
