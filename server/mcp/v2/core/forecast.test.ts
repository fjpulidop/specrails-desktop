import { describe, expect, it } from 'vitest'
import { McpApiError } from '../../tools/types'
import { scaledCost, turnCostBand } from './forecast'
import { typedApiError } from './loopback'

describe('core forecasts', () => {
  it('scales a launch forecast by the runs it starts; unknown stays null', () => {
    expect(scaledCost({ cost: { lowUsd: 0.2, highUsd: 0.4 } }, 3)).toEqual([0.6, 1.2])
    expect(scaledCost({ cost: { lowUsd: 0.2 } }, 1)).toBeNull()
    expect(scaledCost(null, 1)).toBeNull()
    expect(scaledCost(null, 0)).toEqual([0, 0])
  })

  it('bands past billed turns: min or median to max, unknown below the sample floor', () => {
    expect(turnCostBand([0.3, 0.1, null, 0.2])).toEqual([0.1, 0.3])
    expect(turnCostBand([0.5, 0.1, 0.2, 0.4], { low: 'median', minSamples: 3 })).toEqual([0.4, 0.5])
    expect(turnCostBand([0.1, 0.2], { minSamples: 3 })).toBeNull()
    expect(turnCostBand([-1, Number.NaN, 0.2])).toBeNull()
  })
})

describe('core loopback', () => {
  it('turns a route refusal into a typed v2 error with the route text', () => {
    const err = typedApiError(new McpApiError('HTTP 409', 409, { error: 'rail_busy', detail: 'The rail has a run.' }))
    expect(err).toMatchObject({ code: 'conflict', message: 'rail_busy: The rail has a run.' })
    expect(typedApiError(new McpApiError('HTTP 503', 503, null))).toMatchObject({ code: 'provider_unavailable', extra: { retryable: true } })
  })
})
