import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReviewPacket, ReviewPacketResponse } from '../../types'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1', projects: [], isLoading: false, setActiveProjectId: vi.fn() }),
}))

vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const mockAct = vi.fn()
const mockCheckout = vi.fn()
vi.mock('../../context/RailPrDecisionContext', () => ({
  useRailPrDecisions: () => ({ decisions: new Map(), hydrated: true, act: mockAct, checkout: mockCheckout }),
}))

const mockOpenTicketDetail = vi.fn()
vi.mock('../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail: mockOpenTicketDetail, closeTicketDetail: vi.fn() }),
}))

const mockNotifyGitChanged = vi.fn()
vi.mock('../../lib/git-refresh', () => ({ notifyGitChanged: (id: string) => mockNotifyGitChanged(id) }))

import ReviewPacketPage from '../ReviewPacketPage'

function packet(over: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    schemaVersion: 1,
    prDeliveryId: 'del-1',
    railIndex: 0,
    variant: 'success',
    decision: 'on_review',
    statusCode: 'ready_for_review',
    headlineCode: 'headline.success',
    ticketIds: [1],
    baseBranch: 'main',
    loopName: 'Implement',
    prUrl: null,
    prNumber: null,
    succeededCount: 1,
    failedCount: 0,
    totalCount: 1,
    sections: [{
      ticketId: 1, title: 'Add login', problem: 'Nobody can log in.', solution: 'Added a login form.',
      labels: ['auth'], implementationOutcome: 'succeeded', deliveryOutcome: 'ready', changed: true,
      churn: { filesTouched: 2, addedLines: 40, removedLines: 3, testFilesTouched: ['a.test.ts'] },
      runIds: ['run-1'],
    }],
    proof: [
      { tier: 'app-verified', code: 'proof.filesChanged', values: { files: 2, added: 40, removed: 3 } },
      { tier: 'ai-reported', code: 'proof.verificationPassed', values: { count: 1 } },
      { tier: 'reviewer-score', code: 'proof.reviewerScore', values: { overall: 88 } },
    ],
    watchOut: [],
    confidence: { changeName: 'add-login', overall: 88, aspects: { security: 80 }, flags: [] },
    cost: { totalUsd: 2.5, estimated: false },
    evidenceUnavailable: false,
    runIds: ['run-1'],
    supersedesDeliveryId: null,
    revisionNote: null,
    versions: [{
      prDeliveryId: 'del-1', version: 1, revisionNote: null, decision: 'on_review',
      costUsd: 2.5, costEstimated: false, current: true,
    }],
    chainCostUsd: 2.5,
    chainCostEstimated: false,
    driftNudges: [],
    ...over,
  }
}

function respond(body: Partial<ReviewPacketResponse> & { packet?: ReviewPacket }, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({
      packet: body.packet ?? packet(),
      acceptCapability: body.acceptCapability ?? {
        target: 'create-pr', hasRemote: true, ghAuthenticated: true, irreversible: false, reasonCode: 'pr-capable',
      },
      snapshot: body.snapshot ?? {},
    }),
  }) as unknown as typeof fetch
}

function renderPage(entry = '/review/del-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/review/:prDeliveryId" element={<ReviewPacketPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// The stubbed fetch is GLOBAL: without restoring it, a later test file sharing
// this worker inherits the stub and its own data loads silently return packets.
const realFetch = globalThis.fetch
beforeEach(() => {
  vi.clearAllMocks()
  mockAct.mockResolvedValue({ status: 200, ok: true, decision: 'pr_draft' })
})
afterEach(() => { globalThis.fetch = realFetch })

describe('ReviewPacketPage — above the fold', () => {
  it('requests a revision of the grouped generation while reviewing an individual repository', async () => {
    respond({ packet: packet({ prDeliveryId: 'child-api' }), snapshot: {
      prDeliveryId: 'del-1', railIndex: 0, decision: 'on_review',
      executionManifest: { version: 1, groupId: 'del-1', projectId: 'proj-1', primaryRepositoryId: 'web', artifactRepositoryId: 'api', selectedRepositoryIds: ['web', 'api'], repositories: [] },
    } as ReviewPacketResponse['snapshot'] })
    renderPage('/review/del-1?repositoryId=api')
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    fireEvent.change(screen.getByTestId('packet-revision-input'), { target: { value: 'Fix the API contract across both repos' } })
    fireEvent.click(screen.getByTestId('packet-revision-submit'))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/proj-1/rails/0/launch', expect.objectContaining({
      body: JSON.stringify({ revisionOfDeliveryId: 'del-1', revisionNote: 'Fix the API contract across both repos', repositoryIds: ['web', 'api'] }),
    })))
  })

  it('leads with the verdict, the confidence pill and the cost', async () => {
    respond({})
    renderPage()
    expect(await screen.findByText('Your change is ready for review')).toBeInTheDocument()
    expect(screen.getByText('AI reviewer confidence 88/100')).toBeInTheDocument()
    expect(screen.getByText('This build cost $2.50')).toBeInTheDocument()
  })

  it('marks an estimated cost and shows an em-dash when unknown', async () => {
    respond({ packet: packet({ cost: { totalUsd: 1.5, estimated: true } }) })
    const { unmount } = renderPage()
    expect(await screen.findByText('This build cost ~$1.50')).toBeInTheDocument()
    unmount()

    respond({ packet: packet({ cost: { totalUsd: null, estimated: false } }) })
    renderPage()
    expect(await screen.findByText('This build cost —')).toBeInTheDocument()
  })

  it('says the reviewer score is unavailable rather than implying a good one', async () => {
    respond({ packet: packet({ confidence: null }) })
    renderPage()
    expect(await screen.findByText('No reviewer score')).toBeInTheDocument()
  })
})

