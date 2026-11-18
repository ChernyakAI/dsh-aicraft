import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ProjectConfig } from '../config.ts';
import type { CallContext, CallerRef, MessageRef, OperationResult, RunModel, RunObservation, RunView } from '../../step-execution/types.ts';
/**
 * Connect shared launch and observation operations to their project and native owners.
 */
export declare class ExecutionApplication {
    private readonly ctx;
    private readonly config;
    private readonly resolveModel;
    private readonly store;
    private readonly work;
    private readonly reader;
    private readonly runtime;
    constructor(ctx: Context, config: ProjectConfig, track: ((agent: Agent) => Promise<void>) | undefined, resolveModel: (model: RunModel, signal: AbortSignal) => Promise<RunModel>, caller: (ref: CallerRef) => Agent | undefined);
    /**
     * Admit task mutations using live work, excluding only the actual caller's current turn.
     */
    readonly isActive: (run: RunView, context?: CallContext) => Promise<boolean>;
    /** Check the caller's own and related work before a shared operation.
     */
    hasCallerActivity(context: CallContext, signal: AbortSignal): Promise<boolean>;
    /**
     * Recheck the actual current task without resolving or changing a model route.
     */
    private currentState;
    /** Assemble project-backed launch preparation and ports for the shared start operation.
     */
    start(context: CallContext, taskId: string, stepId: string, attemptId: string, modelOverride: RunModel | null, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /** Connect the run store and native reader to the shared observation operation.
     */
    observe(context: CallContext, taskId: string, selector: {
        runId?: string;
        attemptId?: string;
    }, signal: AbortSignal, expectedWorkspaceId?: string, messageRef?: MessageRef): Promise<OperationResult<RunObservation>>;
    /**
     * Persist established initial-turn outcomes; unreadable sources do not invent interruption.
     */
    private settle;
    /** Reconcile saved launches and persist established recovery outcomes through settle.
     */
    reconcile(cwd: string): Promise<void>;
}
