import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Every project agent spawn path must build its base environment through the
// shared project builder, so `minimal` cannot be bypassed by one surface.
const ROOT = path.resolve(__dirname, '../../../..')
const SPAWN_PATHS = [
  'server/modules/execution/runtime/queue-manager.ts',
  'server/project-registry.ts',
  'server/modules/agent-runtime/runtime/agent-runtime-controls.ts',
  'server/modules/missions/runtime/agent-chat-manager.ts',
  'server/index.ts',
  'server/modules/conversations/runtime/chat-manager.ts',
  'server/modules/specs/runtime/spec-launcher-manager.ts',
  'server/modules/specs/runtime/proposal-manager.ts',
  'server/modules/specs/runtime/contract-refine-runner.ts',
  'server/modules/specs/runtime/smash-runner.ts',
  'server/modules/agents/runtime/agent-refine-manager.ts',
  'server/project-router-tickets.ts',
]

describe('agent environment builder coverage', () => {
  for (const file of SPAWN_PATHS) {
    it(`${file} resolves its agent env through the project builder`, () => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(source).toMatch(/\b(resolveProjectAgentEnv|projectAgentSourceEnv)\(/)
    })
  }

  it('no spawn path still passes the raw passthrough overlay as an agent base env', () => {
    for (const file of SPAWN_PATHS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      // The warning helper may still read the passthrough overlay; spawn envs may not.
      const offending = source.split('\n').filter(line => line.includes('applyWorktreeEnvPassthrough(') && !line.includes('worktreeEnvPassthroughWarning('))
      expect(offending, file).toEqual([])
    }
  })
})
