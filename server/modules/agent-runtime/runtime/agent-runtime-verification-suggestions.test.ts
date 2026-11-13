import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { environmentPlanApplied, mergeEnvironmentPlan, pinnedPythonVersion, pythonEnvironmentPlan, suggestVerificationCommands } from './agent-runtime-verification-suggestions'

let root: string
const repo = (name: string, files: Record<string, string>) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content) }
  return { id: name, path: dir }
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification suggestions ')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('suggestVerificationCommands', () => {
  it('proposes only scripts that exist, using the repository package manager, and skips the npm placeholder test', () => {
    const suggestions = suggestVerificationCommands([
      repo('web', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', 'type-check': 'tsc -p .', lint: 'eslint .', build: 'vite build' } }), 'yarn.lock': '' }),
      repo('placeholder', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }) }),
      repo('empty', { 'package.json': JSON.stringify({ name: 'nothing' }) }),
    ])
    expect(suggestions).toEqual([
      { repositoryId: 'web', command: 'yarn', args: ['test'], reason: 'package.json test script "test"' },
      { repositoryId: 'web', command: 'yarn', args: ['run', 'type-check'], reason: 'package.json type check script "type-check"' },
      { repositoryId: 'web', command: 'yarn', args: ['run', 'lint'], reason: 'package.json lint script "lint"' },
      { repositoryId: 'placeholder', command: 'npm', args: ['run', 'build'], reason: 'package.json build script "build" (no test or type check script found)' },
    ])
  })
  it('recognises other ecosystems and returns nothing for repositories without a known check', () => {
    const suggestions = suggestVerificationCommands([
      repo('rust', { 'Cargo.toml': '[package]' }),
      repo('go', { 'go.mod': 'module x' }),
      repo('py', { 'pyproject.toml': '[tool.pytest.ini_options]', 'tests/test_x.py': '' }),
      repo('html', { 'index.html': '<html></html>' }),
      { id: 'missing', path: path.join(root, 'absent') },
    ])
    expect(suggestions.map((s) => [s.repositoryId, s.command, ...s.args])).toEqual([
      ['rust', 'cargo', 'test'],
      ['go', 'go', 'test', './...'],
      ['py', process.platform === 'win32' ? 'python' : 'python3', '-m', 'pytest'],
    ])
  })
})


it('detects checks in every configured code workspace and never proposes the parent test script', () => {
  const parent = repo('skills', { 'package.json': JSON.stringify({ scripts: { test: 'echo wrong-parent' } }), 'skills-studio/package.json': JSON.stringify({ scripts: { test: 'studio-tests' } }), 'skills-service/package.json': JSON.stringify({ scripts: { typecheck: 'tsc' } }) })
  const checks = suggestVerificationCommands([{ ...parent, workspacePaths: ['skills-studio', 'skills-service'].map(dir => path.join(parent.path, dir)) }])
  expect(checks.map(check => [check.cwd, ...check.args])).toEqual([['skills-studio', 'test'], ['skills-service', 'run', 'typecheck']])
})

describe('pythonEnvironmentPlan', () => {
  const made: string[] = []
  afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
  // The deckdex-mtg shape: the image pins Python 3.11, requirements at the root and in backend/.
  const project = (extra: Record<string, string> = {}): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-plan-')); made.push(root)
    for (const [name, content] of Object.entries({ 'backend/Dockerfile': 'FROM python:3.11-slim\n', 'requirements.txt': 'sqlalchemy\n', 'backend/requirements-api.txt': 'fastapi\n', 'pyproject.toml': '[tool.pytest.ini_options]\n', 'tests/test_x.py': '', ...extra })) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content)
    }
    return root
  }
  const probe = (found: boolean, ignored: boolean) => ({ findExecutable: (name: string) => (found && name === 'python3.11' ? '/opt/homebrew/bin/python3.11' : null), ignored: () => ignored })

  it.skipIf(process.platform === 'win32')('builds a venv from the pinned interpreter and runs pytest in it', () => {
    const root = project()
    expect(pinnedPythonVersion(root)).toEqual({ version: '3.11', source: 'backend/Dockerfile FROM python:3.11' })
    expect(pythonEnvironmentPlan({ id: 'repo', path: root }, probe(true, true))).toEqual({
      version: '3.11',
      reason: 'backend/Dockerfile FROM python:3.11; Python 3.11 venv (.venv is git-ignored)',
      setup: [
        { repositoryId: 'repo', label: 'Create the project venv (Python 3.11)', command: 'python3.11', args: ['-m', 'venv', '.venv'] },
        { repositoryId: 'repo', label: 'Install Python dependencies into the venv', command: '.venv/bin/python', args: ['-m', 'pip', 'install', '-q', '-r', 'backend/requirements-api.txt', '-r', 'requirements.txt'] },
      ],
      verification: [{ repositoryId: 'repo', label: 'pytest (Python 3.11 venv)', command: '.venv/bin/python', args: ['-m', 'pytest'] }],
    })
  })

  it.skipIf(process.platform === 'win32')('proposes nothing without a pin, the interpreter, or a git-ignored .venv', () => {
    expect(pythonEnvironmentPlan({ id: 'repo', path: project({ 'backend/Dockerfile': 'FROM node:20\n' }) }, probe(true, true))).toBeNull()
    expect(pythonEnvironmentPlan({ id: 'repo', path: project() }, probe(false, true))).toBeNull()
    // A venv Git would commit must never be created in a delivery worktree.
    expect(pythonEnvironmentPlan({ id: 'repo', path: project() }, probe(true, false))).toBeNull()
  })
})

describe('mergeEnvironmentPlan', () => {
  const plan = {
    version: '3.11', reason: '',
    setup: [{ repositoryId: 'repo', command: 'python3.11', args: ['-m', 'venv', '.venv'] }, { repositoryId: 'repo', command: '.venv/bin/python', args: ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'] }],
    verification: [{ repositoryId: 'repo', command: '.venv/bin/python', args: ['-m', 'pytest'] }],
  }
  it('adds the setup once, replaces only a bare system pytest, and keeps every other check', () => {
    const config = { verification: [{ repositoryId: 'repo', command: 'python3', args: ['-m', 'pytest'] }, { repositoryId: 'repo', command: 'ruff', args: ['check'] }, { repositoryId: 'other', command: 'python3', args: ['-m', 'pytest'] }] }
    const merged = mergeEnvironmentPlan(config, plan)
    expect(merged.setup).toEqual(plan.setup)
    expect(merged.verification).toEqual([{ repositoryId: 'repo', command: 'ruff', args: ['check'] }, { repositoryId: 'other', command: 'python3', args: ['-m', 'pytest'] }, ...plan.verification])
    expect(environmentPlanApplied(merged, plan)).toBe(true)
    expect(mergeEnvironmentPlan(merged, plan)).toEqual(merged)
    expect(environmentPlanApplied(config, plan)).toBe(false)
  })
})
