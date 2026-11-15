import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpToolContext } from './types'

// `ci_fix` only asks the host to prepare the "Fix PR CI" card: the repository is
// resolved server-side, and nothing here launches a rail, job or run.
const { mockApiCall } = vi.hoisted(() => ({ mockApiCall: vi.fn() }))
vi.mock('./types', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  apiCall: mockApiCall,
  projectPath: (_ctx: unknown, projectId: string | undefined) => `/projects/${projectId ?? 'p1'}`,
}))

import { railsTools } from './rails'

const spec = railsTools()[0]
const ctx = (originConversationId: string | null) => ({ apiOrigin: 'http://127.0.0.1:0', masterToken: 't', activeProjectId: 'p1', originConversationId }) as unknown as McpToolContext
const PR_URL = 'https://github.com/acme/api/pull/7'

beforeEach(() => { mockApiCall.mockReset().mockResolvedValue({ admissionId: 'a1', state: 'offered' }) })

describe('specrails_rails ci_fix', () => {
  it('is a write action, never an ai-spawn', () => {
    expect((spec.tier as (args: Record<string, unknown>) => string)({ action: 'ci_fix' })).toBe('write')
    expect(spec.inputSchema).toHaveProperty('prUrl')
  })

  it('[spec:mission-pr-ci-repair/mission-prepares-a-ci-repair-offer-from-a-project-pr-url] posts only the PR URL and the mission to the pinned project\'s admission route', async () => {
    await spec.handler(ctx('mission-1'), { action: 'ci_fix', prUrl: PR_URL })
    expect(mockApiCall).toHaveBeenCalledTimes(1)
    expect(mockApiCall).toHaveBeenCalledWith(expect.anything(), 'POST', '/projects/p1/rails/pr-ci/admissions', { prUrl: PR_URL, originConversationId: 'mission-1' })
  })

  it('[spec:mission-pr-ci-repair/mission-prepares-a-ci-repair-offer-from-a-project-pr-url] targets the explicitly named project only', async () => {
    await spec.handler(ctx('mission-1'), { action: 'ci_fix', projectId: 'p2', prUrl: PR_URL })
    expect(mockApiCall).toHaveBeenCalledWith(expect.anything(), 'POST', '/projects/p2/rails/pr-ci/admissions', expect.anything())
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] does not launch anything and requires a URL', async () => {
    await expect(spec.handler(ctx('mission-1'), { action: 'ci_fix' })).rejects.toThrow(/prUrl/)
    expect(mockApiCall).not.toHaveBeenCalled()
  })
})
