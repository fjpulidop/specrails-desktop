import type { ComponentType } from 'react'
import { SlidersHorizontal, Wallet, Activity, TerminalSquare, KeyRound, GitBranch, Bot, Network, ShieldCheck, type LucideIcon } from 'lucide-react'
import { ProjectSubagentsSection } from './SubagentsSettingsSection'
import { TerminalSettingsSection } from './TerminalSettingsSection'
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
 * Single source of truth for project settings. The Agent-mode dialog renders
 * one pane per entry behind a left nav; the Kanban /settings route renders
 * every pane in this same order on one page. Adding a section here adds it
 * to both surfaces.
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
] as const satisfies readonly ProjectSettingsSection[]

export type ProjectSettingsSectionId = (typeof PROJECT_SETTINGS_SECTIONS)[number]['id']
