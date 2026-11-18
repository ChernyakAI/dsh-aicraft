import type { ConversationReader, RunStore } from '../ports.ts';
import type { CallContext, MessageRef, OperationProblem, OperationResult, RunObservation, RunView, VerificationRequest } from '../types.ts';
/**
 * Only an explicitly established refusal can be reported as rejected.
 */
export declare class OperationRefusal extends Error {
    readonly code: Exclude<OperationProblem['code'], 'outcome-unknown'>;
    constructor(code: Exclude<OperationProblem['code'], 'outcome-unknown'>, message: string, options?: ErrorOptions);
}
/**
 * A preparation-side write may have happened even though no Run was registered.
 */
export declare class OperationUncertainty extends Error {
    readonly verification: VerificationRequest;
    constructor(message: string, verification: VerificationRequest, options?: ErrorOptions);
}
/**
 * Keep the typed problem, original cause and call identity in the common operation result.
 */
export declare function operationProblem(context: CallContext, error: unknown): OperationProblem;
export declare function verification(context: CallContext, taskId: string, selector: {
    runId?: string;
    attemptId?: string;
}): VerificationRequest;
/**
 * Select exactly one original run or attempt without substituting a later execution.
 */
export declare function findRun(store: RunStore, context: CallContext, taskId: string, selector: {
    runId?: string;
    attemptId?: string;
}, signal: AbortSignal): Promise<RunView | undefined>;
/**
 * Reject foreign message addresses before touching their conversation sources.
 */
export declare function assertConversation(run: RunView, sessionId: string): void;
/** Resolve the original run or attempt and delegate its observation to the conversation reader.
 */
export declare function observeRun(store: RunStore, reader: ConversationReader, context: CallContext, taskId: string, selector: {
    runId?: string;
    attemptId?: string;
}, signal: AbortSignal, expectedWorkspaceId?: string, messageRef?: MessageRef): Promise<OperationResult<RunObservation>>;