describe('ReviewPacketPage — repository evidence identity', () => {
  function mockPacketFetch(...responses: Array<Response | (() => Promise<Response>)>) {
    const next = vi.fn()
    for (const response of responses) next.mockImplementationOnce(typeof response === 'function' ? response : async () => response)
    globalThis.fetch = vi.fn((url) => String(url).includes('/packet') ? next() : Promise.resolve({ ok: true, status: 200, json: async () => ({ chains: [] }) } as Response))
    return next
  }

  function responseFor(repositoryId: string, headline = `${repositoryId} evidence`): Response {
    return { ok: true, status: 200, json: async () => ({
      packet: packet({ prDeliveryId: `child-${repositoryId}`, headlineCode: headline }),
      acceptCapability: { target: 'create-pr', hasRemote: true, ghAuthenticated: true, irreversible: false, reasonCode: 'pr-capable' },
      snapshot: { prDeliveryId: 'del-1', railIndex: 0, decision: 'on_review', repositoryDeliveries: ['web', 'api'].map((id) => ({
        repositoryId: id, deliveryId: `child-${id}`, name: id, path: `/tmp/${id}`,
        decision: 'on_review', implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        branch: `feature-${id}`, baseBranch: 'main', deliverySha: 'a'.repeat(40),
      })) },
    }) } as Response
  }

  it('hides the previous repository evidence and all actions until the selected repository loads', async () => {
    let finishApi!: (response: Response) => void
    const requests = mockPacketFetch(responseFor('web'), () => new Promise<Response>((resolve) => { finishApi = resolve }))
    renderPage('/review/del-1?repositoryId=web')
    expect(await screen.findByText('web evidence')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'api' } })
    expect(screen.queryByText('web evidence')).not.toBeInTheDocument()
    expect(screen.queryByTestId('packet-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('repository-deliveries')).not.toBeInTheDocument()
    expect(mockAct).not.toHaveBeenCalled()
    expect(mockCheckout).not.toHaveBeenCalled()
    await act(async () => { finishApi(responseFor('api')) })
    expect(await screen.findByText('api evidence')).toBeInTheDocument()
    // Keep the post-action refresh pending so the test only checks the dispatch.
    requests.mockImplementationOnce(() => new Promise<Response>(() => {}))
    await act(async () => { fireEvent.click(screen.getByTestId('packet-accept')) })
    expect(mockAct).toHaveBeenCalledWith(0, 'create-pr', 'on_review', 'del-1', 'api')
  })

  it('does not let a late action reload or invalidate the next repository request', async () => {
    let finishAction!: (value: { status: number; ok: boolean }) => void
    let finishApi!: (response: Response) => void
    mockAct.mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve }))
    const requests = mockPacketFetch(responseFor('web'), () => new Promise<Response>((resolve) => { finishApi = resolve }))
    renderPage('/review/del-1?repositoryId=web')
    fireEvent.click(await screen.findByTestId('packet-accept'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'api' } })
    await act(async () => { finishAction({ status: 200, ok: true }) })
    expect(requests).toHaveBeenCalledTimes(2)
    await act(async () => { finishApi(responseFor('api')) })
    expect(await screen.findByText('api evidence')).toBeInTheDocument()
    expect(screen.queryByText('web evidence')).not.toBeInTheDocument()
  })

  it('ignores an old action after leaving and returning to the same repository', async () => {
    let finishAction!: (value: { status: number; ok: boolean }) => void
    let finishNewWeb!: (response: Response) => void
    mockAct.mockImplementationOnce(() => new Promise((resolve) => { finishAction = resolve }))
    const requests = mockPacketFetch(responseFor('web'), responseFor('api'), () => new Promise<Response>((resolve) => { finishNewWeb = resolve }))
    renderPage('/review/del-1?repositoryId=web')
    fireEvent.click(await screen.findByTestId('packet-accept'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'api' } })
    await screen.findByText('api evidence')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'web' } })
    await act(async () => { finishAction({ status: 200, ok: true }) })
    expect(requests).toHaveBeenCalledTimes(3)
    await act(async () => { finishNewWeb(responseFor('web', 'current web evidence')) })
    expect(await screen.findByText('current web evidence')).toBeInTheDocument()
    expect(mockNotifyGitChanged).not.toHaveBeenCalled()
  })
})

