import fs from 'fs'
import path from 'path'
import { execBounded } from './util/bounded-exec'
import type { PhaseDefinition } from './types'

// Windows has no `which`; it's `where`. The lone holdout that hardcoded `which`
// here made gh/jira tracker detection always report unavailable on Windows.
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

export interface CommandInfo {
  id: string
  name: string
  description: string
  slug: string
  phases: PhaseDefinition[]
}

export interface IssueTrackerInfo {
  available: boolean
  authenticated: boolean
  repo?: string
}

export interface ProjectConfig {
  project: {
    name: string
    repo: string | null
  }
  issueTracker: {
    github: IssueTrackerInfo
    jira: IssueTrackerInfo
    active: 'github' | 'jira' | null
    labelFilter: string
  }
  commands: CommandInfo[]
}

// All probes here are async + bounded (util/bounded-exec): `gh auth status`
// is a network round-trip and `gh issue list` can take seconds; as execSync
// they froze every project's HTTP/WS traffic for their whole duration.
const COMMAND_TIMEOUT_MS = 5000
/** `gh issue list` / `jira issue list` hit the network; allow a little longer. */
const ISSUE_FETCH_TIMEOUT_MS = 15_000

async function runCommand(cmd: string, cwd?: string): Promise<string | null> {
  try {
    return (await execBounded(cmd, [], { shell: true, timeoutMs: COMMAND_TIMEOUT_MS, cwd })).trim()
  } catch {
    return null
  }
}

/**
 * Run a command with an explicit argv array via `execFileSync` — NO shell (H-12).
 *
 * `runCommand` routes through `/bin/sh -c`, so any shell metacharacter in an
 * interpolated value is a command-injection sink. `fetchIssues` builds its
 * arguments from HTTP query params (`search`/`label`) and the git remote, so it
 * MUST use this argv form: each argument is passed literally to the program and
 * the shell never sees it (execBounded without `shell`). `runCommand` is retained only for fixed, constant
 * detection commands (`which gh`, `gh auth status`, `git remote get-url origin`)
 * that carry no user input.
 */
async function runCommandArgs(file: string, args: string[], cwd?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string | null> {
  try {
    return (await execBounded(file, args, { timeoutMs, cwd })).trim()
  } catch {
    return null
  }
}

async function detectGithub(): Promise<IssueTrackerInfo> {
  const ghPath = await runCommand(`${WHICH_CMD} gh`)
  if (!ghPath) return { available: false, authenticated: false }

  const authOutput = await runCommand('gh auth status')
  const authenticated = authOutput !== null

  return { available: true, authenticated }
}

async function detectJira(): Promise<IssueTrackerInfo> {
  const jiraPath = await runCommand(`${WHICH_CMD} jira`)
  if (!jiraPath) return { available: false, authenticated: false }

  // jira CLI availability means it is configured (auth is implicit via jira config)
  return { available: true, authenticated: true }
}

// H19: `which gh` + `gh auth status` (a network round-trip, 0.3-2s) + `which
// jira` are project-independent but ran synchronously on every getConfig()
// call — once per project in the startup loadAll() and again on each
// GET /config | GET /issues — blocking the single event loop app-wide.
// Memoize with a short TTL (same pattern as setup-prerequisites.ts) so startup
// probes once and hot request paths reuse the cached result; auth/install
// changes surface after at most TTL.
// The probes are now async; concurrent callers share one in-flight probe.
let _trackerCache: { at: number; value: Promise<{ github: IssueTrackerInfo; jira: IssueTrackerInfo }> } | null = null
const TRACKER_CACHE_TTL_MS = 60_000

function detectTrackers(): Promise<{ github: IssueTrackerInfo; jira: IssueTrackerInfo }> {
  const now = Date.now()
  if (_trackerCache && now - _trackerCache.at < TRACKER_CACHE_TTL_MS) {
    return _trackerCache.value
  }
  const value = Promise.all([detectGithub(), detectJira()]).then(([github, jira]) => ({ github, jira }))
  _trackerCache = { at: now, value }
  return value
}

/** Test-only: clear the tracker-detection memo so each test re-probes. */
export function __resetTrackerDetectionCacheForTest(): void {
  _trackerCache = null
}

async function getGitRepoName(projectRoot?: string): Promise<string | null> {
  const output = await runCommand('git remote get-url origin', projectRoot)
  if (!output) return null

  // Parse both HTTPS and SSH remote URLs
  // https://github.com/owner/repo.git → owner/repo
  // git@github.com:owner/repo.git → owner/repo
  const httpsMatch = output.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[1]

  const sshMatch = output.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]

  return null
}

