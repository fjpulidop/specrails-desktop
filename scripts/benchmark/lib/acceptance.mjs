// Independent quality checks of a delivered candidate, outside the run: the
// delivered branch is exported (git archive) into a scratch directory, the
// scenario's HIDDEN acceptance tests are added there, and the harness runs the
// full suite (`npm test`), the lint and the hidden tests. Nothing is written
// into the repository the agent worked in. `parseTapSummary`,
// `unexpectedPaths` and `acceptanceVerdict` are pure.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `# pass N` / `# fail N` counts of a node --test TAP report. */
export function parseTapSummary(text) {
  const num = key => { const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(String(text ?? '')); return m ? Number(m[1]) : null }
  return { tests: num('tests'), pass: num('pass'), fail: num('fail') }
}

/** Changed paths a spec of this suite never needs: lockfiles, dependencies, runtime state, stray scratch files. */
export function unexpectedPaths(paths) {
  const allowed = /^(src|test|tests|openspec|docs)\/|^(README|CHANGELOG|CONTRIBUTING)\.md$/
  return paths.filter(p => p && !allowed.test(p))
}

/** One repository's checks → pass/fail. Every check must pass and no hidden test may fail. */
export function acceptanceVerdict(repo) {
  const hiddenOk = repo.hidden.tests === null ? repo.hiddenFiles === 0 : repo.hidden.fail === 0 && repo.hidden.pass > 0
  return Boolean(repo.branch && repo.suite === 'pass' && repo.lint !== 'fail' && hiddenOk)
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
}

/** The branch a delivery left in a fresh benchmark repository: the newest local branch other than the base. */
export function deliveredBranch(repoPath, base = 'main') {
  const refs = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], repoPath).split('\n').filter(Boolean)
  return refs.find(ref => ref !== base) ?? null
}

function run(command, args, cwd, timeoutMs = 300_000) {
  // A parent `node --test` (the harness's own tests) must not turn the candidate's runner into its subtest.
  const { NODE_TEST_CONTEXT: _parentRunner, ...env } = process.env
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...env, CI: '1', NO_COLOR: '1' } })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Check one repository of a finished scenario (`spec` = normalized repo spec with `hidden`). */
export function checkRepository(repoPath, spec) {
  const base = spec.branch ?? 'main'
  const out = { name: spec.name, branch: null, changed: [], unexpected: [], suite: 'not-run', lint: 'none', hidden: { tests: null, pass: null, fail: null }, hiddenFiles: Object.keys(spec.hidden ?? {}).length, failures: [] }
  out.branch = deliveredBranch(repoPath, base)
  if (!out.branch) { out.failures.push('no delivered branch'); out.pass = false; return out }
  out.changed = git(['diff', '--name-only', `${base}...${out.branch}`], repoPath).split('\n').filter(Boolean)
  out.unexpected = unexpectedPaths(out.changed)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-accept-'))
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', out.branch], { cwd: repoPath, maxBuffer: 256 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    const suite = run('npm', ['test', '--silent'], dir)
    out.suite = suite.ok ? 'pass' : 'fail'
    if (!suite.ok) out.failures.push(`npm test: ${suite.out.slice(-400)}`)
    const pkg = fs.existsSync(path.join(dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) : {}
    if (pkg.scripts?.lint) { const lint = run('npm', ['run', 'lint', '--silent'], dir); out.lint = lint.ok ? 'pass' : 'fail'; if (!lint.ok) out.failures.push(`lint: ${lint.out.slice(-300)}`) }
    const files = Object.entries(spec.hidden ?? {})
    for (const [rel, content] of files) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content) }
    if (files.length) {
      const hidden = run(process.execPath, ['--test', '--test-reporter=tap', ...files.map(([rel]) => rel)], dir)
      out.hidden = parseTapSummary(hidden.out)
      if (!hidden.ok) out.failures.push(`hidden: ${hidden.out.split('\n').filter(l => /^not ok|error:|expected|actual/i.test(l.trim())).slice(0, 12).join(' | ').slice(0, 600)}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  out.pass = acceptanceVerdict(out)
  return out
}

/** All repositories of a scenario. The scenario passes only when every repository does. */
export function checkScenario(scenario, workDir) {
  const repos = scenario.repos.map(spec => {
    try { return checkRepository(path.join(workDir, 'repos', spec.name), spec) } catch (error) { return { name: spec.name, pass: false, failures: [String(error.message ?? error).slice(0, 300)] } }
  })
  return { pass: repos.every(r => r.pass), repos }
}
