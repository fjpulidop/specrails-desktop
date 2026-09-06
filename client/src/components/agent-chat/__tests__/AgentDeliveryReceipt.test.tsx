import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentDeliveryReceipt } from '../AgentDeliveryReceipt'

describe('AgentDeliveryReceipt', () => {
  it.each([
    ['sent', 'Sent to agent', 'lucide-check'],
    ['received', 'Delivered to agent', 'lucide-check-check'],
    ['read', 'Read by agent', 'lucide-check-check'],
  ] as const)('renders %s as accessible checks without visible status text', (receipt, label, icon) => {
    render(<AgentDeliveryReceipt receipt={receipt} />)
    const element = screen.getByRole('img', { name: label })
    expect(element).toHaveAttribute('title', label)
    expect(element.textContent).toBe('')
    expect(element.querySelector('svg')).toHaveClass(icon)
    expect(element.classList.contains('text-emerald-500')).toBe(receipt === 'read')
  })

  it('does not mark legacy delivered messages read without an explicit receipt', () => {
    const view = render(<AgentDeliveryReceipt status="delivered" />)
    expect(screen.getByTestId('agent-delivery-receipt')).toHaveAttribute('data-receipt', 'received')
    expect(screen.getByTestId('agent-delivery-receipt')).not.toHaveClass('text-emerald-500')
    view.rerender(<AgentDeliveryReceipt />)
    expect(screen.getByTestId('agent-delivery-receipt')).toHaveAttribute('data-receipt', 'sent')
  })

  it.each([
    ['interrupted', 'Delivery unconfirmed', 'lucide-triangle-alert'],
    ['cancelled', 'Cancelled before delivery', 'lucide-circle-x'],
  ] as const)('shows %s with its own tooltip instead of successful checks', (status, label, icon) => {
    render(<AgentDeliveryReceipt status={status} receipt="received" />)
    const element = screen.getByRole('img', { name: label })
    expect(element.querySelector('svg')).toHaveClass(icon)
    expect(element.textContent).toBe('')
    expect(element).not.toHaveClass('text-emerald-500')
  })
})
