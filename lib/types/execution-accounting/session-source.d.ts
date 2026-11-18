import type { Context } from '@deepseek-ai/cordis';
import { type AccountingState } from './accounting.ts';
export interface StatisticsPacket {
    state: AccountingState;
    stats: Record<string, unknown>;
    catalog: unknown;
    live: boolean;
}
interface Stamp {
    owner: object | symbol;
    revision: string | number;
    key: string;
}
export interface CachedPacket {
    stamp: Stamp;
    packet: StatisticsPacket;
}
/**
 * Encode UTF-16 units as the pinned JSONL layout does, including isolated surrogates.
 */
export declare function encodeSessionSegment(value: string): string;
/**
 * The readable project key is lossy; it must never replace header cwd validation.
 */
export declare function sessionProjectKey(cwd: string): string;
/** One-shot source; the controller owns the only LRU and admission queue. */
export declare class SessionSource {
    private readonly ctx;
    constructor(ctx: Context);
    private backend;
    private live;
    private check;
    /** Resolve metadata from the provider's own Loader tree and verify the loaded module identity. */
    private compatible;
    private select;
    private packet;
    /** Prepare and fold from zero; persistent DSH checkpoints cannot identify a replaced physical file. */
    private direct;
    /** Read or validate a compact packet with one shared retry budget for source and physical changes. */
    read(cwd: string, value: string, signal: AbortSignal, cached?: CachedPacket): Promise<{
        packet: StatisticsPacket | null;
        stamp?: Stamp;
    }>;
}
export {};
