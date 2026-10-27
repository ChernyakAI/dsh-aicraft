/**
 * FILE: plugin/src/execution-accounting/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
export interface StatisticsBucket {
  provider: string
  model: string
  period: 'peak' | 'off-peak' | 'unavailable'
  totals: Pick<ExecutionStatistics, 'input' | 'output' | 'total' | 'cacheRead' | 'requests' | 'unknownUsage' | 'unknownCache' | 'unknownPrice' | 'priced' | 'local' | 'uncachedCost' | 'cacheCost' | 'outputCost'>
}

/** Read-only derived statistics; unknown usage/prices never imply a zero bill. */
export interface ExecutionStatistics {
  input: number
  output: number
  total: number
  cacheRead: number
  requests: number
  unknownUsage: number
  unknownCache: number
  unknownPrice: number
  priced: number
  local: number
  uncachedCost: number
  cacheCost: number
  outputCost: number
  elapsedMs: number
  llmMs: number
  toolMs: number
  running: boolean
  buckets: StatisticsBucket[]
  sessions: number
  coverageIncomplete: boolean
  incomplete: string[]
}

export interface PriceUsage { input: number; cacheRead: number | null; cacheWrite: number | null; output: number }

export type PriceResult = { kind: 'priced'; uncached: number; cache: number; output: number } | { kind: 'local' | 'unknown' }
