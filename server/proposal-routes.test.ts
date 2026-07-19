import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock command-resolver to always return a resolved prompt (command exists)
vi.mock('./command-resolver', () => ({
  resolveCommand: vi.fn(() => 'Resolved prompt for testing'),
}))

// Mock config module
vi.mock('./config', () => ({
  getConfig: vi.fn().mockReturnValue({
    project: { name: 'test-project', repo: 'owner/test-project' },
    issueTracker: {
      github: { available: true, authenticated: true },
      jira: { available: false, authenticated: false },
      active: 'github',
      labelFilter: '',
    },
    commands: [],
  }),
  fetchIssues: vi.fn().mockReturnValue([]),
}))

// Mock QueueManager
vi.mock('./queue-manager', async () => {
  const ClaudeNotFoundError = class extends Error {
    constructor() { super('claude binary not found'); this.name = 'ClaudeNotFoundError' }
  }
  const JobNotFoundError = class extends Error {
    constructor() { super('Job not found'); this.name = 'JobNotFoundError' }
  }
  const JobAlreadyTerminalError = class extends Error {
    constructor() { super('Job is already in terminal state'); this.name = 'JobAlreadyTerminalError' }
  }
  const QueueManager = vi.fn(function () {
    return {
      enqueue: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      reorder: vi.fn(),
      getJobs: vi.fn().mockReturnValue([]),
      getActiveJobId: vi.fn().mockReturnValue(null),
      isPaused: vi.fn().mockReturnValue(false),
      getLogBuffer: vi.fn().mockReturnValue([]),
      phasesForCommand: vi.fn().mockReturnValue([]),
      setCommands: vi.fn(),
    }
  })
  return { QueueManager, ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError }
})

// Mock ChatManager
vi.mock('./chat-manager', () => ({
  ChatManager: vi.fn(function () {
    return {
      isActive: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      abort: vi.fn(),
    }
  }),
}))

// Mock SetupManager
vi.mock('./setup-manager', () => ({
  SetupManager: vi.fn(function () {
    return {
      isInstalling: vi.fn().mockReturnValue(false),
      isSettingUp: vi.fn().mockReturnValue(false),
      startInstall: vi.fn(),
      startSetup: vi.fn(),
      resumeSetup: vi.fn(),
      abort: vi.fn(),
      getCheckpointStatus: vi.fn().mockReturnValue([]),
    }
  }),
}))

