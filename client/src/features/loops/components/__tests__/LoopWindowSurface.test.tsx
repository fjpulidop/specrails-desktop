import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LoopWindowSurface } from '../LoopWindowSurface'
const context = vi.hoisted(() => ({ projects: [{ id: 'source' }, { id: 'other' }], isLoading: false, setActiveProjectId: vi.fn() }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => context }))
vi.mock('../../pages/LoopsPage', () => ({ default: ({ onOpenBuilder }: { onOpenBuilder: (id: string) => void }) => <button onClick={() => onOpenBuilder('next')}>Library</button> }))
vi.mock('../../pages/LoopBuilderPage', () => ({ default: ({ loopId, onExit }: { loopId: string; onExit: () => void }) => <button onClick={onExit}>Editor {loopId}</button> }))
beforeEach(() => { vi.clearAllMocks(); context.isLoading = false; window.history.replaceState({}, '', '/?loopsWindow=1&projectId=source&loopId=initial') })
it('opens the target and keeps navigation inside the loop window', () => {
  render(<LoopWindowSurface />)
  expect(context.setActiveProjectId).toHaveBeenCalledWith('source')
  fireEvent.click(screen.getByText('Editor initial'))
  fireEvent.click(screen.getByText('Library'))
  expect(screen.getByText('Editor next')).toBeInTheDocument()
})
it('initializes the project after loading but never overwrites a later user selection', () => {
  context.isLoading = true
  const { rerender } = render(<LoopWindowSurface />)
  expect(context.setActiveProjectId).not.toHaveBeenCalled()
  context.isLoading = false
  rerender(<LoopWindowSurface />)
  expect(context.setActiveProjectId).toHaveBeenCalledOnce()
  rerender(<LoopWindowSurface />)
  expect(context.setActiveProjectId).toHaveBeenCalledOnce()
})
