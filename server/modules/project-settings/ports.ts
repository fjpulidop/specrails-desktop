import type { ProjectSettings, ProjectSettingsPatch } from './domain'

/** Outbound persistence contract owned by the application, not by SQLite. */
export interface ProjectSettingsRepository {
  read(): ProjectSettings
  /** Apply the complete patch atomically and return the persisted settings.
   * A failure must leave the previous settings intact. */
  update(patch: ProjectSettingsPatch): ProjectSettings
}
