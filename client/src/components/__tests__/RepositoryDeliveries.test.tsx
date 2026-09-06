import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '../../test-utils'
import { RepositoryDeliveries } from '../RepositoryDeliveries'
import type { RepositoryDeliverySnapshot } from '../../types/multi-repo'
import { coerceRailPrStateSnapshot } from '../../lib/pr-delivery'

function member(repositoryId: string, over: Partial<RepositoryDeliverySnapshot> = {}): RepositoryDeliverySnapshot {
  return { repositoryId, name: repositoryId, path: `/repos/${repositoryId}`, deliveryId: `child-${repositoryId}`,
    baseBranch: 'previous-chunk', integrationBranch: 'main', branch: 'implementation', deliverySha: 'a'.repeat(40),
    decision: 'on_review', implementationOutcome: 'succeeded', deliveryOutcome: 'ready', statusCode: null,
    statusDetail: null, prUrl: null, prNumber: null, runIds: [], worktreeIds: [], ...over }
}

describe('grouped repository delivery controls', () => {
  it('reopens or retries a PR only for the selected repository', () => {
    const onAct = vi.fn().mockResolvedValue({ ok: true })
    render(<RepositoryDeliveries deliveryId="parent" repositories={[
      member('web', { decision: 'pr_closed', prUrl: 'https://github.com/test/web/pull/1', prNumber: 1 }),
      member('api', { decision: 'pr_failed', deliveryOutcome: 'retryable_failure', prUrl: 'https://github.com/test/api/pull/2', prNumber: 2 }),
    ]} busy={false} onAct={onAct} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'web' })).getByRole('button', { name: /reopen/i }))
    expect(onAct).toHaveBeenCalledWith('reopen', 'web')
    fireEvent.click(within(screen.getByRole('region', { name: 'api' })).getByRole('button', { name: /retry push/i }))
    expect(onAct).toHaveBeenCalledWith('create-pr', 'api')
  })

  it('keeps repository identity for checkout and PR creation while an accepted member stays read-only', () => {
    const onAct = vi.fn().mockResolvedValue({ ok: true }); const onCheckout = vi.fn().mockResolvedValue({ ok: true })
    render(<RepositoryDeliveries deliveryId="parent" repositories={[member('web', { decision: 'merged' }), member('api')]} busy={false} onAct={onAct} onCheckout={onCheckout} />)
    expect(within(screen.getByRole('region', { name: 'web' })).queryByRole('button')).toBeNull()
    const api = within(screen.getByRole('region', { name: 'api' }))
    fireEvent.click(api.getByRole('button', { name: /check\s?out/i }))
    expect(onCheckout).toHaveBeenCalledWith('api')
    fireEvent.click(api.getByRole('button', { name: /create.*PR/i }))
    expect(onAct).toHaveBeenCalledWith('create-pr', 'api')
    expect(api.getByText('implementation → main')).toBeInTheDocument()
  })

  it('confirms the actual integration destination and drops stale generation confirmations', () => {
    const onAct = vi.fn().mockResolvedValue({ ok: true })
    const repositories = [member('api')]
    const view = render(<RepositoryDeliveries deliveryId="parent-1" repositories={repositories} busy={false} onAct={onAct} />)
    fireEvent.click(screen.getByRole('button', { name: /integrate locally|merge locally/i }))
    expect(within(screen.getByRole('dialog')).getByText(/main/)).toBeInTheDocument()
    expect(onAct).not.toHaveBeenCalled()
    view.rerender(<RepositoryDeliveries deliveryId="parent-2" repositories={repositories} busy={false} onAct={onAct} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /integrate locally|merge locally/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /confirm/i }))
    expect(onAct).toHaveBeenCalledWith('merge-local', 'api')
  })

  it('offers recovery only for blocked members and prevents clicks while another operation holds the group', () => {
    const onAct = vi.fn().mockResolvedValue({ ok: true })
    const repository = member('api', { deliveryOutcome: 'blocked', statusDetail: 'The branch moved' })
    const view = render(<RepositoryDeliveries deliveryId="parent" repositories={[repository]} busy={true} onAct={onAct} />)
    expect(screen.getByText('The branch moved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /create.*PR/i })).toBeNull()
    view.rerender(<RepositoryDeliveries deliveryId="parent" repositories={[repository]} busy={false} onAct={onAct} />)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onAct).toHaveBeenCalledWith('recover-and-retry', 'api')
  })

  it('preserves repository destinations and a checkout lease when snapshots cross HTTP and card hydration', () => {
    const snapshot = coerceRailPrStateSnapshot({ prDeliveryId: 'parent', railIndex: 0, decision: 'on_review',
      operation: 'checkout', repositoryDeliveries: [member('api'), { repositoryId: 'malformed' }] })
    expect(snapshot?.operation).toBe('checkout')
    expect(snapshot?.repositoryDeliveries).toHaveLength(1)
    expect(snapshot?.repositoryDeliveries?.[0]).toMatchObject({ repositoryId: 'api', integrationBranch: 'main', deliverySha: 'a'.repeat(40) })
  })
})
