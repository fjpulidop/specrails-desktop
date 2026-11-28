import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../../../test-utils'
import { MissionPlanPill, latestPlan, parseMissionPlanRow } from '../MissionPlanPill'

const planRow = (steps: Array<[string, string]>, title: string | null = null) => ({
  role: 'system',
  content: JSON.stringify({ kind: 'mission-plan', title, steps: steps.map(([content, status]) => ({ content, status })), source: 'todo-tool', at: '2026-11-28T16:00:00Z' }),
})

describe('MissionPlanPill', () => {
  it('reads only plan rows and keeps the latest one', () => {
    expect(parseMissionPlanRow('{"kind":"mobile-test-offer"}')).toBeNull()
    expect(parseMissionPlanRow('{"kind":"mission-plan","steps":[]}')).toBeNull()
    const messages = [planRow([['Old', 'completed']]), { role: 'assistant', content: 'mission-plan in prose' }, planRow([['New', 'in_progress']])]
    expect(latestPlan(messages)?.steps).toEqual([{ content: 'New', status: 'in_progress' }])
    expect(latestPlan([{ role: 'user', content: 'hi' }])).toBeNull()
  })

  it('[spec:mission-plan/pill] is absent without a plan, and shows the progress and each step\'s state on hover', async () => {
    const { container, rerender } = render(<MissionPlanPill messages={[{ role: 'user', content: 'Build it' }]} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<MissionPlanPill messages={[planRow([['Read the screen', 'completed'], ['Add the login form', 'in_progress'], ['Write the tests', 'pending']], 'Login')]} />)
    const pill = screen.getByTestId('agent-composer-plan')
    expect(pill).toHaveTextContent('1/3')
    expect(pill).toHaveAccessibleName('Work plan: 1 of 3 steps done')
    fireEvent.focus(pill)
    const plan = await screen.findByTestId('mission-plan')
    expect(plan).toHaveTextContent('Login')
    expect(plan).toHaveTextContent('1 of 3')
    expect(plan).toHaveTextContent('Now: Add the login form')
    expect([...plan.querySelectorAll('li')].map((li) => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('says when every step is done', async () => {
    render(<MissionPlanPill messages={[planRow([['A', 'completed'], ['B', 'completed']])]} />)
    fireEvent.focus(screen.getByTestId('agent-composer-plan'))
    expect(await screen.findByText('All steps done.')).toBeInTheDocument()
  })
})
