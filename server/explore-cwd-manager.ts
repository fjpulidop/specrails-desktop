import fs from 'fs'
import path from 'path'
import os from 'os'
import { getAdapter } from './providers'
import type { ProviderAdapter, ProviderId } from './providers/types'

/**
 * ExploreCwdManager owns the per-project app-managed cwd used to spawn the
 * provider CLI for Explore Spec turns. See openspec/changes/accelerate-spec-
 * chat-first-token/design.md decisions D1–D3 + D9, and openspec/changes/
 * add-multi-provider-support/specs/explore-spec/spec.md for the multi-
 * provider behaviour (instructions file is adapter-driven: CLAUDE.md for
 * claude, AGENTS.md for codex).
 *
 * Layout under `<specrails-home>/.specrails/projects/<slug>/explore-cwd/`:
 *   ├── <adapter.instructionsFilename>  — embedded mini-prompt, app-owned
 *   ├── project                          — symlink/junction → <project.path>
 *   └── project-path.txt                 — fallback when symlink creation fails
 */

/** Embedded Explore instructions template. Interpolates {{projectName}}. */
const EXPLORE_INSTRUCTIONS_TEMPLATE = `# Explore Spec assistant for "{{projectName}}"

You are running inside the **Explore Spec** experience of Specrails. The
user has opened a thinking-partner conversation to shape a single backlog
ticket. The app commits the final ticket — you never write to disk and never
invoke ticket-creation slash commands.

## Where you are

- The current working directory is an app-managed scratch directory; it does
  NOT contain the user's source code.
- The user's repo is mounted at \`./project\`. Read it ONLY when the spec
  actually requires evidence (e.g. the user names a concrete file or feature).
  Do not pre-emptively enumerate the repo or open dozens of files.
- If \`./project\` does not resolve (rare; e.g. symlink creation failed on
  Windows), a sibling file \`project-path.txt\` contains the absolute project
  path. Use that path with absolute reads in that case.

## What you must do

- Act as an interactive thinking partner for this ticket draft: investigate
  just enough, ask only the questions you need, surface trade-offs, propose a
  concrete shape.
- Maintain the structured live draft via fenced \`spec-draft\` JSON blocks at
  the end of every turn that updates draft state. The app parses these blocks
  and updates the user's draft pane; the block itself is stripped from the
  visible chat output.
- Set \`ready: true\` in the draft block only when the draft has a title, a
  description, at least one acceptance criterion, and no outstanding
  clarifying question for the user.

## What you must NOT do

- Do NOT create or modify any files in this cwd or in \`./project\`.
- Do NOT call \`/specrails:propose-spec\`, \`/specrails:implement\`, or any
  slash command that produces side effects in the project. The app owns the
  commit via \`POST /tickets/from-draft\` when the user clicks Create Spec.
- Do NOT modify, rewrite, or reference the user's own \`./project/CLAUDE.md\`
  in your output. It exists for other purposes.

## Style

- Be brief. A short observation plus a focused question beats a paragraph.
- Spec content (\`title\`, \`description\`, \`labels\`, \`acceptanceCriteria\`)
  is always written in English. Conversational prose mirrors the user's
  language.

The user's first message follows. Begin the conversation.
`

/**
 * Render the embedded template for a given project name.
 * Exported for testing.
 */
export function renderExploreInstructions(projectName: string): string {
  return EXPLORE_INSTRUCTIONS_TEMPLATE.replace(/\{\{projectName\}\}/g, projectName)
}

/** @deprecated Use `renderExploreInstructions` — kept as a thin wrapper so
 *  any external callsite continues to compile. */
export function renderExploreClaudeMd(projectName: string): string {
  return renderExploreInstructions(projectName)
}

export interface ExploreCwdInput {
  /** Project slug — used as the directory name under ~/.specrails/projects/. */
  slug: string
  /** Absolute path to the user's project. Symlink target. */
  projectPath: string
  /** Project display name interpolated into the embedded instructions file. */
  projectName: string
  /** Provider id from the project row. Defaults to claude for backwards
   *  compatibility with callers that haven't been threaded the project yet. */
  provider?: ProviderId
}

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

/**
 * Compute the explore-cwd path for a project without touching the filesystem.
 * Used by the legacy-cwd env-var short-circuit and by tests.
 */
export function exploreCwdPathFor(slug: string, baseDir?: string): string {
  const base = baseDir ?? path.join(homeDir(), '.specrails', 'projects')
  return path.join(base, slug, 'explore-cwd')
}

