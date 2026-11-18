/**
 * Merge preview without a checkout: would `head` merge cleanly into `base`?
 *
 * `git merge-tree --write-tree` (Git ≥ 2.38) performs the real three-way merge
 * in memory and only WRITES the resulting tree objects. Those writes go to a
 * disposable object store (`GIT_OBJECT_DIRECTORY` = a temp dir, the repository's
 * own objects as an alternate), so previews never add loose objects to the
 * person's repository, and the temp dir is deleted afterwards. No index, no
 * working tree, no ref and no lock of the repository is touched.
 *
 * Results are cached by (repository, base sha, head sha) — a merge of two
 * immutable commits never changes — and computed by child processes under a
 * small global concurrency bound, so the event loop only parses short output.
 * Older Git reports `supported: false` instead of guessing.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { gitExecEnv } from '../../code/runtime/file-provenance'
import { gitInvocationEnv } from '../../../util/git-invocation'
import { repositoryLockKey } from '../../../repo-lock'

export interface GitOutcome { code: number; stdout: string; stderr: string }

/** Injectable executor: args, cwd and extra env (the scratch object store). */
export type MergePreviewExec = (args: string[], cwd: string, extraEnv?: NodeJS.ProcessEnv) => Promise<GitOutcome>

const TIMEOUT_MS = 30_000
const MAX_CONCURRENT = 3
const CACHE_LIMIT = 1000
/** Conflicted paths kept per pair (the rest are counted). */
export const MAX_CONFLICT_FILES = 50

export const defaultMergePreviewExec: MergePreviewExec = (args, cwd, extraEnv) => new Promise((resolve) => {
  const env = { ...gitInvocationEnv(gitExecEnv(), args), ...extraEnv }
  execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0
    resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
  })
})

// ─── bounded concurrency ──────────────────────────────────────────────────────
let running = 0
const waiting: Array<() => void> = []
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

// ─── capability ───────────────────────────────────────────────────────────────
let writeTreeSupport: Promise<boolean> | null = null

/** Git ≥ 2.38 has `merge-tree --write-tree`. Probed once per process. */
export function mergeTreeSupported(exec: MergePreviewExec = defaultMergePreviewExec): Promise<boolean> {
  if (exec !== defaultMergePreviewExec) return probe(exec)
  writeTreeSupport ??= probe(exec)
  return writeTreeSupport
}

async function probe(exec: MergePreviewExec): Promise<boolean> {
  const version = await exec(['--version'], os.tmpdir()).catch(() => null)
  const match = version?.stdout.match(/git version (\d+)\.(\d+)/)
  if (!match) return false
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 2 || (major === 2 && minor >= 38)
}

// ─── pair merge ───────────────────────────────────────────────────────────────
export interface PairMerge {
  /** clean: merges without conflicts; conflicts: listed paths conflict;
   *  already_merged: the merge result IS `base` (the change already landed,
   *  squash or rebase merges included); unknown: Git could not tell. */
  status: 'clean' | 'conflicts' | 'already_merged' | 'unknown'
  files: string[]
  /** Conflicted path count (files is capped at MAX_CONFLICT_FILES). */
  fileCount: number
  error?: string
}

const pairCache = new Map<string, Promise<PairMerge>>()

function remember(key: string, value: Promise<PairMerge>): Promise<PairMerge> {
  pairCache.set(key, value)
  if (pairCache.size > CACHE_LIMIT) pairCache.delete(pairCache.keys().next().value as string)
  // Failures are not cached: a later refresh retries them.
  void value.then((result) => { if (result.status === 'unknown') pairCache.delete(key) })
  return value
}

/** Test-only. */
export function __resetMergePreviewCache(): void {
  pairCache.clear()
  writeTreeSupport = null
}

async function scratchObjectStore(repoDir: string, exec: MergePreviewExec): Promise<{ env: NodeJS.ProcessEnv; dispose(): Promise<void> } | null> {
  const common = await exec(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoDir)
  const commonDir = common.code === 0 ? common.stdout.trim() : ''
  if (!commonDir) return null
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'specrails-merge-preview-'))
  const objects = path.join(dir, 'objects')
  await fs.promises.mkdir(objects)
  return {
    env: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(commonDir, 'objects') },
    dispose: () => fs.promises.rm(dir, { recursive: true, force: true }),
  }
}

function parseNames(stdout: string): string[] {
  // `<tree>\0<path>\0<path>\0` (--name-only -z --no-messages)
  const parts = stdout.split('\0').filter(Boolean)
  return [...new Set(parts.slice(1))]
}

/**
 * Would merging `head` into `base` conflict? Both are commit shas (immutable),
 * which is what makes the cache exact. `ours` is base, `theirs` is head.
 */
export function previewPairMerge(repoDir: string, baseSha: string, headSha: string, exec: MergePreviewExec = defaultMergePreviewExec): Promise<PairMerge> {
  const key = `${repositoryLockKey(repoDir)}\0${baseSha}\0${headSha}`
  const cached = exec === defaultMergePreviewExec ? pairCache.get(key) : undefined
  if (cached) return cached
  const work = bounded(async (): Promise<PairMerge> => {
    if (!(await mergeTreeSupported(exec))) return { status: 'unknown', files: [], fileCount: 0, error: 'merge_tree_unsupported' }
    const store = await scratchObjectStore(repoDir, exec)
    if (!store) return { status: 'unknown', files: [], fileCount: 0, error: 'not_a_repository' }
    try {
      const merged = await exec(['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', baseSha, headSha], repoDir, store.env)
      if (merged.code === 1) {
        const names = parseNames(merged.stdout)
        return { status: 'conflicts', files: names.slice(0, MAX_CONFLICT_FILES), fileCount: names.length }
      }
      if (merged.code !== 0) {
        return { status: 'unknown', files: [], fileCount: 0, error: (merged.stderr.trim() || `exit ${merged.code}`).split('\n')[0] }
      }
      const tree = merged.stdout.split('\0')[0]?.trim() ?? ''
      const baseTree = await exec(['rev-parse', '--verify', `${baseSha}^{tree}`], repoDir)
      const landed = baseTree.code === 0 && baseTree.stdout.trim() === tree
      return { status: landed ? 'already_merged' : 'clean', files: [], fileCount: 0 }
    } finally {
      await store.dispose().catch(() => {})
    }
  })
  return exec === defaultMergePreviewExec ? remember(key, work) : work
}

/** Commits on `base` that `head` does not have ("the base moved N commits"). */
export async function commitsAhead(repoDir: string, headSha: string, baseSha: string, exec: MergePreviewExec = defaultMergePreviewExec): Promise<number | null> {
  const r = await bounded(() => exec(['rev-list', '--count', `${headSha}..${baseSha}`], repoDir))
  const n = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** Resolve a ref to a commit sha (null when it does not resolve). */
export async function resolveCommit(repoDir: string, ref: string, exec: MergePreviewExec = defaultMergePreviewExec): Promise<string | null> {
  const r = await exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoDir)
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}
