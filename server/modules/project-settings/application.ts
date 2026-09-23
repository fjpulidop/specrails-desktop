import { parseProjectSettingsPatch } from './domain'
import type { ProjectSettingsRepository } from './ports'

/** Application use cases. No HTTP request, SQL connection or global registry. */
export function createProjectSettingsService(repository: ProjectSettingsRepository) {
  return {
    getSettings: () => repository.read(),
    updateSettings: (input: unknown) => repository.update(parseProjectSettingsPatch(input)),
  }
}

export type ProjectSettingsService = ReturnType<typeof createProjectSettingsService>
