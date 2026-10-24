/**
 * Launch forecast: "Usually 6-9 min · $2-4 for runs like this".
 *
 * Same honest-metrics contract as the job story's "Runs like this have taken…"
 * band (run-duration-stats): a MEASURED interquartile band of this project's own
 * settled runs of the same kind, nothing below the sample floor, never a default.
 * It reads the same samples, narrowed to the provider about to run.
 *
 * Accounting rules (AGENTS.md): the cost band is built ONLY from costs the
 * provider reported. Runs whose cost was estimated from the local price table,
 * and runs with no cost, are left out of it; they still count toward the time
 * band. The band is an estimate and is returned apart from any billed figure.
 */
import type { DbInstance } from '../../../db'
import {
  MIN_DURATION_SAMPLES,
  jobCommandSamples,
  loopRunSamples,
  percentileMs,
  rangeFromSamples,
  type DurationRange,
  type RunSample,
} from './run-duration-stats'

export interface CostRange {
  /** 25th percentile of provider-reported run costs, USD (cents precision). */
  lowUsd: number
  /** 75th percentile, USD (cents precision). */
  highUsd: number
  /** How many provider-reported costs the band was measured from. */
  sampleCount: number
}

export interface LaunchForecast {
  /** Null below the sample floor. */
  time: DurationRange | null
  /** Null below the sample floor of provider-reported costs. */
  cost: CostRange | null
  minSamples: number
}

const cents = (usd: number): number => Math.round(usd * 100) / 100

export function forecastFromSamples(samples: readonly RunSample[]): LaunchForecast {
  const costs = samples
    .map((sample) => sample.costUsd)
    .filter((cost): cost is number => cost !== null)
    .sort((a, b) => a - b)
  return {
    time: rangeFromSamples(samples.map((sample) => sample.ms)),
    cost: costs.length < MIN_DURATION_SAMPLES
      ? null
      : { lowUsd: cents(percentileMs(costs, 0.25)), highUsd: cents(percentileMs(costs, 0.75)), sampleCount: costs.length },
    minSamples: MIN_DURATION_SAMPLES,
  }
}

/** The legacy rail modes run as queue jobs under a slash command, not as loop runs. */
const FACTORY_COMMAND: Record<string, string> = {
  'factory:implement': '/specrails:implement',
  'factory:batch': '/specrails:implement',
  'factory:freestyle': '/specrails:freestyle',
}

export interface LaunchForecastTarget {
  /** Loop id (`factory:implement`, a custom loop, the Flow hand-off loop). */
  loopId?: string | null
  /** A job command (`/specrails:implement`); its shape is what groups history. */
  commandShape?: string | null
  /** Provider about to run; narrows history to runs of that provider. */
  provider?: string | null
}

export function getLaunchForecast(db: DbInstance, projectId: string, target: LaunchForecastTarget): LaunchForecast {
  const provider = target.provider || null
  const factoryCommand = target.loopId ? FACTORY_COMMAND[target.loopId] : undefined
  if (target.loopId && !factoryCommand) return forecastFromSamples(loopRunSamples(db, projectId, target.loopId, provider))
  const shape = factoryCommand ?? target.commandShape
  return forecastFromSamples(shape ? jobCommandSamples(db, shape, provider) : [])
}
