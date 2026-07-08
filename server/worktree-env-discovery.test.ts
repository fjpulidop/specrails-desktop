import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanWorktreeEnvRequirements } from './worktree-env-discovery'

let tmpDirs: string[] = []

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-env-scan-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

describe('scanWorktreeEnvRequirements', () => {
  it('discovers explicit env references and private package auth hints', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, '.npmrc'), '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n')
    fs.writeFileSync(path.join(repo, '.yarnrc.yml'), 'npmAuthToken: "${YARN_NPM_AUTH_TOKEN}"\n')
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: { build: 'node -e "console.log(process.env.AWS_PROFILE)"' },
      dependencies: {
        '@acme/design-system': '1.0.0',
        react: '^18.0.0',
      },
    }, null, 2))

    const res = scanWorktreeEnvRequirements(repo)

    expect(res.scannedFiles.sort()).toEqual(['.npmrc', '.yarnrc.yml', 'package.json'])
    expect(res.candidates.map((c) => c.name)).toEqual([
      'AWS_PROFILE',
      'NODE_AUTH_TOKEN',
      'NPM_TOKEN',
      'YARN_NPM_AUTH_TOKEN',
    ])
    expect(res.candidates.find((c) => c.name === 'AWS_PROFILE')).toMatchObject({
      confidence: 'high',
      files: ['package.json'],
    })
    expect(res.candidates.find((c) => c.name === 'NODE_AUTH_TOKEN')?.confidence).toBe('high')
    expect(res.candidates.find((c) => c.name === 'NPM_TOKEN')).toMatchObject({
      confidence: 'medium',
      files: ['package.json'],
    })
  })

  it('skips dependency folders and never scans arbitrary source files', () => {
    const repo = makeRepo()
    fs.mkdirSync(path.join(repo, 'node_modules', 'private-pkg'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'private-pkg', 'package.json'), JSON.stringify({
      scripts: { postinstall: 'echo ${SHOULD_NOT_LEAK}' },
    }))
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'process.env.RUNTIME_ONLY_SECRET\n')
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: {} }))

    const res = scanWorktreeEnvRequirements(repo)

    expect(res.scannedFiles).toEqual(['package.json'])
    expect(res.candidates).toEqual([])
  })
})
