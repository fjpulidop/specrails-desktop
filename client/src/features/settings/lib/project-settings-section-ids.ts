/**
 * Ids of the project settings sections, in nav order. Kept apart from
 * `components/project-settings-sections.tsx` (which imports every pane) so the
 * command palette can list the sections without loading the panes. A test
 * pins the two lists together.
 */
export const PROJECT_SETTINGS_SECTION_IDS = [
  'general', 'agentRuntime', 'subagents', 'branch', 'environment',
  'budget', 'telemetry', 'rules', 'terminal', 'recentlyDeleted',
] as const
