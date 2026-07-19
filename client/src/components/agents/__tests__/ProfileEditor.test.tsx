import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '../../../test-utils'
import { ProfileEditor } from '../ProfileEditor'
import type { Profile } from '../types'

function makeProfile(overrides?: Partial<Profile>): Profile {
  return {
    schemaVersion: 1,
    name: 'data-heavy',
    description: 'test profile',
    orchestrator: { model: 'sonnet' },
    agents: [
      { id: 'sr-architect', required: true },
      { id: 'sr-developer', required: true },
      { id: 'custom-data-engineer', model: 'sonnet' },
      { id: 'sr-reviewer', required: true },
      { id: 'sr-merge-resolver', required: true },
    ],
    routing: [{ default: true, agent: 'sr-developer' }],
    ...overrides,
  }
}

describe('ProfileEditor', () => {
  beforeEach(() => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ agents: [] }),
    } as Response)
  })

  it('does not flag untargeted custom agents when routing is empty', async () => {
    const onSoftWarningsChange = vi.fn()

    await act(async () => {
      render(
        <ProfileEditor
          profile={makeProfile({ routing: [] })}
          onChange={vi.fn()}
          onSoftWarningsChange={onSoftWarningsChange}
        />,
      )
    })

    await waitFor(() => {
      expect(onSoftWarningsChange).toHaveBeenCalled()
    })

    expect(onSoftWarningsChange).toHaveBeenLastCalledWith({ agentsMissingRouting: [] })
    expect(screen.queryByText(/untargeted agents in the chain/i)).not.toBeInTheDocument()
  })

  it('locks the default routing rule to sr-developer with no controls', async () => {
    await act(async () => {
      render(<ProfileEditor profile={makeProfile()} onChange={vi.fn()} />)
    })

    // No editable select for the default rule target — it renders as a read-only span.
    expect(screen.queryByRole('combobox', { name: /routing target/i })).not.toBeInTheDocument()
    // A "core · default" badge is rendered.
    expect(screen.getByText(/core · default/i)).toBeInTheDocument()
    // No edit / remove / reorder buttons for the default rule.
    expect(screen.queryByRole('button', { name: /edit rule 1/i })).not.toBeInTheDocument()
  })

  it('edits tags on a tag rule in place via the edit dialog', async () => {
    const onChange = vi.fn()
    const withTagRule = makeProfile({
      routing: [
        { tags: ['frontend'], agent: 'custom-data-engineer' },
        { default: true, agent: 'sr-developer' },
      ],
    })

    await act(async () => {
      render(<ProfileEditor profile={withTagRule} onChange={onChange} />)
    })

    fireEvent.click(screen.getByRole('button', { name: /edit rule 1/i }))
    fireEvent.change(screen.getByLabelText('Tags'), {
      target: { value: 'frontend, ui' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      routing: [
        { tags: ['frontend', 'ui'], agent: 'custom-data-engineer' },
        { default: true, agent: 'sr-developer' },
      ],
    })
  })

  it('renders a Kimi-bound profile with Kimi models and native commands', async () => {
    const kimiProfile = makeProfile({
      provider: 'kimi',
      orchestrator: { model: 'k3' },
      agents: [
        { id: 'sr-architect', model: 'k3', required: true },
        { id: 'sr-developer', model: 'k3', required: true },
        { id: 'sr-reviewer', model: 'k3', required: true },
      ],
    })
    await act(async () => {
      render(
        <ProfileEditor
          profile={kimiProfile}
          provider="kimi"
          modelCatalog={[
            { value: 'k3', label: 'Kimi K3' },
            { value: 'kimi-for-coding', label: 'Kimi for Coding' },
          ]}
          defaultModel="k3"
          customModelAliases
          baselineAgents={['sr-architect', 'sr-developer', 'sr-reviewer']}
          onChange={vi.fn()}
        />,
      )
    })

    expect(screen.getByText(/\/skill:specrails-implement.*\/skill:specrails-batch-implement/))
      .toBeInTheDocument()
    expect(screen.getByTestId('profile-orchestrator-model')).toHaveValue('k3')
    expect(screen.queryByDisplayValue('sonnet')).not.toBeInTheDocument()
  })

  it('preserves and edits a configured custom Kimi model alias exactly', async () => {
    const onChange = vi.fn()
    await act(async () => {
      render(
        <ProfileEditor
          profile={makeProfile({
            provider: 'kimi',
            orchestrator: { model: 'moonshot/team-alias' },
          })}
          provider="kimi"
          modelCatalog={[{ value: 'k3', label: 'Kimi K3' }]}
          defaultModel="k3"
          customModelAliases
          onChange={onChange}
        />,
      )
    })
    const input = screen.getByTestId('profile-orchestrator-model')
    expect(input).toHaveValue('moonshot/team-alias')
    fireEvent.change(input, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(input)
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      orchestrator: { model: 'Moonshot-Team/Private_Coder:v2' },
    })
  })
})
