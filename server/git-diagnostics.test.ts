import { describe, it, expect, vi } from 'vitest'
import {
  runGitDiagnostic,
  isGitDiagnosticAction,
  GIT_DIAGNOSTIC_ACTIONS,
  gitDiagnosticHelp,
  type DiagnosticExec,
} from './git-diagnostics'

const okExec = (stdout: string, code = 0, stderr = ''): DiagnosticExec =>
  vi.fn(async () => ({ code, stdout, stderr }))

describe('git-diagnostics — fixed read-only allowlist', () => {
  it('maps every action to a read-only git/gh command (no mutations)', async () => {
    const seen: Array<{ cmd: string; args: string[] }> = []
    const exec: DiagnosticExec = vi.fn(async (cmd, args) => { seen.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' } })
    for (const action of GIT_DIAGNOSTIC_ACTIONS) {
      await runGitDiagnostic(action, '/repo', exec)
    }
    // Only git/gh binaries, and NONE of the commands mutate the repo.
    const MUTATING = /\b(push|commit|checkout|merge|reset|rebase|clean|rm|create|ready|close|delete|branch -d|branch -D)\b/
    for (const { cmd, args } of seen) {
      expect(['git', 'gh']).toContain(cmd)
      expect(MUTATING.test(args.join(' '))).toBe(false)
    }
  })

  it('runs the git remote command for the `remote` action + reports ok/exit/output', async () => {
    const exec = okExec('origin\tgit@github.com:me/repo.git (fetch)')
    const r = await runGitDiagnostic('remote', '/repo', exec)
    expect(exec).toHaveBeenCalledWith('git', ['remote', '-v'], '/repo')
    expect(r).toMatchObject({ action: 'remote', command: 'git remote -v', ok: true, exitCode: 0 })
    expect(r.stdout).toContain('github.com')
  })

  it('a non-zero exit is a NORMAL result (ok:false), not a throw — e.g. gh_repo with no remote', async () => {
    const exec = okExec('', 1, 'no git remotes found')
    const r = await runGitDiagnostic('gh_repo', '/repo', exec)
    expect(exec).toHaveBeenCalledWith('gh', ['repo', 'view'], '/repo')
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('no git remotes')
  })

  it('rejects an unknown action (defence-in-depth over the route validation)', async () => {
    await expect(runGitDiagnostic('push', '/repo', okExec(''))).rejects.toThrow(/Unknown diagnostic action/)
    await expect(runGitDiagnostic('git remote -v; rm -rf /', '/repo', okExec(''))).rejects.toThrow()
  })

  it('caps very long output', async () => {
    const r = await runGitDiagnostic('log', '/repo', okExec('x'.repeat(20_000)))
    expect(r.stdout.length).toBeLessThan(9_000)
    expect(r.stdout).toContain('…(truncated)')
  })

  it('isGitDiagnosticAction guards the allowlist; help covers every action', () => {
    expect(isGitDiagnosticAction('remote')).toBe(true)
    expect(isGitDiagnosticAction('push')).toBe(false)
    expect(isGitDiagnosticAction(42)).toBe(false)
    const help = gitDiagnosticHelp()
    for (const a of GIT_DIAGNOSTIC_ACTIONS) expect(help[a]).toBeTruthy()
  })
})
