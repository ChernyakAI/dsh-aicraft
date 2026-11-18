/**
 * FILE: plugin/src/step-execution/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
import type { UiMessage } from '../ui-message.ts'
/**
 * A model route for one run, independent of DSH's global default.
 */
export interface RunModel {
  provider: string
  model: string
  reasoningEffort: string | null
}

/**
 * Durable task/stage linkage to a separate DSH session.
 */
export interface RunView {
  id: string
  stepId: string
  sessionId: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  outputPath: string
  model: RunModel
  error: string | null
  errorMessage?: UiMessage
  /** Absent only on records written before attempt tracking was introduced. */
  taskId?: string
  attemptId?: string
  callerSessionId?: string | null
  request?: RunRequest
  dispatch?: RunDispatch
  initialTurn?: { turn: number | null; messageId: string | null }
  promptVersion?: string
  promptSha256?: string
  executionBackend?: { kind: 'standalone' | 'spawn-in-process'; providerName: string | null }
}

/**
 * Explicit inputs remain independent of the resolved model and later prompt edits.
 */
export interface RunRequest {
  stepId: string
  modelOverride: RunModel | null
}

/**
 * Durable dispatch knowledge, separate from the model's outcome.
 */
export interface RunDispatch {
  phase: 'registered' | 'submitting' | 'accepted' | 'rejected'
  messageId: string | null
  reason: string | null
  reasonMessage?: UiMessage
}

/**
 * Only the integration adapter can resolve this reference to a native caller.
 */
export type CallerRef = object & { readonly callerRef: unique symbol }

/**
 * Trusted original project, actual caller and standing permissions supplied by integration.
 */
export interface CallContext {
  workspaceId: string
  projectRoot: string
  source: 'panel' | 'agent'
  callId: string
  callerSessionId: string | null
  callerRef: CallerRef | null
  permissions: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
}

/**
 * Known problem and original call identity returned separately from mutation confirmation.
 */
export interface OperationProblem {
  code: 'invalid-input' | 'access-denied' | 'not-found' | 'state-conflict' | 'version-conflict' | 'dependency-unavailable' | 'outcome-unknown'
  message: string
  uiMessage?: UiMessage
  cause?: string
  correlationId: string
}

/**
 * Address the original object for explicit verification after an unknown outcome.
 */
export interface VerificationRequest {
  workspaceId: string
  taskId: string
  runId?: string
  attemptId?: string
  operation: 'run' | 'task' | 'material'
  path?: string
}

/**
 * Separate established confirmation, known refusal and an outcome requiring original-object verification.
 */
export type OperationResult<T> =
  | { operationStatus: 'confirmed'; value: T; refreshIssue?: OperationProblem }
  | { operationStatus: 'rejected'; problem: OperationProblem }
  | { operationStatus: 'unknown'; problem: OperationProblem; verification: VerificationRequest; lastConfirmedState?: LastConfirmedState }

/**
 * Publication boundaries supplied by the owning operation, never inferred from error text.
 */
export interface MutationProgress<T> {
  submitting(): void
  confirmed(value: T): void
  lastConfirmed?(value: LastConfirmedState): void
}

/**
 * Address an exact native message in a linked conversation.
 */
export interface MessageRef { sessionId: string; messageId: string }
/**
 * Retain source availability independently of delivery, outcome and activity.
 */
export interface SourceAvailability { state: 'available' | 'unavailable'; reason?: string; reasonMessage?: UiMessage }
/**
 * Native message data crosses ports as lossless JSON, without a platform type dependency.
 */
export type NativeJson = null | boolean | number | string | NativeJson[] | { [key: string]: NativeJson }
/**
 * Describe exact known work participants and the completeness of their observation.
 */
export interface WorkActivity {
  state: 'active' | 'inactive' | 'unknown'
  complete: boolean
  participants: { sessionId: string; kind: 'turn' | 'activation' | 'job' | 'start'; id: string }[]
  reasons: string[]
  reasonMessages?: UiMessage[]
}

/**
 * Combine original run links with independent outcome, activity, availability and message facts.
 */
export interface RunObservation {
  link: RunView
  initialOutcome: { state: 'completed' | 'failed' | 'interrupted' | 'unknown'; reason?: string; reasonMessage?: UiMessage; evidence?: { kind: 'no-turn-end'; observedThrough: number } }
  activity: { selected: WorkActivity; others: WorkActivity }
  availability: { executor: SourceAvailability; caller: SourceAvailability | null }
  messageRef?: MessageRef
  delivery: { state: 'not-requested' | 'pending' | 'accepted' | 'rejected' | 'unknown'; messageId?: string; source?: NativeJson; reason?: string; reasonMessage?: UiMessage }
  response: { state: 'not-observed' | 'observed' | 'unknown'; evidence?: NativeJson; reason?: string; reasonMessage?: UiMessage }
  result: { content: NativeJson; events: NativeJson[] } | null
}

/**
 * Previously established public facts, separate from claims about current state.
 */
export interface LastConfirmedState {
  taskId?: string
  status?: 'open' | 'completed' | 'cancelled'
  currentStep?: string | null
  attemptId?: string
  runId?: string
  stepId?: string
  sessionId?: string
  initialAssignmentStatus?: RunObservation['initialOutcome']['state']
  conversationActivity?: WorkActivity['state']
}
