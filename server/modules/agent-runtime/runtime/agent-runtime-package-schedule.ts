import { collectSharedRuntimePackages, removeCollectedPackages } from './agent-runtime-package-gc'
import { configureSharedRuntimePackageCache, sharedRuntimePackageCache } from './agent-runtime-package'

export { configureSharedRuntimePackageCache }

/** The current Core build plus the two before it stay, whatever references them. */
export const SHARED_PACKAGE_KEEP_RECENT = 3
/** A package used within the last hour is never collected (a launch may be about to pin it). */
export const SHARED_PACKAGE_MIN_AGE_MS = 60 * 60_000
const FIRST_COLLECTION_MS = 5 * 60_000
const COLLECTION_INTERVAL_MS = 6 * 60 * 60_000

/** One bounded collection of the shared cache; never throws (a failed pass is retried next time). */
export async function collectSharedRuntimePackagesNow(input: { projectsRoot: string; pipelineRoots: () => string[]; now?: () => number; log?: (line: string) => void }): Promise<string[]> {
  const cache = sharedRuntimePackageCache()
  if (!cache) return []
  const log = input.log ?? ((line: string) => console.log(line))
  try {
    const result = collectSharedRuntimePackages({ cache, projectsRoot: input.projectsRoot, pipelineRoots: input.pipelineRoots(), keepRecent: SHARED_PACKAGE_KEEP_RECENT, minimumAgeMs: SHARED_PACKAGE_MIN_AGE_MS, now: (input.now ?? Date.now)() })
    await removeCollectedPackages(result.garbage)
    if (result.collected.length) log(`[runtime-packages] collected ${result.collected.length} unused Core build(s); kept ${result.referenced.length} still pinned by runs`)
    return result.collected
  } catch (error) {
    log(`[runtime-packages] collection skipped: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** First pass a few minutes after boot (off the startup path), then every six hours. */
export function scheduleSharedRuntimePackageCollection(input: { projectsRoot: string; pipelineRoots: () => string[] }): void {
  const run = (): void => { void collectSharedRuntimePackagesNow(input) }
  const first = setTimeout(run, FIRST_COLLECTION_MS)
  first.unref?.()
  const every = setInterval(run, COLLECTION_INTERVAL_MS)
  every.unref?.()
}
