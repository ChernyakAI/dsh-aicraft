/**
 * FILE: plugin/src/execution-accounting/accounting.ts
 * DESCRIPTION: Project usage events and aggregate billable attempts and time intervals
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { z } from 'zod';
declare const totalsSchema: z.ZodObject<{
    input: z.ZodNumber;
    output: z.ZodNumber;
    total: z.ZodNumber;
    cacheRead: z.ZodNumber;
    requests: z.ZodNumber;
    unknownUsage: z.ZodNumber;
    unknownCache: z.ZodNumber;
    unknownPrice: z.ZodNumber;
    priced: z.ZodNumber;
    local: z.ZodNumber;
    uncachedCost: z.ZodNumber;
    cacheCost: z.ZodNumber;
    outputCost: z.ZodNumber;
}, z.core.$strip>;
export type AccountingTotals = z.infer<typeof totalsSchema>;
export declare const zeroTotals: () => AccountingTotals;
export declare const accountingSchema: z.ZodObject<{
    boundary: z.ZodNumber;
    tracked: z.ZodBoolean;
    route: z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
    }, z.core.$strip>>;
    totals: z.ZodObject<{
        input: z.ZodNumber;
        output: z.ZodNumber;
        total: z.ZodNumber;
        cacheRead: z.ZodNumber;
        requests: z.ZodNumber;
        unknownUsage: z.ZodNumber;
        unknownCache: z.ZodNumber;
        unknownPrice: z.ZodNumber;
        priced: z.ZodNumber;
        local: z.ZodNumber;
        uncachedCost: z.ZodNumber;
        cacheCost: z.ZodNumber;
        outputCost: z.ZodNumber;
    }, z.core.$strip>;
    buckets: z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        period: z.ZodEnum<{
            unavailable: "unavailable";
            peak: "peak";
            "off-peak": "off-peak";
        }>;
        totals: z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            total: z.ZodNumber;
            cacheRead: z.ZodNumber;
            requests: z.ZodNumber;
            unknownUsage: z.ZodNumber;
            unknownCache: z.ZodNumber;
            unknownPrice: z.ZodNumber;
            priced: z.ZodNumber;
            local: z.ZodNumber;
            uncachedCost: z.ZodNumber;
            cacheCost: z.ZodNumber;
            outputCost: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    attempt: z.ZodNullable<z.ZodObject<{
        start: z.ZodNumber;
        turn: z.ZodNumber;
        step: z.ZodNumber;
        route: z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>>;
        sample: z.ZodNullable<z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            totalTokens: z.ZodOptional<z.ZodNumber>;
            cacheReadTokens: z.ZodOptional<z.ZodNumber>;
            cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        charged: z.ZodNullable<z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            total: z.ZodNumber;
            cacheRead: z.ZodNumber;
            requests: z.ZodNumber;
            unknownUsage: z.ZodNumber;
            unknownCache: z.ZodNumber;
            unknownPrice: z.ZodNumber;
            priced: z.ZodNumber;
            local: z.ZodNumber;
            uncachedCost: z.ZodNumber;
            cacheCost: z.ZodNumber;
            outputCost: z.ZodNumber;
        }, z.core.$strip>>;
        chargedKey: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    intervals: z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
    openSince: z.ZodNullable<z.ZodNumber>;
    children: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        local: z.ZodBoolean;
        provider: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AccountingState = z.infer<typeof accountingSchema>;
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        aicraftAccounting: AccountingState;
    }
    interface SessionProjectionStateMap {
        aicraftAccounting: AccountingState;
    }
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'aicraft/accounting': {
            version: 1;
        };
        'aicraft/delegation': {
            id: string;
            local: boolean;
            provider: string;
        };
    }
}
export declare const record: (value: unknown) => Record<string, unknown>;
export declare function addTotals(a: AccountingTotals, b: AccountingTotals): AccountingTotals;
/** One immutable native DSH projection; fork prefixes contribute routing context only. */
export declare const accountingProjection: {
    key: "aicraftAccounting";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        boundary: z.ZodNumber;
        tracked: z.ZodBoolean;
        route: z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
        }, z.core.$strip>>;
        totals: z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            total: z.ZodNumber;
            cacheRead: z.ZodNumber;
            requests: z.ZodNumber;
            unknownUsage: z.ZodNumber;
            unknownCache: z.ZodNumber;
            unknownPrice: z.ZodNumber;
            priced: z.ZodNumber;
            local: z.ZodNumber;
            uncachedCost: z.ZodNumber;
            cacheCost: z.ZodNumber;
            outputCost: z.ZodNumber;
        }, z.core.$strip>;
        buckets: z.ZodArray<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            period: z.ZodEnum<{
                unavailable: "unavailable";
                peak: "peak";
                "off-peak": "off-peak";
            }>;
            totals: z.ZodObject<{
                input: z.ZodNumber;
                output: z.ZodNumber;
                total: z.ZodNumber;
                cacheRead: z.ZodNumber;
                requests: z.ZodNumber;
                unknownUsage: z.ZodNumber;
                unknownCache: z.ZodNumber;
                unknownPrice: z.ZodNumber;
                priced: z.ZodNumber;
                local: z.ZodNumber;
                uncachedCost: z.ZodNumber;
                cacheCost: z.ZodNumber;
                outputCost: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        attempt: z.ZodNullable<z.ZodObject<{
            start: z.ZodNumber;
            turn: z.ZodNumber;
            step: z.ZodNumber;
            route: z.ZodNullable<z.ZodObject<{
                provider: z.ZodString;
                model: z.ZodString;
            }, z.core.$strip>>;
            sample: z.ZodNullable<z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                totalTokens: z.ZodOptional<z.ZodNumber>;
                cacheReadTokens: z.ZodOptional<z.ZodNumber>;
                cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            charged: z.ZodNullable<z.ZodObject<{
                input: z.ZodNumber;
                output: z.ZodNumber;
                total: z.ZodNumber;
                cacheRead: z.ZodNumber;
                requests: z.ZodNumber;
                unknownUsage: z.ZodNumber;
                unknownCache: z.ZodNumber;
                unknownPrice: z.ZodNumber;
                priced: z.ZodNumber;
                local: z.ZodNumber;
                uncachedCost: z.ZodNumber;
                cacheCost: z.ZodNumber;
                outputCost: z.ZodNumber;
            }, z.core.$strip>>;
            chargedKey: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        intervals: z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
        openSince: z.ZodNullable<z.ZodNumber>;
        children: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            local: z.ZodBoolean;
            provider: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    init: (_header: unknown, boundary: number) => AccountingState;
    apply: (state: AccountingState, event: SessionEvent) => AccountingState;
    wire: {
        viewSchema: z.ZodObject<{
            boundary: z.ZodNumber;
            tracked: z.ZodBoolean;
            route: z.ZodNullable<z.ZodObject<{
                provider: z.ZodString;
                model: z.ZodString;
            }, z.core.$strip>>;
            totals: z.ZodObject<{
                input: z.ZodNumber;
                output: z.ZodNumber;
                total: z.ZodNumber;
                cacheRead: z.ZodNumber;
                requests: z.ZodNumber;
                unknownUsage: z.ZodNumber;
                unknownCache: z.ZodNumber;
                unknownPrice: z.ZodNumber;
                priced: z.ZodNumber;
                local: z.ZodNumber;
                uncachedCost: z.ZodNumber;
                cacheCost: z.ZodNumber;
                outputCost: z.ZodNumber;
            }, z.core.$strip>;
            buckets: z.ZodArray<z.ZodObject<{
                provider: z.ZodString;
                model: z.ZodString;
                period: z.ZodEnum<{
                    unavailable: "unavailable";
                    peak: "peak";
                    "off-peak": "off-peak";
                }>;
                totals: z.ZodObject<{
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    total: z.ZodNumber;
                    cacheRead: z.ZodNumber;
                    requests: z.ZodNumber;
                    unknownUsage: z.ZodNumber;
                    unknownCache: z.ZodNumber;
                    unknownPrice: z.ZodNumber;
                    priced: z.ZodNumber;
                    local: z.ZodNumber;
                    uncachedCost: z.ZodNumber;
                    cacheCost: z.ZodNumber;
                    outputCost: z.ZodNumber;
                }, z.core.$strip>;
            }, z.core.$strip>>;
            attempt: z.ZodNullable<z.ZodObject<{
                start: z.ZodNumber;
                turn: z.ZodNumber;
                step: z.ZodNumber;
                route: z.ZodNullable<z.ZodObject<{
                    provider: z.ZodString;
                    model: z.ZodString;
                }, z.core.$strip>>;
                sample: z.ZodNullable<z.ZodObject<{
                    inputTokens: z.ZodNumber;
                    outputTokens: z.ZodNumber;
                    totalTokens: z.ZodOptional<z.ZodNumber>;
                    cacheReadTokens: z.ZodOptional<z.ZodNumber>;
                    cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>>;
                charged: z.ZodNullable<z.ZodObject<{
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    total: z.ZodNumber;
                    cacheRead: z.ZodNumber;
                    requests: z.ZodNumber;
                    unknownUsage: z.ZodNumber;
                    unknownCache: z.ZodNumber;
                    unknownPrice: z.ZodNumber;
                    priced: z.ZodNumber;
                    local: z.ZodNumber;
                    uncachedCost: z.ZodNumber;
                    cacheCost: z.ZodNumber;
                    outputCost: z.ZodNumber;
                }, z.core.$strip>>;
                chargedKey: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            intervals: z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>;
            openSince: z.ZodNullable<z.ZodNumber>;
            children: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                local: z.ZodBoolean;
                provider: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        view: (state: AccountingState) => {
            boundary: number;
            tracked: boolean;
            route: {
                provider: string;
                model: string;
            } | null;
            totals: {
                input: number;
                output: number;
                total: number;
                cacheRead: number;
                requests: number;
                unknownUsage: number;
                unknownCache: number;
                unknownPrice: number;
                priced: number;
                local: number;
                uncachedCost: number;
                cacheCost: number;
                outputCost: number;
            };
            buckets: {
                provider: string;
                model: string;
                period: "unavailable" | "peak" | "off-peak";
                totals: {
                    input: number;
                    output: number;
                    total: number;
                    cacheRead: number;
                    requests: number;
                    unknownUsage: number;
                    unknownCache: number;
                    unknownPrice: number;
                    priced: number;
                    local: number;
                    uncachedCost: number;
                    cacheCost: number;
                    outputCost: number;
                };
            }[];
            attempt: {
                start: number;
                turn: number;
                step: number;
                route: {
                    provider: string;
                    model: string;
                } | null;
                sample: {
                    inputTokens: number;
                    outputTokens: number;
                    totalTokens?: number | undefined;
                    cacheReadTokens?: number | undefined;
                    cacheWriteTokens?: number | undefined;
                } | null;
                charged: {
                    input: number;
                    output: number;
                    total: number;
                    cacheRead: number;
                    requests: number;
                    unknownUsage: number;
                    unknownCache: number;
                    unknownPrice: number;
                    priced: number;
                    local: number;
                    uncachedCost: number;
                    cacheCost: number;
                    outputCost: number;
                } | null;
                chargedKey: string | null;
            } | null;
            intervals: [number, number][];
            openSince: number | null;
            children: {
                id: string;
                local: boolean;
                provider: string;
            }[];
        };
    };
};
/** Union root activity intervals; concurrent executor chats must not double elapsed task time. */
export declare function intervalUnion(intervals: readonly (readonly [number, number])[]): number;
export {};
