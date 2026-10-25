/**
 * Typed registry of the settings ⌘K can open (CD6, the `/` scope).
 *
 * One entry per settings block (a card or a pane) a person might look for. The
 * entry owns no copy: its label and search keywords are the `commands`
 * namespace strings `palette.settings.entries.<id>.label|keywords` (all 8
 * locales), and the block carries a matching `data-setting-id="<id>"` anchor so
 * the palette can open the right surface at the right section, scroll to it and
 * focus its first control. `SettingsRegistry.test.tsx` mounts both dialogs and
 * fails on a registry id with no anchor (or an anchor with no entry).
 */
import { APP_SETTINGS_SECTIONS, type AppSettingsSection } from '../../../lib/app-settings-events'
import { PROJECT_SETTINGS_SECTION_IDS } from './project-settings-section-ids'

export type SettingScope = 'app' | 'project'

export interface SettingEntry {
  /** Also the `data-setting-id` anchor and the i18n key segment. */
  id: string
  scope: SettingScope
  /** `AppSettingsSection` for `app`, a project-settings section id for `project`. */
  section: string
}

const app = (id: string, section: AppSettingsSection): SettingEntry => ({ id, scope: 'app', section })
const project = (id: string, section: (typeof PROJECT_SETTINGS_SECTION_IDS)[number]): SettingEntry => ({ id, scope: 'project', section })

export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
  app('theme', 'appearance'),
  app('language', 'appearance'),
  app('density', 'appearance'),
  app('reduceMotion', 'appearance'),
  app('effects', 'effects'),
  app('editor', 'code'),
  app('codeSection', 'code'),
  app('terminalApp', 'terminal'),
  app('providers', 'specrailsAgents'),
  app('subagentsApp', 'specrailsAgents'),
  app('mobileCompanion', 'mobile'),
  app('registeredProjects', 'projects'),
  app('budgetAlerts', 'advanced'),
  app('notifications', 'webhooks'),
  app('webhooks', 'webhooks'),
  app('updateChannel', 'updates'),
  app('appUpdate', 'updates'),
  app('coreUpdate', 'updates'),
  app('about', 'about'),

  project('repositories', 'general'),
  project('prePrompt', 'general'),
  project('verificationCommands', 'agentRuntime'),
  project('subagentsProject', 'subagents'),
  project('integrationBranch', 'branch'),
  project('worktreeEnv', 'environment'),
  project('agentEnv', 'environment'),
  project('projectBudget', 'budget'),
  project('reviewLimit', 'budget'),
  project('telemetry', 'telemetry'),
  project('agentAudit', 'telemetry'),
  project('anchoring', 'rules'),
  project('projectRules', 'rules'),
  project('terminalProject', 'terminal'),
  project('recentlyDeleted', 'recentlyDeleted'),
]

export function isAppSettingsSection(value: string): value is AppSettingsSection {
  return (APP_SETTINGS_SECTIONS as readonly string[]).includes(value)
}
