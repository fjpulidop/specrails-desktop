import { resolveBundledNodeExe } from './path-resolver'

/** External Core CLIs need ordinary Node. A pkg sidecar's process.execPath is
 * the server executable: using it would recursively launch another server. */
export function resolveCoreNodeRuntime(): string {
  const bundled = resolveBundledNodeExe()
  if (bundled) return bundled
  return (process as NodeJS.Process & { pkg?: unknown }).pkg ? 'node' : process.execPath
}
