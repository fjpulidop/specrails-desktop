/**
 * intent.md in the delivered OpenSpec change (intent-mode).
 *
 * Before Desktop commits a run's worktree, the spec's intent is written as
 * `intent.md` into the ONE OpenSpec change the run created — still active
 * (`openspec/changes/<name>/`) or already archived
 * (`openspec/changes/archive/<date>-<name>/`). The intent then lives in Git
 * next to the code and the derived spec. Best effort: a run with no new
 * change, a project without OpenSpec, or several candidate changes skip it
 * (the latter with a warning), and nothing here can fail the delivery.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { GitRunner } from '../../../worktree-manager'
import { renderIntentMarkdown, type SpecIntent } from '../../specs/domain/intent'

export const INTENT_FILE = 'intent.md'

export type IntentMaterialization =
  | { status: 'written' | 'unchanged'; path: string }
  | { status: 'skipped'; reason: 'no_change' | 'no_openspec' }
  | { status: 'warning'; warning: string }

const CHANGE_FILE = /^openspec\/changes\/(archive\/[^/]+|(?!archive\/)[^/]+)\/(?:proposal\.md|\.openspec\.yaml|design\.md|tasks\.md)$/

async function lines(git: GitRunner, cwd: string, args: string[]): Promise<string[]> {
  const result = await git.run(args, cwd)
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.code}`)
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** The change directories (worktree-relative) the run added since `baseRef`. */
export async function newChangeDirectories(git: GitRunner, worktreePath: string, baseRef: string): Promise<string[]> {
  const files = [
    ...await lines(git, worktreePath, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '--', 'openspec/changes']),
    ...await lines(git, worktreePath, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=A', baseRef, '--', 'openspec/changes']),
  ]
  const directories = new Set<string>()
  for (const file of files) {
    const match = CHANGE_FILE.exec(file)
    if (match) directories.add(`openspec/changes/${match[1]}`)
  }
  return [...directories].sort()
}

export async function materializeIntent(input: {
  git: GitRunner
  worktreePath: string
  baseRef: string
  intent: SpecIntent
  title?: string | null
}): Promise<IntentMaterialization> {
  try {
    if (!fs.existsSync(path.join(input.worktreePath, 'openspec'))) return { status: 'skipped', reason: 'no_openspec' }
    const directories = await newChangeDirectories(input.git, input.worktreePath, input.baseRef)
    if (directories.length === 0) return { status: 'skipped', reason: 'no_change' }
    if (directories.length > 1) return { status: 'warning', warning: `intent.md not written: the run created ${directories.length} OpenSpec changes (${directories.join(', ')})` }
    const relative = `${directories[0]}/${INTENT_FILE}`
    const target = path.join(input.worktreePath, relative)
    const body = renderIntentMarkdown(input.intent, input.title)
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === body) return { status: 'unchanged', path: relative }
    fs.writeFileSync(target, body, { encoding: 'utf8' })
    return { status: 'written', path: relative }
  } catch (error) {
    return { status: 'warning', warning: `intent.md not written: ${error instanceof Error ? error.message : String(error)}` }
  }
}
