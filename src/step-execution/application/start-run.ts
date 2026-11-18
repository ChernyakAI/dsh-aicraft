/**
 * FILE: plugin/src/step-execution/application/start-run.ts
 * DESCRIPTION: Publish an original attempt before native dispatch and retain uncertain outcomes
 */
import { ownMessage, withUiMessage } from '../../ui-message.ts'
import { advanceDispatch, sameAttempt } from '../domain/run-state.ts'
import type { StartRunDependencies } from '../ports.ts'
import type { CallContext, LastConfirmedState, OperationResult, RunObservation, RunRequest, RunView } from '../types.ts'
import { OperationRefusal, OperationUncertainty, operationProblem, verification } from './observe-run.ts'

/**
 * Classify the whole launch by native receipt and publication, retaining uncertainty after possible acceptance.
 * Repeated attempt IDs observe their original run before any new-start checks.
 */
export async function startRun(deps: StartRunDependencies, context: CallContext, taskId: string, attemptId: string,
  request: RunRequest, signal: AbortSignal): Promise<OperationResult<RunObservation>> {
  const check = verification(context, taskId, { attemptId })
  let externalMayHaveStarted = false
  let registrationMayHaveStarted = false
  let lookupCompleted = false
  let readingExisting = false
  let lastConfirmedState: LastConfirmedState | undefined
  let confirmation: { run: RunView; messageId: string; observation?: RunObservation } | undefined
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw withUiMessage(new OperationRefusal('invalid-input', 'attemptId must contain 1–128 letters, digits, underscores or hyphens'), ownMessage({ key: 'reasonAttemptIdMustContain1128LettersDigitsUnderscoresOrHyphens' }))
    return await deps.store.transaction(context, taskId, signal, async (writer) => {
      const previous = (await writer.read()).find(run => run.attemptId === attemptId)
      lookupCompleted = true
      if (previous) {
        if (!sameAttempt(previous, context.callerSessionId, request)) throw withUiMessage(new OperationRefusal('state-conflict', 'The attemptId already identifies a different original request'), ownMessage({ key: 'reasonTheAttemptIdAlreadyIdentifiesADifferentOriginalRequest' }))
        readingExisting = true
        lastConfirmedState = { taskId, attemptId, runId: previous.id,
          ...(previous.dispatch?.phase === 'accepted' ? { stepId: previous.stepId, sessionId: previous.sessionId } : {}) }
        let run = previous
        let recovered: Awaited<ReturnType<NonNullable<typeof deps.reader.acceptedMessage>>>
        if (run.dispatch?.phase === 'rejected') throw withUiMessage(new OperationRefusal('dependency-unavailable', run.dispatch.reason ?? 'The original dispatch was rejected'), run.dispatch.reasonMessage ?? ownMessage({ key: 'dispatchRejected', details: run.dispatch.reason ? [run.dispatch.reason] : [] }))
        if (run.dispatch?.phase !== 'accepted') {
          externalMayHaveStarted = run.dispatch?.phase === 'submitting'
          recovered = await deps.reader.acceptedMessage?.(context, run, signal)
          if (!recovered) return { operationStatus: 'unknown', problem: operationProblem(context, withUiMessage(new Error('Acceptance of the original assignment is not established'), ownMessage({ key: 'reasonAcceptanceOfTheOriginalAssignmentIsNotEstablished' }))), verification: check,
            lastConfirmedState }
          const messageId = recovered.messageId
          externalMayHaveStarted = true
          run = { ...advanceDispatch(run, { phase: 'accepted', messageId, reason: null }), status: 'running', initialTurn: { turn: null, messageId } }
          lastConfirmedState = { taskId, attemptId, runId: run.id, stepId: run.stepId, sessionId: run.sessionId }
          await writer.save(run)
        }
        if (!run.dispatch?.messageId) throw withUiMessage(new Error('The accepted original dispatch has no message receipt'), ownMessage({ key: 'reasonTheAcceptedOriginalDispatchHasNoMessageReceipt' }))
        confirmation = { run, messageId: run.dispatch.messageId }
        if (recovered?.observationError !== undefined) throw recovered.observationError
        confirmation.observation = recovered?.observation ?? await deps.reader.observe(context, run, signal)
        return { operationStatus: 'confirmed', value: confirmation.observation }
      }
      const model = await deps.validate(context, taskId, request, signal)
      const admission = await deps.runtime.admit(context, signal)
      try {
        const prepared = await deps.prepare(context, taskId, attemptId, request, model, admission, signal)
        registrationMayHaveStarted = true
        await writer.save(prepared.run)
        lastConfirmedState = { taskId, attemptId, runId: prepared.run.id }
        prepared.run = advanceDispatch(prepared.run, { phase: 'submitting', messageId: null, reason: null })
        await writer.save(prepared.run)
        try { await deps.validateDispatch(context, taskId, prepared.run, signal) }
        catch (error) {
          const problem = operationProblem(context, error)
          const rejected = advanceDispatch(prepared.run, { phase: 'rejected', messageId: null, reason: problem.message, reasonMessage: problem.uiMessage })
          await writer.save({ ...rejected, status: 'failed', finishedAt: new Date().toISOString(), error: problem.message, errorMessage: problem.uiMessage })
          return { operationStatus: 'rejected', problem: { ...problem, code: error instanceof OperationRefusal ? error.code : 'dependency-unavailable' } }
        }
        externalMayHaveStarted = true
        let result: OperationResult<{ messageId: string }>
        let recovered: Awaited<ReturnType<NonNullable<typeof deps.reader.acceptedMessage>>>
        try { result = await deps.runtime.start(context, prepared, signal) }
        catch (error) { result = { operationStatus: 'unknown', problem: operationProblem(context, error), verification: check } }
        if (result.operationStatus === 'unknown') {
          const uncertain = result
          try { recovered = await deps.reader.acceptedMessage?.(context, prepared.run, signal) }
          catch { /* Retain the original uncertain submission and its cause. */ }
          if (!recovered) return { ...uncertain, verification: check, lastConfirmedState }
          result = { operationStatus: 'confirmed', value: { messageId: recovered.messageId } }
        }
        if (result.operationStatus === 'rejected') {
          externalMayHaveStarted = false
          const rejected = advanceDispatch(prepared.run, { phase: 'rejected', messageId: null, reason: result.problem.message, reasonMessage: result.problem.uiMessage })
          await writer.save({ ...rejected, status: 'failed', finishedAt: new Date().toISOString(), error: result.problem.message, errorMessage: result.problem.uiMessage })
          return result
        }
        const accepted = advanceDispatch(prepared.run, { phase: 'accepted', messageId: result.value.messageId, reason: null })
        lastConfirmedState = { taskId, attemptId, runId: accepted.id, stepId: accepted.stepId, sessionId: accepted.sessionId }
        prepared.run = { ...accepted, status: 'running', initialTurn: { turn: null, messageId: result.value.messageId } }
        await writer.save(prepared.run)
        confirmation = { run: prepared.run, messageId: result.value.messageId }
        if (recovered?.observationError !== undefined) throw recovered.observationError
        confirmation.observation = recovered?.observation ?? await deps.reader.observe(context, prepared.run, signal)
        return { operationStatus: 'confirmed', value: confirmation.observation }
      } finally { deps.runtime.releaseAdmission(admission) }
    })
  } catch (error) {
    const problem = operationProblem(context, error)
    const presentation = problem.uiMessage ? { reasonMessage: problem.uiMessage } : {}
    const activityPresentation = problem.uiMessage ? { reasonMessages: [problem.uiMessage] } : {}
    if (confirmation) return { operationStatus: 'confirmed', refreshIssue: problem, value: confirmation.observation ?? {
      link: confirmation.run,
      initialOutcome: { state: 'unknown', reason: problem.message, ...presentation },
      activity: {
        selected: { state: 'unknown', complete: false, participants: [], reasons: [problem.message], ...activityPresentation },
        others: { state: 'unknown', complete: false, participants: [], reasons: [problem.message], ...activityPresentation },
      },
      availability: { executor: { state: 'unavailable', reason: problem.message, ...presentation },
        caller: confirmation.run.callerSessionId ? { state: 'unavailable', reason: problem.message, ...presentation } : null },
      delivery: { state: 'accepted', messageId: confirmation.messageId },
      response: { state: 'unknown', reason: problem.message, ...presentation },
      result: null,
    } }
    return error instanceof OperationRefusal && !externalMayHaveStarted
      || !registrationMayHaveStarted && !externalMayHaveStarted && !(error instanceof OperationUncertainty)
      && !readingExisting && (lookupCompleted || error instanceof OperationRefusal)
      ? { operationStatus: 'rejected', problem: { ...problem, code: error instanceof OperationRefusal ? error.code : 'dependency-unavailable' } }
      : { operationStatus: 'unknown', problem: { ...problem, code: 'outcome-unknown' },
        verification: error instanceof OperationUncertainty ? error.verification : check,
        ...(lastConfirmedState === undefined ? {} : { lastConfirmedState }) }
  }
}
