/** Verified snapshots; retain older periods and bump ACCOUNTING_VERSION when prices/rules change. */
export const ACCOUNTING_VERSION = 2026101504
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const CALENDAR_SOURCE = 'https://english.beijing.gov.cn/workinginbeijing/laborrights/publicholidays/'
// Effective dates come from official release announcements, not the date we checked the price page.
export const FLASH_PRICE_FROM = Date.parse('2026-09-10T04:00:00Z')
export const PRO_PRICE_FROM = Date.parse('2026-08-16T16:00:00Z')
export const FLASH_PRICE_SOURCE = 'https://api-docs.deepseek.com/news/news260910/'
export const PRO_PRICE_SOURCE = 'https://api-docs.deepseek.com/updates/#date-2026-08-13'
const prices = [
  { provider: 'deepseek-official', models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], from: FLASH_PRICE_FROM, input: 150, cache: 3, output: 600 },
  { provider: 'deepseek-official', models: ['deepseek-v4-pro'], from: PRO_PRICE_FROM, input: 660, cache: 22, output: 1980 },
] as const // USD nanodollars per token (rates per 1M tokens × 1000).
const holidays2026 = [['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']]
export interface PriceUsage { input: number; cacheRead: number | null; cacheWrite: number | null; output: number }
export type PriceResult = { kind: 'priced'; uncached: number; cache: number; output: number } | { kind: 'local' | 'unknown' }
/** Price one request by its actual route and recorded local start, never by today's clock. */
export function priceRequest(provider: string, model: string, startedAt: number, usage: PriceUsage): PriceResult {
  if (provider === 'lmstudio') return { kind: 'local' }
  const price = prices.find(p => p.provider === provider && (p.models as readonly string[]).includes(model))
  if (!price || !Number.isFinite(startedAt) || startedAt < price.from || usage.cacheRead === null || usage.cacheWrite !== 0) return { kind: 'unknown' }
  const peak = isPeakTime(startedAt)
  if (peak === null) return { kind: 'unknown' }
  const multiplier = peak ? 2 : 1
  const result = { kind: 'priced' as const, uncached: usage.input * price.input * multiplier, cache: usage.cacheRead * price.cache * multiplier, output: usage.output * price.output * multiplier }
  return [result.uncached,result.cache,result.output].every(Number.isSafeInteger) ? result : { kind: 'unknown' }
}

/** UTC weekday/window rules with the explicitly supplied Chinese holiday calendar. */
export function isPeakTime(startedAt: number): boolean | null {
  const date = new Date(startedAt), minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  let peak = date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600))
  if (peak) {
    const chinaDay = new Date(startedAt + 8 * 3600000).toISOString().slice(0,10)
    if (!chinaDay.startsWith('2026-')) return null
    const day = chinaDay.slice(5)
    if (holidays2026.some(([from,to]) => day >= from && day <= to)) peak = false
  }
  return peak
}
