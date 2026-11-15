import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cloneGithubRepository, githubCloneUrl } from './github-clone'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function target() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.clone-test-'))
  roots.push(root)
  return path.join(root, 'checkout')
}

describe('GitHub clone', () => {
  it.each([
    ['owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['git@github.com:owner/repo.git', 'git@github.com:owner/repo.git'],
    ['ssh://git@github.com/owner/repo', 'git@github.com:owner/repo.git'],
  ])('normalizes %s', (input, expected) => expect(githubCloneUrl(input)).toBe(expected))

  it.each(['--upload-pack=evil', 'https://github.com.evil/owner/repo', 'https://token@github.com/owner/repo', 'file:///repo', 'ext::command', 'https://github.com/owner/repo/tree/main', 'owner/..', 'owner/repo?token=secret'])('rejects %s', input => {
    expect(() => githubCloneUrl(input)).toThrow()
  })

  it('reserves a new folder and passes arguments without a shell', async () => {
    const destination = await target()
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    expect(await cloneGithubRepository({ url: 'owner/repo', destination }, () => true, undefined, run)).toBe(destination)
    expect((await fs.stat(destination)).isDirectory()).toBe(true)
    expect(run).toHaveBeenCalledWith('git', expect.arrayContaining(['clone', '--', 'https://github.com/owner/repo.git', destination]), expect.objectContaining({ timeout: 300_000, env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) }))
  })

  it('[spec:github-repository-clone/existing-folders-are-not-overwritten] never touches an existing destination and rejects concurrent reservations', async () => {
    const destination = await target()
    await fs.mkdir(destination)
    await fs.writeFile(path.join(destination, 'keep'), 'user data')
    const run = vi.fn()
    await expect(cloneGithubRepository({ url: 'owner/repo', destination }, () => true, undefined, run)).rejects.toMatchObject({ code: 'clone_destination_exists' })
    expect(await fs.readFile(path.join(destination, 'keep'), 'utf8')).toBe('user data')
    expect(run).not.toHaveBeenCalled()
  })

  it('cleans only its own failed clone and redacts transport output', async () => {
    const destination = await target()
    const run = vi.fn().mockRejectedValue(new Error('secret-token'))
    await expect(cloneGithubRepository({ url: 'owner/private', destination }, () => true, undefined, run)).rejects.toMatchObject({ code: 'clone_failed', message: expect.not.stringContaining('secret-token') })
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.dirname(destination))).resolves.toBeDefined()
  })

  it('checks the canonical destination and validates parent before spawning', async () => {
    const destination = await target()
    const safe = vi.fn(() => false)
    const run = vi.fn()
    await expect(cloneGithubRepository({ url: 'owner/repo', destination }, safe, undefined, run)).rejects.toThrow('system directories')
    expect(safe).toHaveBeenCalledWith(destination)
    await expect(cloneGithubRepository({ url: 'owner/repo', destination: path.join(destination, 'nested') }, () => true, undefined, run)).rejects.toThrow('parent folder')
    await expect(cloneGithubRepository({ url: 'owner/repo', destination: 'relative' }, () => true, undefined, run)).rejects.toThrow('absolute')
    expect(run).not.toHaveBeenCalled()
  })
})
