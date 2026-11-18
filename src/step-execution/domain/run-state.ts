/**
 * FILE: plugin/src/step-execution/domain/run-state.ts
 * DESCRIPTION: Apply immutable attempt identity and dispatch knowledge without platform dependencies
 */
import { ownMessage, withUiMessage } from '../../ui-message.ts'
import type { RunDispatch, RunModel, RunRequest, RunView } from '../types.ts'

const sameModel = (left: RunModel | null, right: RunModel | null): boolean =>
  left === null || right === null ? left === right : left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort

/**
 * A retry compares the original explicit request, never the current model or prompt.
 */
export function sameAttempt(run: RunView, callerSessionId: string | null, request: RunRequest): boolean {
  return run.request !== undefined && run.callerSessionId === callerSessionId
    && run.request.stepId === request.stepId
    && sameModel(run.request.modelOverride, request.modelOverride)
}

/**
 * Preserve known acceptance and all original links when recording later facts.
 */
export function advanceDispatch(run: RunView, next: RunDispatch): RunView {
  const current = run.dispatch
  if (!current) throw withUiMessage(new Error('Legacy records cannot acquire guessed dispatch facts'), ownMessage({ key: 'reasonLegacyRecordsCannotAcquireGuessedDispatchFacts' }))
  const allowed: Record<RunDispatch['phase'], RunDispatch['phase'][]> = {
    registered: ['registered', 'submitting', 'rejected'],
    submitting: ['submitting', 'accepted', 'rejected'],
    accepted: ['accepted'], rejected: ['rejected'],
  }
  if (!allowed[current.phase].includes(next.phase)) throw withUiMessage(new Error('Dispatch facts cannot be reversed'), ownMessage({ key: 'reasonDispatchFactsCannotBeReversed' }))
  if (current.messageId !== null && current.messageId !== next.messageId) throw withUiMessage(new Error('The initial message link is immutable'), ownMessage({ key: 'reasonTheInitialMessageLinkIsImmutable' }))
  if (current.reason !== null && current.reason !== next.reason) throw withUiMessage(new Error('An established dispatch reason is immutable'), ownMessage({ key: 'reasonAnEstablishedDispatchReasonIsImmutable' }))
  if (next.phase === 'accepted' && !next.messageId) throw withUiMessage(new Error('Acceptance requires the native message identity'), ownMessage({ key: 'reasonAcceptanceRequiresTheNativeMessageIdentity' }))
  if (next.phase === 'rejected' && !next.reason) throw withUiMessage(new Error('Rejection requires an established reason'), ownMessage({ key: 'reasonRejectionRequiresAnEstablishedReason' }))
  return { ...run, dispatch: { ...next } }
}

/**
 * An exception after submitting is not proof that execution failed.
 */
export function dispatchKnowledge(run: RunView): 'accepted' | 'rejected' | 'unknown' {
  return run.dispatch?.phase === 'accepted' ? 'accepted' : run.dispatch?.phase === 'rejected' ? 'rejected' : 'unknown'
}

/**
 * Reject a stale writer attempting to change the original request or saved links.
 */
export function assertRunIdentity(previous: RunView, next: RunView): void {
  const fields = ['id', 'taskId', 'stepId', 'sessionId', 'attemptId', 'callerSessionId', 'promptVersion', 'promptSha256', 'outputPath', 'startedAt'] as const
  if (fields.some(field => previous[field] !== next[field])
    || !sameModel(previous.model, next.model)
    || previous.executionBackend?.kind !== next.executionBackend?.kind
      || previous.executionBackend?.providerName !== next.executionBackend?.providerName
    || previous.initialTurn?.messageId != null && previous.initialTurn.messageId !== next.initialTurn?.messageId
    || previous.initialTurn?.turn != null && previous.initialTurn.turn !== next.initialTurn?.turn
    || (previous.request ? !sameAttempt(next, previous.callerSessionId ?? null, previous.request) : next.request !== undefined)) {
    throw withUiMessage(new Error('The original run identity is immutable'), ownMessage({ key: 'reasonTheOriginalRunIdentityIsImmutable' }))
  }
}
