import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { suggestVerificationCommands } from './agent-runtime-verification-suggestions'

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
