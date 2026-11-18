/**
 * FILE: plugin/src/step-execution/application/observe-run.ts
 * DESCRIPTION: Read one original attempt without dispatch, recovery writes or polling
 */
import { ownMessage, withUiMessage, messageOf } from '../../ui-message.ts'
import type { ConversationReader, RunStore } from '../ports.ts'
import type { CallContext, LastConfirmedState, MessageRef, OperationProblem, OperationResult, RunObservation, RunView, VerificationRequest } from '../types.ts'

/**
 * Only an explicitly established refusal can be reported as rejected.
 */
export class OperationRefusal extends Error {
  constructor(readonly code: Exclude<OperationProblem['code'], 'outcome-unknown'>, message: string, options?: ErrorOptions) { super(message, options) }
}

/**
 * A preparation-side write may have happened even though no Run was registered.
 */
export class OperationUncertainty extends Error {
  constructor(message: string, readonly verification: VerificationRequest, options?: ErrorOptions) { super(message, options) }
}

/**
 * Keep the typed problem, original cause and call identity in the common operation result.
 */
export function operationProblem(context: CallContext, error: unknown): OperationProblem {
  const cause = error instanceof Error ? error.cause : undefined
  return { code: error instanceof OperationRefusal ? error.code : 'outcome-unknown',
    message: error instanceof Error ? error.message : String(error), correlationId: context.callId,
    ...(messageOf(error) ? { uiMessage: messageOf(error) } : {}),
    ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }) }
}

export function verification(context: CallContext, taskId: string, selector: { runId?: string; attemptId?: string }): VerificationRequest {
  return { workspaceId: context.workspaceId, taskId, ...selector, operation: 'run' }
}

/**
 * Select exactly one original run or attempt without substituting a later execution.
 */
export async function findRun(store: RunStore, context: CallContext, taskId: string,
  selector: { runId?: string; attemptId?: string }, signal: AbortSignal): Promise<RunView | undefined> {
  if (Boolean(selector.runId) === Boolean(selector.attemptId)) throw withUiMessage(new OperationRefusal('invalid-input', 'Specify exactly one runId or attemptId'), ownMessage({ key: 'reasonSpecifyExactlyOneRunIdOrAttemptId' }))
  const runs = await store.read(context, taskId, signal)
  return runs.find(run => selector.runId !== undefined ? run.id === selector.runId : run.attemptId === selector.attemptId)
}

/**
 * Reject foreign message addresses before touching their conversation sources.
 */
export function assertConversation(run: RunView, sessionId: string): void {
  if (sessionId !== run.sessionId && sessionId !== run.callerSessionId) throw withUiMessage(new OperationRefusal('access-denied', 'The conversation is not linked to this run'), ownMessage({ key: 'reasonTheConversationIsNotLinkedToThisRun' }))
}

/** Resolve the original run or attempt and delegate its observation to the conversation reader.
 */
export async function observeRun(store: RunStore, reader: ConversationReader, context: CallContext, taskId: string,
  selector: { runId?: string; attemptId?: string }, signal: AbortSignal, expectedWorkspaceId?: string,
  messageRef?: MessageRef): Promise<OperationResult<RunObservation>> {
  let lastConfirmedState: LastConfirmedState | undefined
  try {
    if (expectedWorkspaceId !== undefined && expectedWorkspaceId !== context.workspaceId) throw withUiMessage(new OperationRefusal('state-conflict', 'The session project differs from the original workspace'), ownMessage({ key: 'reasonTheSessionProjectDiffersFromTheOriginalWorkspace' }))
    const run = await findRun(store, context, taskId, selector, signal)
    if (!run) return { operationStatus: 'unknown', problem: operationProblem(context, withUiMessage(new Error('The original attempt is not recorded at this read boundary'), ownMessage({ key: 'reasonTheOriginalAttemptIsNotRecordedAtThisReadBoundary' }))), verification: { ...verification(context, taskId, selector), workspaceId: expectedWorkspaceId ?? context.workspaceId } }
    const publishedLink = run.dispatch === undefined || run.dispatch.phase === 'accepted'
    lastConfirmedState = { taskId, runId: run.id, ...(run.attemptId ? { attemptId: run.attemptId } : {}),
      ...(publishedLink ? { stepId: run.stepId, sessionId: run.sessionId,
        initialAssignmentStatus: 'unknown' as const, conversationActivity: 'unknown' as const } : {}) }
    if (messageRef) assertConversation(run, messageRef.sessionId)
    return { operationStatus: 'confirmed', value: await reader.observe(context, run, signal, messageRef) }
  } catch (error) {
    const problem = operationProblem(context, error)
    return error instanceof OperationRefusal ? { operationStatus: 'rejected', problem }
      : { operationStatus: 'unknown', problem,
        verification: { ...verification(context, taskId, selector), workspaceId: expectedWorkspaceId ?? context.workspaceId },
        ...(lastConfirmedState === undefined ? {} : { lastConfirmedState }) }
  }
}
