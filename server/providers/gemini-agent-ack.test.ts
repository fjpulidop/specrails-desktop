import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acknowledgeGeminiProjectAgents } from './gemini-agent-ack'
import { geminiAdapter } from './gemini-adapter'

describe('acknowledgeGeminiProjectAgents', () => {
  let tmp: string
  let origHome: string | undefined
  let origUserProfile: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gemini-ack-test-'))
    // os.homedir() reads HOME on POSIX, USERPROFILE on Windows — redirect both so
    // the real ~/.gemini/acknowledgments/agents.json is never touched.
    origHome = process.env.HOME
    origUserProfile = process.env.USERPROFILE
    const fakeHome = join(tmp, 'home')
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = origUserProfile
    rmSync(tmp, { recursive: true, force: true })
  })

  const ackPath = () => join(homedir(), '.gemini', 'acknowledgments', 'agents.json')
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const readAck = () => JSON.parse(readFileSync(ackPath(), 'utf8')) as Record<string, Record<string, string>>

  function makeProject(name: string, agents: Record<string, string>): string {
    const root = join(tmp, name)
    const dir = join(root, '.gemini', 'agents')
    mkdirSync(dir, { recursive: true })
    for (const [id, content] of Object.entries(agents)) writeFileSync(join(dir, `${id}.md`), content)
    return root
  }

  it('writes sha256-of-file-content per agent keyed by project path', () => {
    const root = makeProject('repo', { 'sr-architect': 'ARCH\n', 'sr-developer': 'DEV\n' })
    acknowledgeGeminiProjectAgents(root)
    const ack = readAck()
    expect(ack[root]['sr-architect']).toBe(sha('ARCH\n'))
    expect(ack[root]['sr-developer']).toBe(sha('DEV\n'))
  })

  it('is a no-op when the project has no .gemini/agents dir', () => {
    acknowledgeGeminiProjectAgents(join(tmp, 'empty'))
    expect(existsSync(ackPath())).toBe(false)
  })

  it('is a no-op when the agents dir has no .md files', () => {
    const root = join(tmp, 'noagents')
    mkdirSync(join(root, '.gemini', 'agents'), { recursive: true })
    acknowledgeGeminiProjectAgents(root)
    expect(existsSync(ackPath())).toBe(false)
  })

  it('ignores non-.md and underscore-prefixed files', () => {
    const root = makeProject('repo', { 'sr-architect': 'A\n' })
    writeFileSync(join(root, '.gemini', 'agents', 'notes.txt'), 'x')
    writeFileSync(join(root, '.gemini', 'agents', '_hidden.md'), 'x')
    acknowledgeGeminiProjectAgents(root)
    expect(Object.keys(readAck()[root])).toEqual(['sr-architect'])
  })

  it('merges — preserves other projects and earlier agents across calls', () => {
    const a = makeProject('A', { 'sr-architect': 'A1\n' })
    const b = makeProject('B', { 'sr-developer': 'B1\n' })
    acknowledgeGeminiProjectAgents(a)
    acknowledgeGeminiProjectAgents(b)
    writeFileSync(join(a, '.gemini', 'agents', 'sr-reviewer.md'), 'A2\n')
    acknowledgeGeminiProjectAgents(a)
    const ack = readAck()
    expect(ack[b]['sr-developer']).toBe(sha('B1\n')) // other project survives
    expect(ack[a]['sr-architect']).toBe(sha('A1\n')) // earlier agent survives
    expect(ack[a]['sr-reviewer']).toBe(sha('A2\n'))
  })

  it('recovers from a corrupt existing ack file', () => {
    const root = makeProject('repo', { 'sr-architect': 'A\n' })
    mkdirSync(join(homedir(), '.gemini', 'acknowledgments'), { recursive: true })
    writeFileSync(ackPath(), 'not json{{{')
    acknowledgeGeminiProjectAgents(root)
    expect(readAck()[root]['sr-architect']).toBe(sha('A\n'))
  })

  it('is wired as the gemini adapter prepareHeadlessSpawn hook', () => {
    expect(geminiAdapter.prepareHeadlessSpawn).toBe(acknowledgeGeminiProjectAgents)
  })
})
