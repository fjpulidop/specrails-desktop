import { describe, it, expect } from 'vitest'
import { classifyCommand } from '../narration-commands'

describe('classifyCommand — plumbing', () => {
  // Measured on real runs in this project: these accounted for ~80% of all
  // shell invocations and told the reader nothing.
  const plumbing = [
    'grep -rn foo src/', 'cd client', 'find . -name "*.ts"', "sed -n '1,220p' file.ts",
    'ls -la', 'cat package.json', 'jq .version package.json', 'rg todo', 'pwd',
    'wc -l file', 'echo hi', 'test -f x', 'which node', 'date', 'head -20 x', 'tail -f y',
    'sort', 'uniq -c', 'xargs rm', 'tree src',
  ]
  for (const command of plumbing) {
    it(`treats "${command}" as plumbing`, () => {
      expect(classifyCommand(command).kind).toBe('plumbing')
    })
  }

  it('treats read-only git as looking around, not work', () => {
    for (const sub of ['status', 'diff', 'log --oneline', 'show HEAD', 'rev-parse HEAD', 'branch']) {
      expect(classifyCommand(`git ${sub}`).kind).toBe('plumbing')
    }
  })

  it('resolves an absolute path to its binary name', () => {
    expect(classifyCommand('/usr/bin/grep foo').kind).toBe('plumbing')
  })

  it('treats an empty or flag-only command as plumbing', () => {
    expect(classifyCommand('').kind).toBe('plumbing')
    expect(classifyCommand('   ').kind).toBe('plumbing')
    expect(classifyCommand('-l -a').kind).toBe('plumbing')
  })
})

describe('classifyCommand — translated intent', () => {
  const cases: Array<[string, string]> = [
    ['npm test', 'activity.testing'],
    ['npm run test', 'activity.testing'],
    ['npm run test:coverage', 'activity.testing'],
    ['npx vitest run', 'activity.testing'],
    ['npx vitest run --coverage', 'activity.testing'],
    ['vitest run server/db.test.ts', 'activity.testing'],
    ['pytest -q', 'activity.testing'],
    ['jest --json', 'activity.testing'],
    ['cargo test', 'activity.testing'],
    ['go test ./...', 'activity.testing'],
    ['npm run build', 'activity.building'],
    ['cargo build --release', 'activity.building'],
    ['npm run typecheck', 'activity.typechecking'],
    ['tsc --noEmit', 'activity.typechecking'],
    ['npx tsc --noEmit', 'activity.typechecking'],
    ['npm run lint', 'activity.linting'],
    ['npm install', 'activity.installing'],
    ['npm ci', 'activity.installing'],
    ['git commit -m "x"', 'activity.savingWork'],
    ['git add -A', 'activity.savingWork'],
    ['openspec validate', 'activity.checkingSpec'],
  ]
  for (const [command, code] of cases) {
    it(`"${command}" reads as ${code}`, () => {
      expect(classifyCommand(command)).toEqual({ kind: 'intent', code })
    })
  }
})

describe('classifyCommand — never guesses', () => {
  it('falls back to the tool name for an unmapped script', () => {
    // `npm run whatever` could be anything; claiming it is tests would be invention.
    expect(classifyCommand('npm run generate-fixtures')).toEqual({ kind: 'named', tool: 'npm' })
  })

  it('falls back to the tool name for an unmapped subcommand', () => {
    expect(classifyCommand('git push origin main')).toEqual({ kind: 'named', tool: 'git' })
    expect(classifyCommand('cargo clippy')).toEqual({ kind: 'named', tool: 'cargo' })
  })

  it('reports an unknown tool by its own name', () => {
    expect(classifyCommand('terraform apply')).toEqual({ kind: 'named', tool: 'terraform' })
    expect(classifyCommand('python3 script.py')).toEqual({ kind: 'named', tool: 'python3' })
  })

  it('ignores flags when locating the subcommand', () => {
    expect(classifyCommand('npm --silent run build')).toEqual({ kind: 'intent', code: 'activity.building' })
    expect(classifyCommand('git -C /repo commit -m x')).toEqual({ kind: 'intent', code: 'activity.savingWork' })
  })

  it('strips a leading quote left by an unwrapped shell command', () => {
    expect(classifyCommand("'npm test")).toEqual({ kind: 'intent', code: 'activity.testing' })
  })

  it('handles a runner delegating through dlx/exec', () => {
    expect(classifyCommand('pnpm dlx vitest run')).toEqual({ kind: 'intent', code: 'activity.testing' })
    expect(classifyCommand('yarn exec jest')).toEqual({ kind: 'intent', code: 'activity.testing' })
  })
})
