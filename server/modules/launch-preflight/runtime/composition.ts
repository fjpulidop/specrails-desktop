import { getDetectionSnapshot } from '../../../provider-detection'
import { runBounded } from '../../../util/bounded-exec'
import { getAdapter, hasAdapter } from '../../../providers'
import { createLaunchPreflight, statfsFreeBytes } from './preflight'

/** Production probes: provider detection for executables, bounded async exec, statfs. */
export function createDesktopLaunchPreflight(quota: (providerId: string) => { providerId: string; level: string; usedPercent: number | null; rejectedUntil: string | null } | null) {
  return createLaunchPreflight({
    exec: async (command, args, timeoutMs) => {
      const result = await runBounded(command, args, { timeoutMs, maxBuffer: 64 * 1024, shell: process.platform === 'win32' })
      const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      return { code: result.code, timedOut: result.timedOut, missing }
    },
    freeBytes: statfsFreeBytes,
    executable: async (providerId) => {
      const provider = (await getDetectionSnapshot()).providers[providerId]
      if (!provider?.installed || !provider.executable || !hasAdapter(providerId)) return null
      return getAdapter(providerId).binary
    },
    quota,
    now: () => Date.now(),
  })
}
