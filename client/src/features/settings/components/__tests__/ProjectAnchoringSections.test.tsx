import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ProjectAnchoringSection, ProjectRulesSection } from '../ProjectAnchoringSections'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const jsonRes = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response
const INVENTORY = {
  supported: true, running: false, state: 'ok', file: '/p/.specrails/rules.json', modifiedAt: null,
  inventory: {
    generatedAt: '2026-11-10T09:00:00Z', dropped: 1,
    gates: [{ id: 'eslint', kind: 'lint', command: 'npm run lint' }],
    rules: [
      { id: 'r-a', index: 0, text: 'Frontend API calls use getApiBase()', source: 'AGENTS.md:92', status: 'automatable', enforcedBy: null, proposedCheck: 'ESLint rule' },
      { id: 'r-b', index: 1, text: 'Routes mount in order', source: null, status: 'enforcedBy', enforcedBy: 'route-order test', proposedCheck: null },
      { id: 'r-c', index: 2, text: 'Settings are a modal', source: 'AGENTS.md:101', status: 'humanOnly', enforcedBy: null, proposedCheck: null },
      { id: 'r-d', index: 3, text: 'Never log secrets', source: 'AGENTS.md:7', status: 'unclassified', enforcedBy: null, proposedCheck: null },
    ],
    counts: { automatable: 1, enforcedBy: 1, humanOnly: 1, unclassified: 1 },
    classification: { status: 'offline', provider: null, model: null, reason: 'init runs offline', classifiedAt: null },
  },
}

describe('ProjectAnchoringSection', () => {
  let patches: unknown[]
  let capabilities: Record<string, boolean>
  beforeEach(() => {
    vi.clearAllMocks()
    patches = []
    capabilities = { architectClarifications: true, specTrace: true, baselineOnTouch: false, rulesInventory: true }
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/core/phase3-capabilities')) return jsonRes(capabilities)
      if (url.endsWith('/settings') && init?.method === 'PATCH') { patches.push(JSON.parse(init.body as string)); return jsonRes({}) }
      return jsonRes({ jiraPostClarifications: false, baselineOnTouch: false })
    }) as unknown as typeof fetch
  })

  it('saves the Jira clarifications switch and disables the unsupported baseline switch', async () => {
    render(<ProjectAnchoringSection />)
    const jira = await screen.findByTestId('anchoring-jiraPostClarifications-switch')
    expect(screen.getByTestId('anchoring-baselineOnTouch-switch')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('anchoring-baselineOnTouch-unsupported')).toBeTruthy()
    fireEvent.click(jira)
    await waitFor(() => expect(patches).toEqual([{ jiraPostClarifications: true }]))
    expect(jira.getAttribute('aria-checked')).toBe('true')
    expect(toast.success).toHaveBeenCalled()
  })

  it('reverts the switch when saving fails', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/core/phase3-capabilities')) return jsonRes({ ...capabilities, baselineOnTouch: true })
      if (init?.method === 'PATCH') return jsonRes({}, false)
      return jsonRes({ jiraPostClarifications: false, baselineOnTouch: false })
    }) as unknown as typeof fetch
    render(<ProjectAnchoringSection />)
    const baseline = await screen.findByTestId('anchoring-baselineOnTouch-switch')
    fireEvent.click(baseline)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(baseline.getAttribute('aria-checked')).toBe('false')
  })
})

describe('ProjectRulesSection', () => {
  let posts: string[]
  beforeEach(() => {
    vi.clearAllMocks()
    posts = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        posts.push(url)
        if (url.endsWith('/rules/specs')) return jsonRes({ ticket: { id: 12 } }, true)
        return jsonRes({ ok: true, ...INVENTORY })
      }
      return jsonRes(INVENTORY)
    }) as unknown as typeof fetch
  })

  it('lists gates and rules by status and turns an automatable rule into a spec', async () => {
    render(<ProjectRulesSection />)
    expect(await screen.findByTestId('rules-gates')).toBeTruthy()
    expect(screen.getByText('npm run lint')).toBeTruthy()
    expect(screen.getByTestId('rules-humanOnly').textContent).toContain('Settings are a modal')
    expect(screen.getByTestId('rules-enforcedBy').textContent).toContain('Routes mount in order')
    expect(screen.getByTestId('rules-unclassified').textContent).toContain('Never log secrets')
    expect(screen.getByTestId('rules-classification').textContent).toContain('init runs offline')
    fireEvent.click(screen.getByTestId('rules-create-0'))
    expect(await screen.findByTestId('rules-created-0')).toBeTruthy()
    expect(posts).toEqual(['/api/projects/proj-1/rules/specs'])
    expect(toast.success).toHaveBeenCalled()
  })

  it('re-runs the inventory and reports a failure', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonRes({ ok: false, output: 'unknown command rules' }, false)
      return jsonRes({ supported: true, running: false, state: 'missing' })
    }) as unknown as typeof fetch
    render(<ProjectRulesSection />)
    expect(await screen.findByTestId('rules-missing')).toBeTruthy()
    fireEvent.click(screen.getByTestId('rules-rerun'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it('explains when Core does not support the inventory and shows an invalid file', async () => {
    global.fetch = vi.fn(async () => jsonRes({ supported: false, running: false, state: 'invalid', file: 'x', message: 'rules.json is not valid JSON' })) as unknown as typeof fetch
    render(<ProjectRulesSection />)
    expect(await screen.findByTestId('rules-unsupported')).toBeTruthy()
    expect(screen.getByTestId('rules-invalid')).toBeTruthy()
    expect(screen.getByTestId('rules-rerun')).toHaveProperty('disabled', true)
  })
})
