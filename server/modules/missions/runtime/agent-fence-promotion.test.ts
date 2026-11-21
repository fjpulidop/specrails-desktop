import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { promoteAgentProtocolFences } from './agent-fence-promotion'

describe('generic-fence promotion for rail-launch', () => {
  it('re-tags a ```json launch-shaped object and leaves spec drafts alone', () => {
    const body = JSON.stringify({ ticketIds: [1], railIndex: 0 })
    expect(promoteAgentProtocolFences('```json\n' + body + '\n```')).toContain('```rail-launch\n')
    const draft = JSON.stringify({ title: 'T', description: 'D', labels: [], ticketIds: [1], mode: 'implement' })
    expect(promoteAgentProtocolFences('```json\n' + draft + '\n```')).toContain('```spec-draft\n')
    // flow-mode: the Intent-or-Implement offer is promoted by the same mirror.
    const offer = JSON.stringify({ idea: 'Prototype the onboarding', reason: 'Shape is uncertain', recommended: 'flow' })
    expect(promoteAgentProtocolFences('```json\n' + offer + '\n```')).toContain('```flow-offer\n')
    expect(promoteAgentProtocolFences('```json\n{"idea":"x","recommended":"maybe"}\n```')).not.toContain('```flow-offer')
  })
})

describe('client mirror parity', () => {
  it('client/src/features/missions/components/agent-fence-promotion.ts is byte-identical to the server copy', () => {
    const server = fs.readFileSync(path.join(__dirname, 'agent-fence-promotion.ts'), 'utf8')
    const client = fs.readFileSync(path.resolve(__dirname, '../../../../client/src/features/missions/components/agent-fence-promotion.ts'), 'utf8')
    expect(client).toBe(server)
  })
})
