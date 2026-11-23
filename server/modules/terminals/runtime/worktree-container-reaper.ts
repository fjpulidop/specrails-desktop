/**
 * Removes the `docker compose` containers a settled run started from its worktree.
 *
 * A container is not a process of the worktree (the Docker daemon owns it), so the
 * process reaper never sees one: a test's `docker compose up` that was never taken
 * down kept its service, and its host port, running after the run settled (the
 * redis-ttl re-run left one on 6379). Compose labels every container with the
 * directory it was started from; containers whose directory is a reaped worktree, or
 * inside one, are force-removed. Nothing else is touched, and a host without Docker
 * (or with the daemon stopped) is skipped silently.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'

export const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir'

export interface WorktreeContainer { id: string; name: string; workingDir: string }

export type DockerRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>

const defaultDocker: DockerRunner = (args) => new Promise((resolve) => {
  execFile('docker', args, { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }))
})

/** Containers (running or stopped) whose compose working directory is one of `worktreePaths` or inside one. Pure. */
export function selectWorktreeContainers(listing: string, worktreePaths: readonly string[], options: { windows?: boolean } = {}): WorktreeContainer[] {
  const normalize = (value: string): string => {
    const resolved = (options.windows ? path.win32 : path.posix).normalize(value).replace(/[\\/]+$/, '')
    return options.windows ? resolved.toLowerCase() : resolved
  }
  const roots = worktreePaths.map(normalize)
  const separator = options.windows ? '\\' : '/'
  const out: WorktreeContainer[] = []
  for (const line of listing.split(/\r?\n/)) {
    const [id, name, workingDir] = line.split('\t')
    if (!id || !workingDir || !/^[a-f0-9]{6,64}$/.test(id)) continue
    const dir = normalize(workingDir)
    if (roots.some((root) => dir === root || dir.startsWith(root + separator))) out.push({ id, name: name ?? '', workingDir })
  }
  return out
}

/** Force-remove the selected containers; returns what was removed. Never throws. */
export async function reapWorktreeContainers(worktreePaths: readonly string[], deps: { docker?: DockerRunner; windows?: boolean; log?: (line: string) => void; context?: string } = {}): Promise<WorktreeContainer[]> {
  if (!worktreePaths.length) return []
  const docker = deps.docker ?? defaultDocker
  const log = deps.log ?? ((line: string) => console.log(line))
  try {
    const listed = await docker(['ps', '-a', '--filter', `label=${COMPOSE_WORKING_DIR_LABEL}`, '--format', `{{.ID}}\t{{.Names}}\t{{.Label "${COMPOSE_WORKING_DIR_LABEL}"}}`])
    if (!listed.ok) return []
    const containers = selectWorktreeContainers(listed.stdout, worktreePaths, { windows: deps.windows })
    if (!containers.length) return []
    for (const container of containers) log(`[worktree-reaper] removing container ${container.name || container.id} started in ${container.workingDir}${deps.context ? ` (${deps.context})` : ''}`)
    const removed = await docker(['rm', '-f', ...containers.map((container) => container.id)])
    return removed.ok ? containers : []
  } catch { return [] }
}
