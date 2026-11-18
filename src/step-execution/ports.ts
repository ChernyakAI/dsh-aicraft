/**
 * FILE: plugin/src/step-execution/ports.ts
 * DESCRIPTION: Define execution application dependencies owned by their consumer
 */
import type { CallContext, MessageRef, OperationResult, RunModel, RunObservation, RunRequest, RunView, WorkActivity } from './types.ts'

/**
 * Read original execution records and serialize their publication under the project lock.
 */
export interface RunStore {
  read(context: CallContext, taskId: string, signal: AbortSignal): Promise<RunView[]>
  /** Hold only the existing project lock, never a model's complete lifetime. */
  transaction<T>(context: CallContext, taskId: string, signal: AbortSignal, operation: (writer: RunWriter) => Promise<T>): Promise<T>
}
/**
 * Read and publish run facts within the owning transaction without replacing original links.
 */
export interface RunWriter {
  read(): Promise<RunView[]>
  save(run: RunView): Promise<void>
}
/**
 * Reserve a native executor identity after checking the required host capabilities.
 */
export interface ExecutionAdmission { readonly identity: object; readonly sessionId: string }
/**
 * Carry the prepared run, assigned content and native admission to registration and dispatch.
 */
export interface PreparedRun {
  run: RunView
  sessionTitle: string
  admission: ExecutionAdmission
  content: { type: 'text'; text: string }[]
}
/**
 * Admit native work and return initial dispatch receipts through narrow ports.
 */
export interface ExecutionRuntime {
  admit(context: CallContext, signal: AbortSignal): Promise<ExecutionAdmission>
  releaseAdmission(admission: ExecutionAdmission): void
  start(context: CallContext, prepared: PreparedRun, signal: AbortSignal): Promise<OperationResult<{ messageId: string }>>
}
/**
 * Observe selected and related native work with explicit completeness.
 */
export interface WorkObservation {
  read(context: CallContext, run: RunView, signal: AbortSignal): Promise<{ selected: WorkActivity; others: WorkActivity }>
}
/**
 * Read original conversation observations without creating work.
 */
export interface ConversationReader {
  /**
   * Read the initial native input once after a lost receipt and reuse that snapshot for observation.
   */
  acceptedMessage?(context: CallContext, run: RunView, signal: AbortSignal): Promise<{
    messageId: string
    observation?: RunObservation
    observationError?: unknown
  } | undefined>
  observe(context: CallContext, run: RunView, signal: AbortSignal, messageRef?: MessageRef): Promise<RunObservation>

}
/**
 * Supply validation, preparation and native ports to the shared start operation.
 */
export interface StartRunDependencies {
  store: RunStore
  runtime: ExecutionRuntime
  reader: ConversationReader
  /** Check current task, stage, activity and model without creating the prompt. */
  validate(context: CallContext, taskId: string, request: RunRequest, signal: AbortSignal): Promise<RunModel>
  validateDispatch(context: CallContext, taskId: string, run: RunView, signal: AbortSignal): Promise<void>
  /** Read or create the prompt only after native execution admission. */
  prepare(context: CallContext, taskId: string, attemptId: string, request: RunRequest, model: RunModel,
    admission: ExecutionAdmission, signal: AbortSignal): Promise<PreparedRun>
}
