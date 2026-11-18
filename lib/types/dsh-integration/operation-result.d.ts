import type { CallContext, MutationProgress, OperationProblem, OperationResult, VerificationRequest } from '../step-execution/types.ts';
/**
 * Preserve confirmation independently of errors during later refresh or lock release.
 */
export declare function mutationResult<T>(context: CallContext, verification: VerificationRequest, perform: (progress: MutationProgress<T>) => Promise<unknown>): Promise<OperationResult<T>>;
/**
 * Read-only failures cannot be successful empty reads or mutation confirmations.
 */
export declare function readResult<T>(context: CallContext, read: () => Promise<T>): Promise<OperationResult<T>>;
/**
 * Presentation consumes the union without changing its meaning or retrying.
 */
export declare function requireConfirmation<T>(result: OperationResult<T>): T;
/**
 * Present a known problem with the original read address when the mutation outcome is unknown.
 */
export declare class OperationPresentationError extends Error {
    readonly problem: OperationProblem;
    readonly verification?: VerificationRequest | undefined;
    constructor(problem: OperationProblem, verification?: VerificationRequest | undefined);
}
