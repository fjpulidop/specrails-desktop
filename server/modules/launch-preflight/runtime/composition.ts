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
      // Only a CLI detection did not find is missing. A slow `--version` probe
      // (a loaded machine) must not read as "not installed": the status command
      // runs with its own timeout, and a spawn ENOENT still reports missing.
      if (!hasAdapter(providerId)) return null
      const provider = (await getDetectionSnapshot()).providers[providerId]
      return provider && !provider.installed ? null : getAdapter(providerId).binary
    },
    quota,
    now: () => Date.now(),
  })
}
