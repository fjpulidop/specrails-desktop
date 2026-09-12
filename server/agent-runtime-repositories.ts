import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface RuntimeLogRepository { id: string; name?: string; path?: string }
/** Attribute only explicit paths or repository roots present in a tool action.
 * Never carry a previous action's repository into an unrelated tool call. */
export function toolRepositories(event: { targetPaths?: unknown; cwd?: unknown; detail?: unknown }, repositories: RuntimeLogRepository[], defaultCwd: string): RuntimeLogRepository[] {
  const found = new Set<string>()
  const cwd = typeof event.cwd === 'string' && isAbsolute(event.cwd) ? event.cwd : defaultCwd
  const paths = Array.isArray(event.targetPaths) ? event.targetPaths.filter((p): p is string => typeof p === 'string') : []
  if (!paths.length && typeof event.detail === 'string' && isAbsolute(event.detail) && !event.detail.endsWith('…')) paths.push(event.detail)
  for (const target of paths) {
    const absolute = resolve(cwd, target)
    const matches = repositories.filter(repo => {
      if (!repo.path) return false
      const suffix = relative(repo.path, absolute)
      return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
    }).sort((a, b) => b.path!.length - a.path!.length)
    if (matches[0]) found.add(matches[0].id)
  }
  // Shell activity may contain `cd /repo && ...` or address several repositories.
  if (!paths.length && typeof event.detail === 'string') {
    for (const repo of repositories) {
      if (!repo.path) continue
      const escaped = repo.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp('(?:^|[\\s\\x22\\x27=])' + escaped + '(?=$|[\\s/\\\\\\x22\\x27;&])').test(event.detail)) found.add(repo.id)
    }
  }
  if (!found.size && !paths.length && typeof event.cwd === 'string' && isAbsolute(event.cwd)) return toolRepositories({ targetPaths: [event.cwd] }, repositories, defaultCwd)
  return repositories.filter(repo => found.has(repo.id))
}
