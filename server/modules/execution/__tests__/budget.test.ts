import { expect, it } from 'vitest'
import { enforceDailyBudgets } from '..'

it('enforces project then desktop budgets including exact limits', () => {
  const scopes: string[] = []
  enforceDailyBudgets({
    project: () => ({ budget: 1, totalSpend: 1 }),
    desktop: () => ({ budget: 2, totalSpend: 3 }),
    exceeded: scope => { scopes.push(scope) },
  })
  expect(scopes).toEqual(['project', 'desktop'])
})
it('never admits desktop effects after a failed project pause', () => {
  let readDesktop = false
  expect(() => enforceDailyBudgets({
    project: () => ({ budget: 1, totalSpend: 2 }),
    desktop: () => { readDesktop = true; return { budget: 1, totalSpend: 2 } },
    exceeded: () => { throw new Error('storage failed') },
  })).toThrow('storage failed')
  expect(readDesktop).toBe(false)
})
it('ignores unset and disabled budgets', () => {
  let exceeded = false
  for (const budget of [null, 0, -1, NaN]) enforceDailyBudgets({
    project: () => ({ budget, totalSpend: 99 }), exceeded: () => { exceeded = true },
  })
  expect(exceeded).toBe(false)
})
