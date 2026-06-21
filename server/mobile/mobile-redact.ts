import os from 'os'

// Information-minimisation for everything the gateway hands a phone. Three rules:
//   1. Drop same-machine keys outright (filesystem paths, db handles).
//   2. Replace the user's home directory inside any remaining string with `~`
//      so a `command` like `/specrails:implement #34` keeps its useful shape but
//      an embedded absolute path (or a stray cwd) leaks no local layout.
//   3. Scrub ANY remaining absolute-path token (POSIX `/…`, Windows `X:\…`) to a
//      placeholder, so a path NOT under $HOME (`/Volumes/Work`, `/tmp/x`, a second
//      drive letter) or one carried by an un-keyed field (job command, error
//      message, ticket text) can't leak the local filesystem layout either. The
//      key allow-list (rule 1) stays as defence-in-depth.
//
// Applied to EVERY proxied REST JSON body and EVERY outbound WS payload.

const SENSITIVE_KEYS = new Set(['path', 'db_path', 'dbPath', 'absolutePath', 'cwd', 'filePath', 'projectPath'])

const ABS_PATH_PLACEHOLDER = '[path]'

// Absolute-path tokens to scrub AFTER the $HOME→`~` rewrite. A token is a run of
// non-whitespace characters; we match those that look like an absolute path:
//   - Windows drive path: `C:\Users\x` / `C:/Users/x` (drive letter + sep)
//   - UNC path: `\\server\share`
//   - POSIX absolute path with at least TWO segments: `/Volumes/Work`, `/tmp/x`
//     (i.e. a leading `/`, a segment, ANOTHER `/`, then more). Requiring a second
//     separator deliberately preserves single-segment slash-commands like
//     `/specrails:implement #34` (the gateway forwards these verbatim) and a bare
//     `/`, while still scrubbing every real multi-segment filesystem path. `~`
//     paths are already collapsed by stripHome and never reach here.
// The leading boundary keeps embedded `://` URLs and mid-word slashes intact.
const ABS_PATH_RE =
  /(^|[\s"'`(=:,])([A-Za-z]:[\\/][^\s"'`)]*|\\\\[^\s"'`)]+|\/[^\s"'`)/]+\/[^\s"'`)]*)/g

function homeDir(): string {
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/** Replace occurrences of the user's home dir with `~` (covers the common leak:
 *  project paths live under ~/...). Cheap and safe — never mangles normal text. */
export function stripHome(s: string): string {
  const home = homeDir()
  if (!home) return s
  return s.split(home).join('~')
}

/** Replace absolute-path tokens (POSIX `/…`, Windows `X:\…`, UNC `\\…`) with a
 *  placeholder. Runs AFTER stripHome so `~`-rooted paths are already collapsed and
 *  are not touched here. URLs (`http://…`) and bare `/` are preserved. */
export function scrubAbsolutePaths(s: string): string {
  // Keep the matched leading delimiter, replace the path token with the
  // placeholder. URLs (`://`) are excluded by the path-branch char classes.
  return s.replace(ABS_PATH_RE, (_m, lead: string) => `${lead}${ABS_PATH_PLACEHOLDER}`)
}

function scrubString(s: string): string {
  return scrubAbsolutePaths(stripHome(s))
}

/** Deep-redact a JSON-serialisable value: drop sensitive keys, scrub home dir in
 *  strings. Returns a new structure; never mutates the input. */
export function redact<T>(value: T): T {
  return _redact(value) as T
}

function _redact(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(_redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue
      out[k] = _redact(v)
    }
    return out
  }
  return value
}