// Mock ProposalManager — will be the mock instance
let mockProposalManagerInstance: {
  isActive: ReturnType<typeof vi.fn>
  canStartExploration: ReturnType<typeof vi.fn>
  startExploration: ReturnType<typeof vi.fn>
  sendRefinement: ReturnType<typeof vi.fn>
  createIssue: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

vi.mock('./proposal-manager', () => {
  const ProposalManager = vi.fn(function () {
    mockProposalManagerInstance = {
      isActive: vi.fn().mockReturnValue(false),
      canStartExploration: vi.fn().mockReturnValue(true),
      startExploration: vi.fn().mockResolvedValue(undefined),
      sendRefinement: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
    }
    return mockProposalManagerInstance
  })
  return { ProposalManager }
})

import express from 'express'
import { initDb, createProposal, updateProposal } from './db'
import { createProjectRouter } from './project-router'
import { ProjectRegistry } from './project-registry'
import type { DbInstance } from './db'

function createTestApp() {
  const broadcast = vi.fn()
  const db = initDb(':memory:')

  // Register a fake project in the desktop DB
  const registry = new ProjectRegistry(broadcast)

  // Manually add a context by calling addProject with a fake path
  const projectId = 'test-proj-001'

  // Inject a fake context directly by accessing the private map via casting
  const fakeCtx = {
    project: {
      id: projectId,
      slug: 'test-project',
      name: 'Test Project',
      path: '/fake/path',
      db_path: ':memory:',
      added_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    db,
    queueManager: {
      enqueue: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      reorder: vi.fn(),
      getJobs: vi.fn().mockReturnValue([]),
      getActiveJobId: vi.fn().mockReturnValue(null),
      isPaused: vi.fn().mockReturnValue(false),
      getLogBuffer: vi.fn().mockReturnValue([]),
      phasesForCommand: vi.fn().mockReturnValue([]),
      setCommands: vi.fn(),
    },
    chatManager: {
      isActive: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      abort: vi.fn(),
    },
    setupManager: {
      isInstalling: vi.fn().mockReturnValue(false),
      isSettingUp: vi.fn().mockReturnValue(false),
      startInstall: vi.fn(),
      startSetup: vi.fn(),
      resumeSetup: vi.fn(),
      abort: vi.fn(),
      getCheckpointStatus: vi.fn().mockReturnValue([]),
    },
    proposalManager: mockProposalManagerInstance,
    broadcast: vi.fn(),
  }

  // Patch registry to return our fake context
  ;(registry as any)._contexts = new Map([[projectId, fakeCtx]])

  const projectRouter = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectRouter)

  return { app, db, projectId, proposalManager: mockProposalManagerInstance }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Proposal API routes', () => {
  let app: express.Express
  let db: DbInstance
  let projectId: string
  let proposalManager: typeof mockProposalManagerInstance
  let request: any

  beforeEach(async () => {
    vi.clearAllMocks()

    // ProposalManager mock needs to be initialized — trigger it
    const { ProposalManager } = await import('./proposal-manager')
    new ProposalManager(vi.fn(), initDb(':memory:'), '/test')

    const created = createTestApp()
    app = created.app
    db = created.db
    projectId = created.projectId
    proposalManager = created.proposalManager

    const mod = await import('supertest')
    request = mod.default
  })

  // ─── POST /:projectId/propose ─────────────────────────────────────────────

  describe('POST /:projectId/propose', () => {
    it('returns 202 with proposalId', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/propose`)
        .send({ idea: 'Add dark mode support' })

      expect(res.status).toBe(202)
      expect(res.body.proposalId).toBeDefined()
      expect(typeof res.body.proposalId).toBe('string')
    })

    it('returns 400 when idea is missing', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/propose`)
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('idea is required')
    })

    it('returns 400 when idea is empty string', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/propose`)
        .send({ idea: '   ' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('idea is required')
    })

    it('creates a proposal row in DB', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/propose`)
        .send({ idea: 'New feature idea' })

      expect(res.status).toBe(202)
      const { getProposal: gp } = await import('./db')
      const row = gp(db, res.body.proposalId)
      expect(row).toBeDefined()
      expect(row!.idea).toBe('New feature idea')
    })

    it('calls proposalManager.startExploration', async () => {
      await request(app)
        .post(`/api/projects/${projectId}/propose`)
        .send({ idea: 'Some idea' })

      // Wait for async to complete
      await new Promise((r) => setTimeout(r, 10))
      expect(proposalManager.startExploration).toHaveBeenCalledOnce()
    })
  })

  // ─── GET /:projectId/propose/:id ─────────────────────────────────────────

  describe('GET /:projectId/propose/:id', () => {
    it('returns 200 with proposal row', async () => {
      createProposal(db, { id: 'p-get-1', idea: 'Get test idea' })

      const res = await request(app)
        .get(`/api/projects/${projectId}/propose/p-get-1`)

      expect(res.status).toBe(200)
      expect(res.body.proposal.id).toBe('p-get-1')
      expect(res.body.proposal.idea).toBe('Get test idea')
    })

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/propose/nonexistent`)

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Proposal not found')
    })
  })

  // ─── GET /:projectId/propose ─────────────────────────────────────────────

  describe('GET /:projectId/propose', () => {
    it('returns list of proposals', async () => {
      createProposal(db, { id: 'p-list-1', idea: 'Idea A' })
      createProposal(db, { id: 'p-list-2', idea: 'Idea B' })

      const res = await request(app)
        .get(`/api/projects/${projectId}/propose`)

      expect(res.status).toBe(200)
      expect(res.body.total).toBeGreaterThanOrEqual(2)
      expect(Array.isArray(res.body.proposals)).toBe(true)
    })

    it('respects limit and offset params', async () => {
      for (let i = 1; i <= 5; i++) {
        createProposal(db, { id: `p-page-${i}`, idea: `Idea ${i}` })
      }

      const res = await request(app)
        .get(`/api/projects/${projectId}/propose?limit=2&offset=0`)

      expect(res.status).toBe(200)
      expect(res.body.proposals.length).toBe(2)
    })
  })

  // ─── POST /:projectId/propose/:id/refine ─────────────────────────────────

  describe('POST /:projectId/propose/:id/refine', () => {
    it('returns 202 when proposal is in review status', async () => {
      createProposal(db, { id: 'p-refine-1', idea: 'Idea to refine' })
      updateProposal(db, 'p-refine-1', { status: 'review', session_id: 'sess-r1' })

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-refine-1/refine`)
        .send({ feedback: 'Make it simpler' })

      expect(res.status).toBe(202)
      expect(res.body.ok).toBe(true)
    })

    it('returns 404 for unknown proposal', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/nonexistent/refine`)
        .send({ feedback: 'Feedback' })

      expect(res.status).toBe(404)
    })

    it('returns 409 when proposal is busy', async () => {
      createProposal(db, { id: 'p-refine-busy', idea: 'Busy idea' })
      updateProposal(db, 'p-refine-busy', { status: 'review' })
      proposalManager.isActive.mockReturnValue(true)

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-refine-busy/refine`)
        .send({ feedback: 'Some feedback' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('PROPOSAL_BUSY')
    })

    it('returns 409 when proposal is not in review status', async () => {
      createProposal(db, { id: 'p-refine-input', idea: 'Not in review' })
      // status defaults to 'input'

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-refine-input/refine`)
        .send({ feedback: 'Some feedback' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Proposal is not in review state')
    })

    it('returns 400 when feedback is empty', async () => {
      createProposal(db, { id: 'p-refine-empty', idea: 'Some idea' })
      updateProposal(db, 'p-refine-empty', { status: 'review' })

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-refine-empty/refine`)
        .send({ feedback: '' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('feedback is required')
    })
  })

  // ─── POST /:projectId/propose/:id/create-issue ───────────────────────────

  describe('POST /:projectId/propose/:id/create-issue', () => {
    it('returns 202 when proposal is in review status', async () => {
      createProposal(db, { id: 'p-issue-1', idea: 'Issue idea' })
      updateProposal(db, 'p-issue-1', { status: 'review', session_id: 'sess-i1' })

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-issue-1/create-issue`)

      expect(res.status).toBe(202)
      expect(res.body.ok).toBe(true)
    })

    it('returns 409 when proposal is busy', async () => {
      createProposal(db, { id: 'p-issue-busy', idea: 'Busy issue' })
      updateProposal(db, 'p-issue-busy', { status: 'review' })
      proposalManager.isActive.mockReturnValue(true)

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-issue-busy/create-issue`)

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('PROPOSAL_BUSY')
    })

    it('returns 409 when not in review status', async () => {
      createProposal(db, { id: 'p-issue-input', idea: 'Not ready' })
      // status is 'input'

      const res = await request(app)
        .post(`/api/projects/${projectId}/propose/p-issue-input/create-issue`)

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('Proposal is not in review state')
    })
  })

  // ─── DELETE /:projectId/propose/:id ──────────────────────────────────────

  describe('DELETE /:projectId/propose/:id', () => {
    it('returns 200 ok', async () => {
      createProposal(db, { id: 'p-del-1', idea: 'Delete this' })

      const res = await request(app)
        .delete(`/api/projects/${projectId}/propose/p-del-1`)

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('returns 404 for unknown proposal', async () => {
      const res = await request(app)
        .delete(`/api/projects/${projectId}/propose/nonexistent`)

      expect(res.status).toBe(404)
    })

    it('calls proposalManager.cancel', async () => {
      createProposal(db, { id: 'p-del-2', idea: 'Cancel this' })

      await request(app)
        .delete(`/api/projects/${projectId}/propose/p-del-2`)

      expect(proposalManager.cancel).toHaveBeenCalledWith('p-del-2')
    })
  })
})
