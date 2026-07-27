import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
vi.mock('../../context/RailPrDecisionContext', () => ({
  useRailPrDecisions: () => ({ decisions: new Map(), hydrated: true, act: mockAct, checkout: vi.fn() }),
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
      snapshot: {},
    }),
  }) as unknown as typeof fetch
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/review/del-1']}>
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
