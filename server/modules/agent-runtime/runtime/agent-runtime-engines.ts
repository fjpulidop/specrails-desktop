import type { RuntimeApi } from './agent-runtime-loader'

/** Engines the active Core can launch. Cores released before the `engines`
 * field still run the legacy engine, plus definitions when they advertise engine v2. */
export function supportedEngines(api: RuntimeApi | undefined): number[] {
  if (api?.engines) return [...api.engines]
  return api?.capabilities?.engineV2 === 1 ? [1, 2] : [1]
}
