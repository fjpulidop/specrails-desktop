/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { CliLaunchMenu } from '../CliLaunchMenu'

function renderMenu(overrides: Partial<Parameters<typeof CliLaunchMenu>[0]> = {}) {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const props = {
    x: 100,
    y: 100,
    providers: ['claude', 'codex'] as readonly string[],
    onSelect,
    onClose,
    ...overrides,
  }
  const rendered = render(<CliLaunchMenu {...props} />)
  return { ...rendered, onSelect, onClose }
}

describe('CliLaunchMenu', () => {
  it('renders a role="menu" element', () => {
    const { getByRole } = renderMenu()
    expect(getByRole('menu')).toBeDefined()
  })

  it('renders one menuitem per provider', () => {
    const { getAllByRole } = renderMenu()
    const items = getAllByRole('menuitem')
    expect(items).toHaveLength(2)
  })

  it('renders "Open Claude" for claude provider', () => {
    const { getByText } = renderMenu({ providers: ['claude'] })
    expect(getByText('Open Claude')).toBeDefined()
  })

  it('renders "Open Codex" for codex provider', () => {
    const { getByText } = renderMenu({ providers: ['codex'] })
    expect(getByText('Open Codex')).toBeDefined()
  })

  it('renders both "Open Claude" and "Open Codex" when both providers present', () => {
    const { getByText } = renderMenu({ providers: ['claude', 'codex'] })
    expect(getByText('Open Claude')).toBeDefined()
    expect(getByText('Open Codex')).toBeDefined()
  })

  it('clicking a menuitem calls onSelect(provider) then onClose', () => {
    const { getByText, onSelect, onClose } = renderMenu({ providers: ['claude', 'codex'] })
    fireEvent.click(getByText('Open Claude'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('claude')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking codex menuitem calls onSelect("codex")', () => {
    const { getByText, onSelect, onClose } = renderMenu({ providers: ['claude', 'codex'] })
    fireEvent.click(getByText('Open Codex'))
    expect(onSelect).toHaveBeenCalledWith('codex')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('onSelect is called before onClose (call order)', () => {
    const callOrder: string[] = []
    const onSelect = vi.fn(() => callOrder.push('onSelect'))
    const onClose = vi.fn(() => callOrder.push('onClose'))
    const { getByText } = render(
      <CliLaunchMenu x={0} y={0} providers={['claude']} onSelect={onSelect} onClose={onClose} />
    )
    fireEvent.click(getByText('Open Claude'))
    expect(callOrder).toEqual(['onSelect', 'onClose'])
  })

  it('Escape keydown calls onClose', () => {
    const { onClose } = renderMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('non-Escape keydown does not call onClose', () => {
    const { onClose } = renderMenu()
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mousedown outside the menu calls onClose', () => {
    const { onClose } = renderMenu()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mousedown inside the menu does not call onClose', () => {
    const { getByRole, onClose } = renderMenu()
    fireEvent.mouseDown(getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders with a single provider', () => {
    const { getAllByRole } = renderMenu({ providers: ['claude'] })
    expect(getAllByRole('menuitem')).toHaveLength(1)
  })

  it('renders no menuitems when providers is empty', () => {
    const { queryAllByRole } = renderMenu({ providers: [] })
    expect(queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('positions the menu via fixed style with provided x/y by default', () => {
    const { getByRole } = renderMenu({ x: 50, y: 80 })
    const menu = getByRole('menu') as HTMLElement
    expect(menu.style.position).toBe('fixed')
    expect(menu.style.left).toBe('50px')
    expect(menu.style.top).toBe('80px')
  })

  it('flips x when menu would overflow viewport width', () => {
    // x + 200 > window.innerWidth → flippedX = x - 200
    const wideX = window.innerWidth - 50 // e.g. 974 if innerWidth=1024
    const { getByRole } = renderMenu({ x: wideX, y: 10 })
    const menu = getByRole('menu') as HTMLElement
    // Expect the left to be the flipped value (x - 200)
    expect(menu.style.left).toBe(`${wideX - 200}px`)
  })

  it('flips y when menu would overflow viewport height', () => {
    // y + menuH > window.innerHeight → flippedY = y - menuH
    const tallY = window.innerHeight - 10
    const providers = ['claude', 'codex'] // menuH = 8 + 2*32 = 72
    const { getByRole } = renderMenu({ x: 0, y: tallY, providers })
    const menu = getByRole('menu') as HTMLElement
    const menuH = 8 + providers.length * 32
    expect(menu.style.top).toBe(`${tallY - menuH}px`)
  })

  it('removes event listeners on unmount (no calls after unmount)', () => {
    const { onClose, unmount } = renderMenu()
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })
})
