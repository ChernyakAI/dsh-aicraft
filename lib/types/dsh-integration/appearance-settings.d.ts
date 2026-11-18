/**
 * FILE: plugin/src/dsh-integration/appearance-settings.tsx
 * DESCRIPTION: Reconcile profile appearance with native settings revisions and connection generations
 */
import type { Context } from '@deepseek-ai/cordis';
export type NativePreference = 'light' | 'dark' | 'system';
/** Immutable profile facts; an unanswered read is never a false preference. @backlink DATA-18 */
export interface AppearanceSnapshot {
    status: 'loading' | 'ready' | 'unavailable';
    oneCDark?: boolean;
    nativePreference?: NativePreference;
    revision?: number;
    generation: number;
    writable: boolean;
    writeOutcome: 'idle' | 'pending' | 'confirmed' | 'rejected' | 'unknown';
    /** Keep the last write cause independent of subsequent profile reads. */
    reason?: unknown;
    readReason?: unknown;
    reconciled: boolean;
    bridgeAvailable: boolean;
}
/**
 * Own native profile observation independently of the settings page.
 */
export declare class AppearanceSettings {
    private readonly ctx;
    private state;
    private listeners;
    private alive;
    private readonly mirror;
    private readonly disposers;
    private own?;
    private native?;
    private reading?;
    private reread;
    private mirrorTrusted;
    private readSequence;
    private unknownAfterRead;
    /** Subscribe before the first read and keep the shared DSH mirror as the native settings source. @backlink MIF-81 */
    constructor(ctx: Context);
    /** Read the immutable accepted profile facts. @backlink MIF-81 DATA-18 */
    getSnapshot: () => AppearanceSnapshot;
    /** Observe changes until the caller releases its subscription. @backlink MIF-81 QR-7 */
    subscribe: (listener: () => void) => (() => void);
    private publish;
    setBridgeAvailable(value: boolean): void;
    /** Start a new connection generation without comparing its revisions to the previous server. @backlink MIF-81 */
    private reset;
    /** Discard stale namespace answers before folding them into the shared mirror. @backlink MIF-81 DATA-18 */
    private accept;
    /** Publish only complete, valid profile facts; a missing namespace is not a default false. @backlink MIF-81 */
    private derive;
    /** Reconcile ordinary native updates while preserving the connection-generation fence. @backlink MIF-81 */
    private adoptMirror;
    /** Read fresh Host facts, without repeating a mutation after an uncertain settlement. @backlink MIF-81 UC-218 */
    refresh: () => Promise<void>;
    /** Submit exactly one revision-fenced write and preserve the native failure. @backlink MIF-81 UC-217 UC-218 */
    setOneCDark(value: boolean): Promise<boolean>;
    /** End observation without deleting the saved profile preference. @backlink MIF-81 QR-7 */
    dispose(): void;
}
