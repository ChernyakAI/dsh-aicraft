import { type Context } from '@deepseek-ai/cordis';
import { type Agent } from '@deepseek-ai/dsh-agent';
import type { ExecutionAdmission, ExecutionRuntime, PreparedRun } from '../../step-execution/ports.ts';
import type { CallContext, CallerRef, OperationResult, RunView } from '../../step-execution/types.ts';
import type { NativeWorkObservation } from './activity.ts';
/**
 * Own native executor handles and lifecycle subscriptions, releasing archived idle chats safely.
 */
export declare class NativeExecutionRuntime implements ExecutionRuntime {
    private readonly ctx;
    private readonly trackStatistics;
    private readonly resolveCaller;
    private readonly work;
    private readonly onSettled;
    private readonly admissions;
    private readonly handles;
    private readonly active;
    private readonly releasing;
    private archivedSessions;
    private releaseRevision;
    private stopping;
    /**
     * @param ctx - Service context with DSH execution and persistence dependencies.
     */
    constructor(ctx: Context, trackStatistics: ((agent: Agent) => Promise<void>) | undefined, resolveCaller: (ref: CallerRef) => Agent | undefined, work: NativeWorkObservation, onSettled: (context: CallContext, run: RunView) => Promise<void>);
    /**
     * Ordinary idle chats stay live; archived owners release on lifecycle events, without polling.
     */
    private releaseIdleHandles;
    /**
     * Release only an archived owner after checking idle state, queued input and owned work.
     */
    private release;
    /**
     * Reconsider archived idle handles after an explicit project reconciliation.
     */
    reconcileResources(): void;
    /**
     * Validate the installed host composition and actual caller before native admission.
     */
    private services;
    /** Check native launch readiness and install accounting for the reserved executor.
     */
    admit(context: CallContext, signal: AbortSignal): Promise<ExecutionAdmission>;
    /** Release the reserved admission and its addressed creation listener.
     */
    releaseAdmission(admission: ExecutionAdmission): void;
    /** Dispatch the prepared launch through its admitted native execution path.
     */
    start(context: CallContext, prepared: PreparedRun, signal: AbortSignal): Promise<OperationResult<{
        messageId: string;
    }>>;
}
