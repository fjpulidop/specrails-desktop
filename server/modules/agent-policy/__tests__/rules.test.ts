import { describe, expect, it } from 'vitest'
import { evaluateShell, evaluateToolCall, type GitFacts, type PolicyFacts } from '../domain/rules'
import { readScript } from '../domain/shell'
import { parseInstallCommand } from '../../machine-installs'

const RUN = '/sr/worktrees/run-1'
const OTHER_REPO = '/Users/u/code/app'

function facts(overrides: Partial<PolicyFacts> = {}, git: Record<string, GitFacts> = {}, links: Record<string, string> = {}): PolicyFacts {
  const repos: Record<string, GitFacts> = {
    [RUN]: { branch: 'feat/42-thing', defaultBranch: 'develop' },
    [OTHER_REPO]: { branch: 'main', defaultBranch: 'main' },
    ...git,
  }
  return {
    home: '/Users/u',
    specrailsHome: '/Users/u',
    projectDir: RUN,
    cwd: RUN,
    tempDirs: ['/tmp', '/private/tmp'],
    git: (dir) => {
      const root = Object.keys(repos).filter((r) => dir === r || dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
      return root ? repos[root]! : { branch: null, defaultBranch: null }
    },
    realpath: (p) => {
      for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
      return p
    },
    ...overrides,
  }
}

const rule = (command: string, f = facts()) => evaluateShell(command, f)?.rule ?? null

describe('git rules (shared with git-guardrails)', () => {
  it('denies every force-push form', () => {
    for (const command of [
      'git push --force origin feat/42-thing',
      'git push -f',
      'git push -uf origin HEAD',
      'git push --force-with-lease origin feat/42-thing',
      'git push --force-with-lease=feat:abc origin feat',
      'git push origin +HEAD:feat/42-thing',
      'git push --mirror backup',
      'cd sub && git -C .. push --force',
    ]) expect(rule(command), command).toBe('git-force-push')
  })

  it('denies pushes to the integration/default branch, main and master', () => {
    expect(rule('git push origin develop')).toBe('git-push-protected')
    expect(rule('git push origin HEAD:main')).toBe('git-push-protected')
    expect(rule('git push origin feat:refs/heads/master')).toBe('git-push-protected')
    // Implicit refspec on a checkout of the default branch.
    expect(rule(`git -C ${OTHER_REPO} push`)).toBe('git-push-protected')
    expect(rule(`cd ${OTHER_REPO} && git push origin HEAD`)).toBe('git-push-protected')
  })

  it('allows pushing the run branch', () => {
    expect(rule('git push -u origin feat/42-thing')).toBeNull()
    expect(rule('git push')).toBeNull()
    expect(rule('git push origin HEAD')).toBeNull()
  })

  it('denies remote branch deletion', () => {
    expect(rule('git push origin --delete feat/old')).toBe('git-push-delete')
    expect(rule('git push origin :feat/old')).toBe('git-push-delete')
  })

  it('allows reset --hard only on the run branch inside the run', () => {
    expect(rule('git reset --hard HEAD~1')).toBeNull()
    expect(rule(`git -C ${OTHER_REPO} reset --hard origin/main`)).toBe('git-reset-hard')
    expect(rule(`cd ${OTHER_REPO}; git reset --hard`)).toBe('git-reset-hard')
    expect(rule('git reset --hard', facts({}, { [RUN]: { branch: 'develop', defaultBranch: 'develop' } }))).toBe('git-reset-hard')
    expect(rule('cd "$SOMEWHERE" && git reset --hard')).toBe('git-reset-hard')
    expect(rule('git reset --soft HEAD~1')).toBeNull()
  })

  it('denies deleting protected, own or out-of-run branches', () => {
    expect(rule('git branch -D develop')).toBe('git-branch-delete')
    expect(rule('git branch --delete main')).toBe('git-branch-delete')
    expect(rule('git branch -d feat/42-thing')).toBe('git-branch-delete')
    expect(rule(`git -C ${OTHER_REPO} branch -D scratch`)).toBe('git-branch-delete')
    expect(rule('git branch -D scratch')).toBeNull()
    expect(rule('git branch -a')).toBeNull()
  })

  it('denies merging a PR from inside a turn', () => {
    expect(rule('gh pr merge 12 --squash')).toBe('gh-pr-merge')
    expect(rule('gh pr view 12')).toBeNull()
  })
})

describe('recursive deletion', () => {
  it('allows deletes inside the run and temp dirs', () => {
    for (const command of ['rm -rf dist', 'rm -rf ./build/*', 'rm -r node_modules', 'rm -rf /tmp/scratch', `rm -rf ${RUN}/out`, 'find . -name "*.log" -delete', 'rimraf coverage', 'rm -rf *']) {
      expect(rule(command), command).toBeNull()
    }
  })

  it('denies deletes outside the run, of the run itself, or of unknown targets', () => {
    for (const command of [
      'rm -rf ..',
      'rm -rf ../*',
      'rm -rf ~',
      'rm -rf $HOME/projects',
      'rm -fr /',
      `rm -rf ${RUN}`,
      'rm -rf "$TARGET"',
      'rm -rf $(cat list.txt)',
      'sudo rm -rf /opt/app',
      'bash -c "rm -rf /Users/u/code"',
      'find /Users/u -name x -delete',
      'find .. -exec rm -rf {} +',
      'npx rimraf ../other',
      'ls | xargs rm -rf',
      `git -C ${OTHER_REPO} clean -fdx`,
      'rm -rf /tmp',
    ]) expect(rule(command), command).toBe('rm-outside-run')
  })

  it('follows a symlinked operand only when the path says so', () => {
    const linked = facts({}, {}, { [`${RUN}/node_modules`]: '/Users/u/code/app/node_modules' })
    expect(rule('rm -rf node_modules', linked)).toBeNull()
    expect(rule('rm -rf node_modules/', linked)).toBe('rm-outside-run')
  })

  it('ignores non-recursive rm and heredoc bodies', () => {
    expect(rule('rm -f ../stale.lock')).toBeNull()
    expect(rule("cat > notes.md <<'EOF'\nrm -rf /\nEOF\necho done")).toBeNull()
  })
})

describe('secrets and tampering', () => {
  it('denies shell access to credentials', () => {
    for (const command of [
      'cat ~/.ssh/id_rsa',
      'cp $HOME/.aws/credentials /tmp/x',
      'tar czf /tmp/k.tgz ${HOME}/.gnupg',
      'ls /Users/u/Library/Keychains',
      'security find-generic-password -s github -w',
      'cd ~ && cat .ssh/config',
      'echo hi > ~/.ssh/authorized_keys',
      'ssh-keygen -y -f=~/.ssh/id_ed25519',
      'cat /Users/u/.specrails/desktop.token',
      'cat "$DIR/.ssh/id_rsa"',
    ]) expect(rule(command), command).toBe('secret-access')
  })

  it('denies tool access to credentials', () => {
    expect(evaluateToolCall('Read', { file_path: '/Users/u/.ssh/id_rsa' }, facts())?.rule).toBe('secret-access')
    expect(evaluateToolCall('Read', { file_path: '~/.aws/config' }, facts())?.rule).toBe('secret-access')
    expect(evaluateToolCall('Glob', { pattern: '~/.gnupg/**' }, facts())?.rule).toBe('secret-access')
    expect(evaluateToolCall('Grep', { pattern: 'token', path: '/Users/u/.specrails/mcp.token' }, facts())?.rule).toBe('secret-access')
    expect(evaluateToolCall('Write', { file_path: '/Users/u/.ssh/authorized_keys', content: 'x' }, facts())?.rule).toBe('secret-access')
    // A symlink inside the run pointing at a key.
    expect(evaluateToolCall('Read', { file_path: `${RUN}/key` }, facts({}, {}, { [`${RUN}/key`]: '/Users/u/.ssh/id_rsa' }))?.rule).toBe('secret-access')
  })

  it('lets a run read the env file copied into its worktree, never the secret stores', () => {
    // worktreeEnvFiles copies `.env` into the run: reading it there is the point.
    expect(evaluateToolCall('Read', { file_path: `${RUN}/.env` }, facts())).toBeNull()
    expect(rule('cat .env')).toBeNull()
    expect(rule('cat ~/.ssh/id_rsa')).toBe('secret-access')
    expect(evaluateToolCall('Read', { file_path: '/Users/u/.aws/credentials' }, facts())?.rule).toBe('secret-access')
  })

  it('denies changing the hook files', () => {
    expect(evaluateToolCall('Write', { file_path: '/Users/u/.specrails/agent-policy/specrails-policy-hook-x.cjs', content: '' }, facts())?.rule).toBe('policy-tamper')
    expect(rule('rm /Users/u/.specrails/agent-policy/specrails-policy-hook-x.cjs')).toBe('policy-tamper')
  })

  it('leaves ordinary work alone', () => {
    expect(evaluateToolCall('Read', { file_path: `${RUN}/src/index.ts` }, facts())).toBeNull()
    expect(evaluateToolCall('Edit', { file_path: `${RUN}/README.md`, old_string: 'a', new_string: 'b' }, facts())).toBeNull()
    expect(evaluateToolCall('WebFetch', { url: 'https://example.com' }, facts())).toBeNull()
    for (const command of ['npm test', 'git commit -m "fix .ssh docs"', 'git status && git diff', 'grep -rn ssh src', 'echo "$(date)"']) {
      expect(rule(command), command).toBeNull()
    }
  })
})

describe('shell reader', () => {
  it('follows cd, wrappers, nested scripts and redirects', () => {
    const commands = readScript('cd sub && FOO=1 sudo -u x env A=b rm -rf out > log.txt; echo `pwd` $(ls ..)', { cwd: '/r', home: '/h' })
    const rm = commands.find((c) => c.words[0]?.text === 'rm')!
    expect(rm.cwd).toBe('/r/sub')
    expect(rm.redirects.map((w) => w.text)).toEqual(['log.txt'])
    expect(commands.some((c) => c.words[0]?.text === 'pwd')).toBe(true)
    expect(commands.some((c) => c.words[0]?.text === 'ls')).toBe(true)
  })

  it('never throws on unbalanced input', () => {
    for (const text of ['"unterminated', "'x", '$(', '`', 'a <<', '\\', '((', '${']) expect(() => readScript(text, { cwd: '/r', home: '/h' })).not.toThrow()
  })
})

describe('machine-wide installs', () => {
  it('denies installs and toolchain changes every project shares', () => {
    for (const command of [
      'rustup target add wasm32-unknown-unknown > /tmp/x.log 2>&1',
      'rustup toolchain install nightly',
      'rustup component add clippy',
      'rustup default stable',
      'brew install terraform',
      'sudo apt-get install -y dotnet-sdk-8.0',
      'npm install -g typescript',
      'npm i --global pnpm',
      'pnpm add -g vite',
      'yarn global add serve',
      'cargo install wasm-pack',
      'go install golang.org/x/tools/gopls@latest',
      'gem install rails',
      'pipx install jupyter',
      'pip3 install --user nbclient',
      'pip install --break-system-packages nbformat',
      'corepack enable',
      'nvm install 22',
      'asdf install elixir 1.17',
      'dotnet tool install -g dotnet-format',
      'cd /tmp && brew upgrade node',
    ]) expect(rule(command), command).toBe('machine-install')
  })

  it('leaves workspace-local installs and reads alone', () => {
    for (const command of [
      'npm install', 'npm install ms', 'npm ci', 'npx --yes yarn@1.22.22 install', 'pnpm add -D vitest',
      'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', 'pip install -r requirements.txt',
      'cargo build --release --target wasm32-unknown-unknown', 'cargo test', 'go test ./...', 'go build ./...',
      'bundle install', 'gem install --install-dir vendor/gems rake', 'brew list', 'brew --prefix',
      'rustup target list --installed', 'rustup show', 'npx playwright install chromium', 'composer install',
      'nvm ls', 'asdf current', 'dotnet test', 'echo npm install -g typescript',
    ]) expect(rule(command), command).toBeNull()
  })

  it('tells the agent what to do instead', () => {
    expect(evaluateShell('rustup target add wasm32-unknown-unknown', facts())?.reason).toMatch(/`rustup target add` changes this machine for every project.*toolchain blocker/)
    expect(evaluateShell('brew install terraform', facts())?.reason).toContain('the host asks the person once and installs it outside the run')
  })

  it('still denies the agent every install the host may run for the person (ask once runs outside the run, never through the agent)', () => {
    for (const command of [
      'brew install terraform', 'brew install --cask docker', 'npm install -g @scope/cli@2.1.0', 'npm i --global typescript', 'pnpm add -g turbo', 'bun add -g serve', 'yarn global add serve',
      'cargo install --locked wasm-pack', 'go install golang.org/x/tools/gopls@latest', 'gem install --user-install bundler', 'pipx install poetry', 'pip3 install --user black',
      'rustup target add wasm32-unknown-unknown', 'rustup component add clippy', 'rustup toolchain install nightly', 'dotnet tool install -g dotnet-ef', 'sdkmanager "platforms;android-34"',
      'scoop install jq', 'winget install jq',
    ]) {
      expect(parseInstallCommand(command).ok, command).toBe(true)
      expect(rule(command), command).toBe('machine-install')
    }
  })
})
