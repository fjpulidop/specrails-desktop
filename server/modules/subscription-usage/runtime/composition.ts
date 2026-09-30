import { getDetectionSnapshot } from '../../../provider-detection'
import { createClaudeReader } from '../adapters/claude'
import { createCodexReader } from '../adapters/codex'
import { createUsageService } from './usage-service'
export function createDesktopUsageService() {
  return createUsageService({
    installed: async id => {
      const provider = (await getDetectionSnapshot()).providers[id]
      return !!provider?.installed
    },
    eligible: async id => {
      const provider = (await getDetectionSnapshot()).providers[id]
      return !!provider?.executable && provider.meetsMinimum !== false && !provider.vetoed
    },
    readers: { claude: createClaudeReader(), codex: createCodexReader() },
  })
}
