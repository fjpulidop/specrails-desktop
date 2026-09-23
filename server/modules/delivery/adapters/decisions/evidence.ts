import * as path from 'path'
import * as fs from 'fs'
import { type GitRunner } from '../../../../worktree-manager'
import { getPrDelivery, type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import {
  inspectRecoveryCommitProtection, releaseRecoveryCommit
} from '../../runtime/rail-pr-recovery-git'
import { PrDecisionDeps } from './contracts'


export const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i


export async function exactRefSha(
  deps: PrDecisionDeps,
  cwd: string,
  ref: string,
): Promise<string | null> {
  try {
    const result = await deps.git.run(['rev-parse', '--verify', ref], cwd)
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return COMMIT_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}


export async function isFastForwardCandidate(
  deps: PrDecisionDeps,
  baselineSha: string,
  candidateSha: string,
): Promise<boolean> {
  if (baselineSha === candidateSha) return true
  try {
    return (await deps.git.run(
      ['merge-base', '--is-ancestor', baselineSha, candidateSha],
      deps.project.path,
    )).code === 0
  } catch {
    return false
  }
}


export async function releaseDeliveredRecoveryLineage(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  deliveredSha: string | null,
): Promise<void> {
  if (!deliveredSha || !COMMIT_SHA_RE.test(deliveredSha)) return
  const currentProtection = await inspectRecoveryCommitProtection(
    deps.git,
    deps.project.path,
    row.id,
  )
  if (
    currentProtection.kind === 'present' &&
    currentProtection.sha.toLowerCase() === deliveredSha.toLowerCase()
  ) {
    await releaseRecoveryCommit(deps.git, deps.project.path, row.id, deliveredSha)
  }

  const visited = new Set<string>([row.id])
  let predecessorId = row.supersedes_delivery_id
  for (let depth = 0; predecessorId && depth < 32 && !visited.has(predecessorId); depth++) {
    visited.add(predecessorId)
    const predecessor = getPrDelivery(deps.db, predecessorId)
    if (!predecessor) break
    if (predecessor.decision !== 'discarded' && predecessor.decision !== 'superseded') break
    const protection = await inspectRecoveryCommitProtection(
      deps.git,
      deps.project.path,
      predecessor.id,
    )
    if (protection.kind === 'present' && await isFastForwardCandidate(
      deps,
      protection.sha,
      deliveredSha,
    )) {
      await releaseRecoveryCommit(
        deps.git,
        deps.project.path,
        predecessor.id,
        protection.sha,
      )
    }
    predecessorId = predecessor.supersedes_delivery_id
  }
}


export interface RegisteredGitWorktree {
  worktreePath: string
  head: string | null
  branch: string | null
}


export function parseRegisteredGitWorktrees(stdout: string): RegisteredGitWorktree[] {
  const worktrees: RegisteredGitWorktree[] = []
  let current: RegisteredGitWorktree | null = null
  const finish = () => {
    if (current) worktrees.push(current)
    current = null
  }
  for (const field of stdout.split('\0')) {
    if (field === '') {
      finish()
      continue
    }
    if (field.startsWith('worktree ')) {
      finish()
      current = { worktreePath: field.slice('worktree '.length), head: null, branch: null }
      continue
    }
    if (!current) continue
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    if (field.startsWith('branch ')) current.branch = field.slice('branch '.length)
  }
  finish()
  return worktrees
}


export type RecoveryWorktreeAuthentication =
  | { ok: true; realPath: string; head: string }
  | { ok: false; detail: string }


/** Authenticate a ledger path as a live, non-symlink worktree registered by
 * this exact repository. The main checkout and ordinary directories fail
 * closed. Callers repeat this immediately before staging to close the useful
 * path-replacement window between inspection and mutation. */
export async function authenticateRecoveryWorktree(
  deps: PrDecisionDeps,
  ledgerPath: string,
  expectedBranch: string,
  expectedHead?: string,
): Promise<RecoveryWorktreeAuthentication> {
  if (!path.isAbsolute(ledgerPath)) {
    return { ok: false, detail: 'the recorded worktree path is not absolute' }
  }
  let realPath: string
  let projectRealPath: string
  try {
    const ledgerStat = fs.lstatSync(ledgerPath)
    if (ledgerStat.isSymbolicLink()) {
      return { ok: false, detail: 'the recorded worktree path is a symbolic link' }
    }
    if (!ledgerStat.isDirectory()) {
      return { ok: false, detail: 'the recorded worktree path is not a directory' }
    }
    realPath = fs.realpathSync(ledgerPath)
    projectRealPath = fs.realpathSync(deps.project.path)
    if (!fs.statSync(realPath).isDirectory()) {
      return { ok: false, detail: 'the canonical worktree path is not a directory' }
    }
  } catch {
    return { ok: false, detail: 'the recorded worktree path could not be resolved safely' }
  }
  if (realPath === projectRealPath) {
    return { ok: false, detail: 'the recorded worktree path resolves to the main project checkout' }
  }

  let listed: Awaited<ReturnType<GitRunner['run']>>
  try {
    listed = await deps.git.run(['worktree', 'list', '--porcelain', '-z'], deps.project.path)
  } catch {
    return { ok: false, detail: 'Git worktree registration could not be verified' }
  }
  if (listed.code !== 0) {
    return { ok: false, detail: 'Git worktree registration could not be verified' }
  }
  const matches = parseRegisteredGitWorktrees(listed.stdout).filter((registered) => {
    try {
      return fs.realpathSync(registered.worktreePath) === realPath
    } catch {
      return false
    }
  })
  if (matches.length !== 1) {
    return { ok: false, detail: 'the recorded path is not uniquely registered as a Git worktree of this project' }
  }
  const registered = matches[0]
  if (registered.branch !== `refs/heads/${expectedBranch}`) {
    return { ok: false, detail: 'the registered Git worktree is not on the recorded delivery branch' }
  }
  if (!registered.head || !COMMIT_SHA_RE.test(registered.head)) {
    return { ok: false, detail: 'the registered Git worktree has no verifiable commit identity' }
  }
  if (expectedHead && registered.head.toLowerCase() !== expectedHead.toLowerCase()) {
    return { ok: false, detail: 'the registered Git worktree changed commits before staging' }
  }
  return { ok: true, realPath, head: registered.head }
}


export async function commitObjectExists(deps: PrDecisionDeps, sha: string): Promise<boolean> {
  if (!COMMIT_SHA_RE.test(sha)) return false
  try {
    return (await deps.git.run(['cat-file', '-e', `${sha}^{commit}`], deps.project.path)).code === 0
  } catch {
    return false
  }
}


/** Resolve a legacy mutable ref once into an immutable object. New settlement
 * rows already carry finalSha and never take this compatibility path. */
export async function captureBranchSha(deps: PrDecisionDeps, branch: string): Promise<string | null> {
  try {
    const result = await deps.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], deps.project.path)
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return COMMIT_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}
