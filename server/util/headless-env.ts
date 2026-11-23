/**
 * The headless contract of agent runs (Core documents it in
 * `docs/agent-runtime.md`, "Headless commands"). The person keeps using this
 * computer while a run works, so nothing an Implement run or queued job starts
 * may open a window over theirs or take focus:
 *
 * - `SPECRAILS_HEADLESS=1` tells a project's launcher and UI tests to keep
 *   their windows hidden. Core reads it to add `BROWSER=none` and its Electron
 *   guard (`NODE_OPTIONS`) to every agent and verification process.
 * - `BROWSER=none` here covers the queued jobs Desktop spawns without Core.
 *
 * `CI` is deliberately not set: it changes test runners' retries, reporters and
 * watch modes. An explicit `SPECRAILS_HEADLESS=0` in Desktop's own environment
 * (or a project passthrough) opts out and is kept. The person's terminals and
 * in-app background processes are never made headless: they run what the
 * person asked to see.
 */
export const HEADLESS_ENV_KEY = 'SPECRAILS_HEADLESS'

/** `env` with the headless marker (an explicit value wins). Never mutates `env`. */
export function withHeadlessContract(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env[HEADLESS_ENV_KEY] === undefined ? { ...env, [HEADLESS_ENV_KEY]: '1' } : env
}

/** For processes Desktop starts without Core: the marker plus no browser auto-open. */
export function headlessJobEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const marked = withHeadlessContract(env)
  return marked[HEADLESS_ENV_KEY] === '0' ? marked : { ...marked, BROWSER: 'none' }
}