interface ParsedFrontmatter {
  scalars: Record<string, string>
  phases: PhaseDefinition[]
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = { scalars: {}, phases: [] }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return result

  const lines = match[1].split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) { i++; continue }

    const key = line.slice(0, colonIdx).trim()
    const rawValue = line.slice(colonIdx + 1).trim()

    if (!key) { i++; continue }

    // Array field: value is empty, subsequent lines start with "  - "
    if (rawValue === '' && i + 1 < lines.length && lines[i + 1].startsWith('  - ')) {
      i++
      if (key === 'phases') {
        const items: PhaseDefinition[] = []
        let current: Partial<PhaseDefinition> | null = null

        while (i < lines.length) {
          const aLine = lines[i]
          if (aLine.startsWith('  - ')) {
            // New array item — flush current
            if (current) items.push(current as PhaseDefinition)
            current = {}
            // Parse the inline key: value after "  - "
            const rest = aLine.slice(4)
            const aColon = rest.indexOf(':')
            if (aColon !== -1) {
              const aKey = rest.slice(0, aColon).trim()
              const aVal = rest.slice(aColon + 1).trim().replace(/^["']|["']$/g, '')
              ;(current as Record<string, string>)[aKey] = aVal
            }
            i++
          } else if (aLine.startsWith('    ') && !aLine.startsWith('    - ')) {
            // Continuation key: value for current item
            if (current) {
              const aColon = aLine.indexOf(':')
              if (aColon !== -1) {
                const aKey = aLine.slice(0, aColon).trim()
                const aVal = aLine.slice(aColon + 1).trim().replace(/^["']|["']$/g, '')
                ;(current as Record<string, string>)[aKey] = aVal
              }
            }
            i++
          } else {
            break
          }
        }

        if (current) items.push(current as PhaseDefinition)

        result.phases = items.filter(
          (item): item is PhaseDefinition =>
            typeof item.key === 'string' &&
            typeof item.label === 'string' &&
            typeof item.description === 'string'
        )
      } else {
        // Skip unknown array fields
        while (i < lines.length && (lines[i].startsWith('  - ') || lines[i].startsWith('    '))) {
          i++
        }
      }
    } else {
      result.scalars[key] = rawValue.replace(/^["']|["']$/g, '')
      i++
    }
  }

  return result
}

function scanCommands(commandsDir: string): CommandInfo[] {
  if (!fs.existsSync(commandsDir)) return []

  let files: string[]
  try {
    files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }

  return files.map((file) => {
    const slug = file.replace(/\.md$/, '')
    let name = slug
    let description = ''
    let phases: PhaseDefinition[] = []

    try {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.scalars.name) name = fm.scalars.name
      if (fm.scalars.description) description = fm.scalars.description
      phases = fm.phases
    } catch {
      // Use filename-derived name if frontmatter parsing fails
    }

    return {
      id: slug,
      name,
      description,
      slug,
      phases,
    }
  })
}

function loadPersistedConfig(db: any): { active: string | null; labelFilter: string } {
  try {
    const activeRow = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.active_tracker'`).get() as { value: string } | undefined
    const labelRow = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.label_filter'`).get() as { value: string } | undefined
    return {
      active: (activeRow?.value as 'github' | 'jira' | null) ?? null,
      labelFilter: labelRow?.value ?? '',
    }
  } catch {
    return { active: null, labelFilter: '' }
  }
}

function resolveProjectRoot(cwd: string): string {
  // Super mode passes project.path directly, which has a `.claude` directory at
  // its root; the walk-up fallback covers callers that pass a manager-relative cwd.
  return fs.existsSync(path.join(cwd, '.claude')) ? cwd : path.resolve(cwd, '../..')
}

/**
 * The project's sr/specrails commands only — filesystem reads, no subprocess.
 * Project load needs just this; it used to call getConfig(), paying the
 * tracker (`gh auth status`) and `git remote` probes per project at startup.
 */
export function getProjectCommands(cwd: string, commandsRoot?: string): CommandInfo[] {
  return scanCommands(path.join(commandsRoot ?? resolveProjectRoot(cwd), '.claude', 'commands', 'sr'))
}

export async function getConfig(
  cwd: string,
  db?: any,
  projectName?: string,
  /** Relocate-artifacts: the dir whose `.claude/commands/sr` holds the
   *  materialized sr/specrails commands — the workspace when the project is
   *  relocated, else === the project root. Git/repo detection ALWAYS uses the
   *  repo root (`projectRoot`). Defaults to `projectRoot` (byte-identical). */
  commandsRoot?: string,
): Promise<ProjectConfig> {
  const projectRoot = resolveProjectRoot(cwd)
  const commands = getProjectCommands(cwd, commandsRoot)

  const [{ github, jira }, repo] = await Promise.all([detectTrackers(), getGitRepoName(projectRoot)])

  const persisted = db ? loadPersistedConfig(db) : { active: null, labelFilter: '' }

  // Auto-detect active tracker if not persisted
  let active = persisted.active as 'github' | 'jira' | null
  if (!active) {
    if (github.authenticated) active = 'github'
    else if (jira.authenticated) active = 'jira'
  }

  return {
    project: {
      name: projectName ?? path.basename(projectRoot),
      repo: repo,
    },
    issueTracker: {
      github,
      jira,
      active,
      labelFilter: persisted.labelFilter,
    },
    commands,
  }
}

export interface IssueItem {
  number: number
  title: string
  labels: string[]
  body: string
  url?: string
}

export async function fetchIssues(
  tracker: 'github' | 'jira',
  opts: { search?: string; label?: string; repo?: string | null; cwd?: string }
): Promise<IssueItem[]> {
  if (tracker === 'github') {
    const args = ['issue', 'list', '--json', 'number,title,labels,body,url', '--limit', '50']
    if (opts.repo) args.push('--repo', opts.repo)
    if (opts.label) args.push('--label', opts.label)
    if (opts.search) args.push('--search', opts.search)

    const output = await runCommandArgs('gh', args, opts.cwd, ISSUE_FETCH_TIMEOUT_MS)
    if (!output) return []

    try {
      const raw = JSON.parse(output) as Array<{
        number: number
        title: string
        labels: Array<{ name: string }>
        body: string
        url: string
      }>
      return raw.map((item) => ({
        number: item.number,
        title: item.title,
        labels: item.labels.map((l) => l.name),
        body: item.body ?? '',
        url: item.url,
      }))
    } catch {
      return []
    }
  }

  if (tracker === 'jira') {
    const jql = opts.search ? `summary ~ "${opts.search}"` : ''
    const args = ['issue', 'list', '--plain', '--columns', 'KEY,SUMMARY,LABELS,STATUS']
    if (jql) args.push('--jql', jql)

    const output = await runCommandArgs('jira', args, undefined, ISSUE_FETCH_TIMEOUT_MS)
    if (!output) return []

    // Parse plain text output: KEY  SUMMARY  LABELS  STATUS
    const lines = output.split('\n').filter(Boolean)
    return lines.slice(1).map((line, idx) => {
      const parts = line.split('\t')
      return {
        number: idx + 1,
        title: parts[1]?.trim() ?? line,
        labels: parts[2] ? parts[2].split(',').map((l) => l.trim()) : [],
        body: '',
      }
    })
  }

  return []
}
