import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadCoreAgentRuntime, resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { supportedEngines } from '../../agent-runtime/runtime/agent-runtime-engines'
import { createLoopExecutors } from './loop-executors'

/* D8 pairing: the engines signal as the real Core CLI advertises it. The
 * engine-2-only case is covered by fixture CLIs in the loader tests. */
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
beforeEach(() => { if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js')); resetCoreAgentRuntimeApiCache() })
afterEach(() => { vi.unstubAllEnvs(); resetCoreAgentRuntimeApiCache() })

it.skipIf(!core || !existsSync(path.join(core!, 'dist/agent-runtime/cli.js')))('reads both engines from the paired Core and admits legacy loops', async () => {
  const runtime = await loadCoreAgentRuntime()
  expect(runtime.api?.engines).toEqual([1, 2])
  expect(supportedEngines(runtime.api)).toEqual([1, 2])
  await expect(createLoopExecutors({ env: {} }).assertLegacyEngineSupport!()).resolves.toBeUndefined()
}, 60_000)
