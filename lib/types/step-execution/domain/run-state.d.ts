import type { RunDispatch, RunRequest, RunView } from '../types.ts';
/**
 * A retry compares the original explicit request, never the current model or prompt.
 */
export declare function sameAttempt(run: RunView, callerSessionId: string | null, request: RunRequest): boolean;
/**
 * Preserve known acceptance and all original links when recording later facts.
 */
export declare function advanceDispatch(run: RunView, next: RunDispatch): RunView;
/**
 * An exception after submitting is not proof that execution failed.
 */
export declare function dispatchKnowledge(run: RunView): 'accepted' | 'rejected' | 'unknown';
/**
 * Reject a stale writer attempting to change the original request or saved links.
 */
export declare function assertRunIdentity(previous: RunView, next: RunView): void;
