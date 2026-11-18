import type { DiagnosticContext, DiagnosticEvent, DiagnosticSource } from './types.ts';
/**
 * START_METHOD_diagnosticContext
 * Run one action with an isolated causal context; child operations share its sequence.
 */
export declare function diagnosticContext<T>(context: Partial<DiagnosticContext>, execute: () => T): T;
/**
 * START_METHOD_observeDiagnostics
 * Subscribe before an action; disposal prevents further delivery to this observer.
 */
export declare function observeDiagnostics(observe: (event: DiagnosticEvent) => void): () => void;
/**
 * START_METHOD_diagnosticEvent
 * Publish a boundary fact with source and causal identity, never a criterion verdict.
 */
export declare function diagnosticEvent(type: string, data?: Record<string, unknown>, source?: DiagnosticSource): void;
/**
 * START_METHOD_diagnosticRejection
 * Mark an existing domain refusal without replacing its error identity or stack.
 */
export declare function diagnosticRejection<T>(error: T): T;
/**
 * START_METHOD_diagnosticAccepted
 * Record validated inputs at their actual acceptance boundary.
 */
export declare function diagnosticAccepted(data?: Record<string, unknown>): void;
/**
 * START_METHOD_diagnosticCommitted
 * Record publication after a successful write or rename, excluding staging files.
 */
export declare function diagnosticCommitted(data?: Record<string, unknown>): void;
/**
 * Retain native error stacks and causes in the existing diagnostic format.
 */
export declare function diagnosticFailure(error: unknown, seen?: WeakSet<object>): Record<string, unknown>;
/**
 * START_METHOD_diagnosticOperation
 * Observe a real operation, preserving its exact result and thrown error.
 */
export declare function diagnosticOperation<T>(source: DiagnosticSource, identity: Partial<DiagnosticContext>, execute: () => Promise<T>): Promise<T>;
/**
 * START_METHOD_diagnosticStream
 * Keep stream operations in their originating context across next, return and cancellation.
 */
export declare function diagnosticStream<T>(source: DiagnosticSource, identity: Partial<DiagnosticContext>, create: () => AsyncIterable<T>): AsyncIterable<T>;
/**
 * START_METHOD_diagnosticPublication
 * Observe successful publication at an actual filesystem mutation, never at staging writes.
 */
export declare function diagnosticPublication<T>(execute: () => Promise<T>, target: unknown, kind: string): Promise<T>;
