/**
 * FILE: plugin/src/execution-accounting/pricing.ts
 * DESCRIPTION: Calculate estimates from bundled tariff snapshots
 */
import type { PriceResult, PriceUsage } from './types.ts';
/** Verified snapshots; retain older periods and bump ACCOUNTING_VERSION when prices/rules change. */
export declare const ACCOUNTING_VERSION = 2026101504;
export declare const PRICE_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
export declare const CALENDAR_SOURCE = "https://english.beijing.gov.cn/workinginbeijing/laborrights/publicholidays/";
export declare const FLASH_PRICE_FROM: number;
export declare const PRO_PRICE_FROM: number;
export declare const FLASH_PRICE_SOURCE = "https://api-docs.deepseek.com/news/news260910/";
export declare const PRO_PRICE_SOURCE = "https://api-docs.deepseek.com/updates/#date-2026-08-13";
/** Price one request by its actual route and recorded local start, never by today's clock. */
export declare function priceRequest(provider: string, model: string, startedAt: number, usage: PriceUsage): PriceResult;
/** UTC weekday/window rules with the explicitly supplied Chinese holiday calendar. */
export declare function isPeakTime(startedAt: number): boolean | null;
