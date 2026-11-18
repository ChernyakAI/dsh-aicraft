import type { StartRunDependencies } from '../ports.ts';
import type { CallContext, OperationResult, RunObservation, RunRequest } from '../types.ts';
/**
 * Classify the whole launch by native receipt and publication, retaining uncertainty after possible acceptance.
 * Repeated attempt IDs observe their original run before any new-start checks.
 */
export declare function startRun(deps: StartRunDependencies, context: CallContext, taskId: string, attemptId: string, request: RunRequest, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
