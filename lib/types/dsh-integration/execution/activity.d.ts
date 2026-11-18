import { type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { WorkObservation } from '../../step-execution/ports.ts';
import type { CallContext, CallerRef, RunView, WorkActivity } from '../../step-execution/types.ts';
/**
 * Track native lifecycle changes before snapshots so activity completeness can be established.
 */
export declare class NativeWorkObservation implements WorkObservation {
    private readonly ctx;
    private readonly resolveCaller;
    private readonly observers;
    private readonly activations;
    readonly pending: Set<string>;
    readonly initial: Set<string>;
    constructor(ctx: Context, resolveCaller: (ref: CallerRef) => Agent | undefined);
    /**
     * One bounded observation; a changing or unreadable composition stays incomplete.
     */
    read(context: CallContext, run: RunView, signal: AbortSignal, excludeCallerTurn?: boolean): Promise<{
        selected: WorkActivity;
        others: WorkActivity;
    }>;
    /** Observe work owned by the actual calling conversation.
     */
    caller(context: CallContext, signal: AbortSignal): Promise<{
        selected: WorkActivity;
        others: WorkActivity;
    }>;
    /**
     * Observe exact work owners and retain incomplete discovery as unknown activity.
     */
    private readRoots;
}
