import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  ensureExploreCwd,
  removeExploreCwd,
  exploreCwdPathFor,
  renderExploreClaudeMd,
} from './explore-cwd-manager'

describe('explore-cwd-manager', () => {
  let baseDir: string
  let projectRoot: string
  let originalEnv: string | undefined

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-cwd-base-'))
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-cwd-project-'))
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# user project CLAUDE.md (must not be touched)\n')
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'src', 'foo.ts'), 'export const foo = 1\n')
    originalEnv = process.env.SPECRAILS_EXPLORE_LEGACY_CWD
    delete process.env.SPECRAILS_EXPLORE_LEGACY_CWD
  })

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SPECRAILS_EXPLORE_LEGACY_CWD = originalEnv
    else delete process.env.SPECRAILS_EXPLORE_LEGACY_CWD
    fs.rmSync(baseDir, { recursive: true, force: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('exploreCwdPathFor composes the expected path', () => {
    const p = exploreCwdPathFor('myslug', '/tmp/foo')
    expect(p).toBe('/tmp/foo/myslug/explore-cwd')
  })

  it('exploreCwdPathFor uses SPECRAILS_REGISTRY_HOME when no baseDir is passed', () => {
    const previous = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = baseDir
    try {
      expect(exploreCwdPathFor('myslug')).toBe(path.join(baseDir, '.specrails', 'projects', 'myslug', 'explore-cwd'))
    } finally {
      if (previous !== undefined) process.env.SPECRAILS_REGISTRY_HOME = previous
      else delete process.env.SPECRAILS_REGISTRY_HOME
    }
  })

  it('renderExploreClaudeMd interpolates the project name', () => {
    const out = renderExploreClaudeMd('Acme')
    expect(out).toContain('"Acme"')
    expect(out).not.toContain('{{projectName}}')
  })

  it('first call creates dir, CLAUDE.md, and project symlink', () => {
    const cwd = ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'Project 1' },
      baseDir,
    )
    expect(cwd).toBe(path.join(baseDir, 'proj1', 'explore-cwd'))
    expect(fs.existsSync(cwd)).toBe(true)
    const claudeMd = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('"Project 1"')
    const linkPath = path.join(cwd, 'project')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    // tools should be able to read the user's repo via the symlink
    expect(fs.readFileSync(path.join(linkPath, 'src', 'foo.ts'), 'utf-8')).toContain('foo = 1')
  })

  it('codex project: instructions file is AGENTS.md (not CLAUDE.md)', () => {
    const cwd = ensureExploreCwd(
      { slug: 'codex-proj', projectPath: projectRoot, projectName: 'Codex Project', provider: 'codex' },
      baseDir,
    )
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, 'CLAUDE.md'))).toBe(false)
    const agentsMd = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('"Codex Project"')
  })

  it('kimi project: instructions file is nested under .kimi-code (not the Codex root file)', () => {
    const cwd = ensureExploreCwd(
      { slug: 'kimi-proj', projectPath: projectRoot, projectName: 'Kimi Project', provider: 'kimi' },
      baseDir,
    )
    const kimiAgentsPath = path.join(cwd, '.kimi-code', 'AGENTS.md')
    expect(fs.existsSync(kimiAgentsPath)).toBe(true)
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(false)
    expect(fs.readFileSync(kimiAgentsPath, 'utf-8')).toContain('"Kimi Project"')
  })

  it('clears stale instructions file when provider switches (defensive)', () => {
    // Pretend a previous claude run created CLAUDE.md; now the project's
    // provider is reported as codex. The next materialise should drop the
    // stale CLAUDE.md and write AGENTS.md only.
    const cwd = exploreCwdPathFor('switcher', baseDir)
    fs.mkdirSync(cwd, { recursive: true })
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'stale claude content', 'utf-8')

    ensureExploreCwd(
      { slug: 'switcher', projectPath: projectRoot, projectName: 'Switcher', provider: 'codex' },
      baseDir,
    )

    expect(fs.existsSync(path.join(cwd, 'CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true)
  })

  it('clears a stale nested Kimi instructions file when provider switches', () => {
    const cwd = exploreCwdPathFor('kimi-switcher', baseDir)
    fs.mkdirSync(path.join(cwd, '.kimi-code'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, '.kimi-code', 'AGENTS.md'),
      'stale Kimi content',
      'utf-8',
    )

    ensureExploreCwd(
      { slug: 'kimi-switcher', projectPath: projectRoot, projectName: 'Switcher', provider: 'codex' },
      baseDir,
    )

    expect(fs.existsSync(path.join(cwd, '.kimi-code', 'AGENTS.md'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.kimi-code'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true)
  })

  it('second call is idempotent and does not rewrite the unchanged CLAUDE.md', () => {
    const cwd = ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'Project 1' },
      baseDir,
    )
    const claudeMdPath = path.join(cwd, 'CLAUDE.md')
    const mtime1 = fs.statSync(claudeMdPath).mtimeMs
    // tweak mtime so we can detect a rewrite (or not)
    fs.utimesSync(claudeMdPath, new Date(mtime1 - 5000), new Date(mtime1 - 5000))
    const before = fs.statSync(claudeMdPath).mtimeMs

    ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'Project 1' },
      baseDir,
    )
    const after = fs.statSync(claudeMdPath).mtimeMs
    expect(after).toBe(before) // unchanged because content matched
  })

  it('rewrites CLAUDE.md when the embedded template content differs', () => {
    const cwd = ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'Old Name' },
      baseDir,
    )
    ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'New Name' },
      baseDir,
    )
    const md = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf-8')
    expect(md).toContain('"New Name"')
    expect(md).not.toContain('"Old Name"')
  })

  it('recreates the symlink when the project path changes', () => {
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-cwd-other-'))
    try {
      ensureExploreCwd(
        { slug: 'proj1', projectPath: projectRoot, projectName: 'P' },
        baseDir,
      )
      ensureExploreCwd(
        { slug: 'proj1', projectPath: otherProject, projectName: 'P' },
        baseDir,
      )
      const linkPath = path.join(baseDir, 'proj1', 'explore-cwd', 'project')
      const target = fs.readlinkSync(linkPath)
      expect(path.resolve(path.dirname(linkPath), target)).toBe(path.resolve(otherProject))
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true })
    }
  })

  it('SPECRAILS_EXPLORE_LEGACY_CWD short-circuits to the project path with no IO', () => {
    process.env.SPECRAILS_EXPLORE_LEGACY_CWD = '1'
    const cwd = ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'P' },
      baseDir,
    )
    expect(cwd).toBe(projectRoot)
    expect(fs.existsSync(path.join(baseDir, 'proj1'))).toBe(false)
  })

  it('removeExploreCwd deletes the dir and unlinks the project symlink without following', () => {
    ensureExploreCwd(
      { slug: 'proj1', projectPath: projectRoot, projectName: 'P' },
      baseDir,
    )
    // Sanity: the user's repo file must exist before AND after removeExploreCwd
    const userClaudeMd = path.join(projectRoot, 'CLAUDE.md')
    expect(fs.existsSync(userClaudeMd)).toBe(true)

    removeExploreCwd('proj1', baseDir)
    expect(fs.existsSync(path.join(baseDir, 'proj1', 'explore-cwd'))).toBe(false)
    // The user's project must remain entirely intact
    expect(fs.existsSync(userClaudeMd)).toBe(true)
    expect(fs.existsSync(path.join(projectRoot, 'src', 'foo.ts'))).toBe(true)
  })

  it('removeExploreCwd is a no-op when the dir does not exist', () => {
    expect(() => removeExploreCwd('never-existed', baseDir)).not.toThrow()
  })

  it('snapshot: rendered template is stable for a fixed project name', () => {
    expect(renderExploreClaudeMd('SnapshotProject')).toMatchInlineSnapshot(`
      "# Explore Spec assistant for "SnapshotProject"

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
      "
    `)
  })
})