/**
 * Create or refresh the explore-cwd for a project. Idempotent and cheap when
 * already up-to-date. Returns the absolute path to the cwd.
 *
 * When SPECRAILS_EXPLORE_LEGACY_CWD=1 is set, returns `projectPath` directly
 * and performs no filesystem IO — used as the rollback escape hatch.
 *
 * Pass `baseDir` for tests that need a specific projects directory.
 */
export function ensureExploreCwd(input: ExploreCwdInput, baseDir?: string): string {
  if (process.env.SPECRAILS_EXPLORE_LEGACY_CWD === '1') {
    return input.projectPath
  }

  const cwd = exploreCwdPathFor(input.slug, baseDir)
  fs.mkdirSync(cwd, { recursive: true })

  const adapter: ProviderAdapter = getAdapter(input.provider ?? 'claude')
  const instructionsPath = path.join(cwd, adapter.instructionsFilename)
  const desiredInstructions = renderExploreInstructions(input.projectName)
  let currentInstructions: string | null = null
  try {
    currentInstructions = fs.readFileSync(instructionsPath, 'utf-8')
  } catch {
    /* file may not exist yet */
  }
  if (currentInstructions !== desiredInstructions) {
    fs.writeFileSync(instructionsPath, desiredInstructions, 'utf-8')
  }

  // If the project switched providers since the last materialise (defensive
  // — provider is immutable post-creation but the lifecycle code MUST handle
  // the edge per spec), remove any stale instructions file authored by a
  // different provider so the explore-cwd doesn't carry both.
  const STALE_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']
  for (const stale of STALE_INSTRUCTION_FILES) {
    if (stale === adapter.instructionsFilename) continue
    const stalePath = path.join(cwd, stale)
    if (fs.existsSync(stalePath)) {
      try { fs.unlinkSync(stalePath) } catch { /* best-effort */ }
    }
  }

  ensureProjectLink(cwd, input.projectPath)

  return cwd
}

/**
 * Recursively remove the explore-cwd directory for a project. The `project`
 * symlink/junction is unlinked explicitly (never followed) so the user's
 * repo is never touched.
 */
export function removeExploreCwd(slug: string, baseDir?: string): void {
  const cwd = exploreCwdPathFor(slug, baseDir)
  if (!fs.existsSync(cwd)) return

  const linkPath = path.join(cwd, 'project')
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink() || (process.platform === 'win32' && st.isDirectory())) {
      // unlink works on POSIX symlinks; rmdir on Windows junctions
      try { fs.unlinkSync(linkPath) } catch {
        try { fs.rmdirSync(linkPath) } catch { /* best-effort */ }
      }
    }
  } catch {
    /* link may not exist */
  }

  fs.rmSync(cwd, { recursive: true, force: true })
}

/**
 * Ensure `<cwd>/project` resolves to `<projectPath>` (symlink on POSIX,
 * junction on Windows). Recreated when the existing target differs. On both
 * symlink and junction failure, writes a `project-path.txt` fallback that
 * the embedded CLAUDE.md tells the model to read.
 */
function ensureProjectLink(cwd: string, projectPath: string): void {
  const linkPath = path.join(cwd, 'project')
  const fallbackPath = path.join(cwd, 'project-path.txt')

  let needsCreate = true
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath)
      if (path.resolve(cwd, current) === path.resolve(projectPath)) {
        needsCreate = false
      } else {
        fs.unlinkSync(linkPath)
      }
    } else {
      // existing non-symlink (e.g. Windows junction or stale dir) — replace
      try { fs.unlinkSync(linkPath) } catch {
        try { fs.rmdirSync(linkPath) } catch { /* best-effort */ }
      }
    }
  } catch {
    /* link does not exist — fall through to create */
  }

  if (needsCreate) {
    let created = false
    if (process.platform === 'win32') {
      try {
        fs.symlinkSync(projectPath, linkPath, 'junction')
        created = true
      } catch { /* fall through to plain symlink */ }
    }
    if (!created) {
      try {
        fs.symlinkSync(projectPath, linkPath)
        created = true
      } catch { /* fall through to text fallback */ }
    }
    if (!created) {
      // Final fallback: write the absolute path so the model can use it.
      fs.writeFileSync(fallbackPath, projectPath, 'utf-8')
      return
    }
  }

  // If we successfully created/verified the symlink, clean up any stale
  // fallback file from a prior failed attempt.
  if (fs.existsSync(fallbackPath)) {
    try { fs.unlinkSync(fallbackPath) } catch { /* ignore */ }
  }
}
