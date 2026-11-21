import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureAgentConversationCwd, ensureAgentCwd } from './agent-cwd-manager'
import { OPERATOR_CWD_INSTRUCTIONS, buildOperatorSystemPrompt, providerLoadsOperatorCore } from './agent-operator-prompt'

describe('agent cwd instruction files', () => {
  let home: string
  const previous = process.env.SPECRAILS_REGISTRY_HOME
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cwd-')); process.env.SPECRAILS_REGISTRY_HOME = home })
  afterEach(() => { if (previous === undefined) delete process.env.SPECRAILS_REGISTRY_HOME; else process.env.SPECRAILS_REGISTRY_HOME = previous; fs.rmSync(home, { recursive: true, force: true }) })

  it('gives Claude a pointer and Codex, Gemini and Kimi the operator core, once', () => {
    for (const dir of [ensureAgentCwd(), ensureAgentConversationCwd('conv-1')]) {
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(OPERATOR_CWD_INSTRUCTIONS)
      for (const file of ['AGENTS.md', 'GEMINI.md', path.join('.kimi-code', 'AGENTS.md')]) {
        expect(fs.readFileSync(path.join(dir, file), 'utf-8')).toBe(buildOperatorSystemPrompt())
      }
    }
  })

  it('names exactly the providers that read their cwd instructions file', () => {
    expect(['claude', 'codex', 'gemini', 'kimi', 'local'].filter(providerLoadsOperatorCore)).toEqual(['codex', 'gemini', 'kimi'])
  })
})