describe('ReviewPacketPage — decision verbs', () => {
  it('offers Accept as opening a pull request when GitHub is available', async () => {
    respond({})
    renderPage()
    expect(await screen.findByTestId('packet-accept')).toHaveTextContent('Accept and open a pull request')
    expect(screen.getByTestId('packet-discard')).toBeInTheDocument()
  })

  it('executes create-pr through the shared decision caller', async () => {
    respond({})
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-accept'))
    await waitFor(() => expect(mockAct).toHaveBeenCalledWith(0, 'create-pr', 'on_review', 'del-1'))
    await waitFor(() => expect(mockNotifyGitChanged).toHaveBeenCalledWith('proj-1'))
  })

  it('never merges into the checkout without an explicit irreversibility confirm', async () => {
    respond({
      acceptCapability: {
        target: 'merge-local', hasRemote: false, ghAuthenticated: false, irreversible: true, reasonCode: 'no-remote',
      },
    })
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-accept'))
    // First click only reveals the consequence — no POST yet.
    expect(mockAct).not.toHaveBeenCalled()
    expect(screen.getByText(/writes the changes directly into your project/i)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('packet-accept-confirm'))
    await waitFor(() => expect(mockAct).toHaveBeenCalledWith(0, 'merge-local', 'on_review', 'del-1'))
  })

  it('lets the user back out of the irreversible confirm', async () => {
    respond({
      acceptCapability: {
        target: 'merge-local', hasRemote: false, ghAuthenticated: false, irreversible: true, reasonCode: 'no-remote',
      },
    })
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-accept'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(mockAct).not.toHaveBeenCalled()
    expect(screen.getByTestId('packet-accept')).toBeInTheDocument()
  })

  it('renders a neutral message when another surface already answered', async () => {
    respond({})
    mockAct.mockResolvedValue({ status: 409, ok: false, error: 'stale_decision' })
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-discard'))
    expect(await screen.findByText('Someone already answered this.')).toBeInTheDocument()
  })

  it('reports a failed action without pretending it worked', async () => {
    respond({})
    mockAct.mockResolvedValue({ status: 502, ok: false, error: 'gh failed' })
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-discard'))
    expect(await screen.findByText('That action did not go through.')).toBeInTheDocument()
    expect(mockNotifyGitChanged).not.toHaveBeenCalled()
  })

  it('does not confuse a safety conflict with an already answered decision', async () => {
    respond({})
    mockAct.mockResolvedValue({ status: 409, ok: false, error: 'delivery_not_verified' })
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-discard'))
    expect(await screen.findByText('That action did not go through.')).toBeInTheDocument()
    expect(screen.queryByText('Someone already answered this.')).not.toBeInTheDocument()
  })

  it('defers to the technical controls for a state the verbs cannot describe', async () => {
    respond({
      packet: packet({
        decision: 'pr_failed', statusCode: 'push_failed', variant: 'success',
      }),
    })
    renderPage()
    expect(await screen.findByText(/needs a technical decision/i)).toBeInTheDocument()
    expect(screen.queryByTestId('packet-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('packet-discard')).not.toBeInTheDocument()
  })

  it('shows a working state instead of verbs while the run is still building', async () => {
    respond({ packet: packet({ decision: 'building', statusCode: 'implementation_running' }) })
    renderPage()
    expect(await screen.findByText('Still working on this…')).toBeInTheDocument()
    expect(screen.queryByTestId('packet-accept')).not.toBeInTheDocument()
  })

  it('offers acknowledge-not-discard on a nothing-changed delivery', async () => {
    respond({
      packet: packet({
        decision: 'no_changes', statusCode: 'no_changes', variant: 'no-changes',
        headlineCode: 'headline.noChanges',
      }),
    })
    renderPage()
    expect(await screen.findByText('Nothing needed changing')).toBeInTheDocument()
    expect(screen.getByTestId('packet-accept')).toHaveTextContent('Accept — nothing to change')
    expect(screen.queryByTestId('packet-discard')).not.toBeInTheDocument()
  })
})

describe('ReviewPacketPage — proof presentation', () => {
  it('labels each tier with its provenance caveat', async () => {
    respond({})
    renderPage()
    fireEvent.click(await screen.findByText('How it was checked'))
    expect(screen.getByText('Measured by Specrails')).toBeInTheDocument()
    expect(screen.getByText('Reported by the AI')).toBeInTheDocument()
    expect(screen.getByText(/Specrails did not run these checks itself/i)).toBeInTheDocument()
    expect(screen.getByText("AI reviewer's self-assessment")).toBeInTheDocument()
  })

  it('shows agent output only inside a labelled raw block', async () => {
    respond({
      packet: packet({
        proof: [{ tier: 'ai-reported', code: 'proof.verifyOutput', rawExcerpt: 'Tests 6818 passed' }],
      }),
    })
    renderPage()
    fireEvent.click(await screen.findByText('How it was checked'))
    expect(screen.getByText('Tests 6818 passed').tagName).toBe('PRE')
  })

  it('flags evidence as unavailable on the section header', async () => {
    respond({ packet: packet({ evidenceUnavailable: true }) })
    renderPage()
    expect(await screen.findByText('evidence unavailable')).toBeInTheDocument()
  })

  it('renders the watch-out block only when there is something real to say', async () => {
    respond({})
    const { unmount } = renderPage()
    await screen.findByText('Your change is ready for review')
    expect(screen.queryByText('Worth a look before you accept')).not.toBeInTheDocument()
    unmount()

    respond({
      packet: packet({
        watchOut: [{ tier: 'reviewer-score', code: 'watch.humanReviewRecommended', values: { overall: 55 } }],
      }),
    })
    renderPage()
    expect(await screen.findByText('Worth a look before you accept')).toBeInTheDocument()
    expect(screen.getByText(/recommends a person look at it/i)).toBeInTheDocument()
  })
})

describe('ReviewPacketPage — sections', () => {
  it('opens the ticket modal from the what-you-asked chip', async () => {
    respond({})
    renderPage()
    fireEvent.click(await screen.findByText(/#1 Add login/))
    expect(mockOpenTicketDetail).toHaveBeenCalledWith(1)
  })

  it('states plainly when batch churn cannot be split per request', async () => {
    respond({
      packet: packet({
        sections: [{
          ticketId: 1, title: 'A', problem: null, solution: 'did it', labels: [],
          implementationOutcome: 'succeeded', deliveryOutcome: 'ready', changed: true,
          churn: null, runIds: ['run-1'],
        }],
      }),
    })
    renderPage()
    fireEvent.click(await screen.findByText('What was done'))
    expect(screen.getByText(/not per request/i)).toBeInTheDocument()
  })
})

describe('ReviewPacketPage — failures', () => {
  it('explains a missing review rather than rendering an empty page', async () => {
    respond({}, 404)
    renderPage()
    expect(await screen.findByText('This review could not be found.')).toBeInTheDocument()
  })

  it('survives a network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    renderPage()
    expect(await screen.findByText('The review could not be loaded.')).toBeInTheDocument()
  })

  it('navigates back to the board', async () => {
    respond({})
    renderPage()
    fireEvent.click(await screen.findByText('Back to the board'))
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })
})

describe('ReviewPacketPage — ask for changes (Wave 3)', () => {
  function fetchSpy() {
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (String(url).includes('/launch')) {
        return { ok: true, status: 202, json: async () => ({ jobIds: ['run-2'] }) } as unknown as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          packet: packet(),
          acceptCapability: { target: 'create-pr', hasRemote: true, ghAuthenticated: true, irreversible: false, reasonCode: 'pr-capable' },
          snapshot: {},
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    return calls
  }

  it('launches a revision carrying the sentence, scoped to this delivery', async () => {
    const calls = fetchSpy()
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    fireEvent.change(screen.getByTestId('packet-revision-input'), { target: { value: 'make it blue' } })
    fireEvent.click(screen.getByTestId('packet-revision-submit'))

    await waitFor(() => {
      const launch = calls.find((c) => c.url.includes('/launch'))
      expect(launch?.body).toEqual({ revisionOfDeliveryId: 'del-1', revisionNote: 'make it blue' })
    })
  })

  it('will not send an empty change request', async () => {
    fetchSpy()
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    expect(screen.getByTestId('packet-revision-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('packet-revision-input'), { target: { value: '   ' } })
    expect(screen.getByTestId('packet-revision-submit')).toBeDisabled()
  })

  it('keeps the typed text when the launch fails', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/launch')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as unknown as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          packet: packet(),
          acceptCapability: { target: 'create-pr', hasRemote: true, ghAuthenticated: true, irreversible: false, reasonCode: 'pr-capable' },
          snapshot: {},
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    fireEvent.change(screen.getByTestId('packet-revision-input'), { target: { value: 'make it blue' } })
    fireEvent.click(screen.getByTestId('packet-revision-submit'))
    expect(await screen.findByText(/Your text was kept/i)).toBeInTheDocument()
    expect(screen.getByTestId('packet-revision-input')).toHaveValue('make it blue')
  })

  it('explains a raced resolution instead of a generic failure', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/launch')) {
        return { ok: false, status: 409, json: async () => ({ error: 'invalid_revision_target' }) } as unknown as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          packet: packet(),
          acceptCapability: { target: 'create-pr', hasRemote: true, ghAuthenticated: true, irreversible: false, reasonCode: 'pr-capable' },
          snapshot: {},
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    fireEvent.change(screen.getByTestId('packet-revision-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('packet-revision-submit'))
    expect(await screen.findByText(/just resolved elsewhere/i)).toBeInTheDocument()
  })

  it('promises no duration (nothing measured yet)', async () => {
    fetchSpy()
    renderPage()
    fireEvent.click(await screen.findByTestId('packet-request-changes'))
    const hint = screen.getByText(/does not start over/i)
    expect(hint.textContent).not.toMatch(/\d+\s*(min|minute)/i)
  })
})

describe('ReviewPacketPage — version lineage and drift (Wave 3)', () => {
  it('hides the version section for an unrevised delivery', async () => {
    respond({})
    renderPage()
    await screen.findByText('Your change is ready for review')
    expect(screen.queryByTestId('packet-versions')).not.toBeInTheDocument()
  })

  it('renders the chain with each instruction and the cumulative cost', async () => {
    respond({
      packet: packet({
        revisionNote: 'and bigger',
        versions: [
          { prDeliveryId: 'd1', version: 1, revisionNote: null, decision: 'superseded', costUsd: 2, costEstimated: false, current: false },
          { prDeliveryId: 'd2', version: 2, revisionNote: 'make it blue', decision: 'superseded', costUsd: 0.5, costEstimated: false, current: false },
          { prDeliveryId: 'd3', version: 3, revisionNote: 'and bigger', decision: 'on_review', costUsd: 0.4, costEstimated: true, current: true },
        ],
        chainCostUsd: 2.9,
        chainCostEstimated: true,
      }),
    })
    renderPage()
    fireEvent.click(await screen.findByText('Earlier versions (3)'))
    expect(screen.getByText('The original build.')).toBeInTheDocument()
    expect(screen.getByText('make it blue')).toBeInTheDocument()
    expect(screen.getByText("you're looking at this one")).toBeInTheDocument()
    expect(screen.getByText('All versions together: ~$2.90')).toBeInTheDocument()
  })

  it('shows drift nudges with their real numbers, as advice', async () => {
    respond({
      packet: packet({
        driftNudges: [
          { code: 'drift.costShare', values: { revisions: 2, revisionCost: '2.10', originalCost: '4.00', share: 53 } },
        ],
      }),
    })
    renderPage()
    expect(await screen.findByTestId('packet-drift-nudges')).toBeInTheDocument()
    expect(screen.getByText(/2.10/)).toBeInTheDocument()
    expect(screen.getByText(/Only a suggestion/i)).toBeInTheDocument()
    // Advisory only: the change request stays available.
    expect(screen.getByTestId('packet-request-changes')).toBeEnabled()
  })

  it('renders no drift block when nothing drifted', async () => {
    respond({})
    renderPage()
    await screen.findByText('Your change is ready for review')
    expect(screen.queryByTestId('packet-drift-nudges')).not.toBeInTheDocument()
  })
})
