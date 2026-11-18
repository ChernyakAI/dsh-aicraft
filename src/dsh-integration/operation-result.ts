/**
 * FILE: plugin/src/dsh-integration/operation-result.ts
 * DESCRIPTION: Adapt owner-reported publication boundaries to the common Remote and tool result
 */
import { ownMessage, withUiMessage } from '../ui-message.ts'
import type { CallContext, LastConfirmedState, MutationProgress, OperationProblem, OperationResult, VerificationRequest } from '../step-execution/types.ts'
import { OperationRefusal, operationProblem } from '../step-execution/application/observe-run.ts'

/**
 * Preserve confirmation independently of errors during later refresh or lock release.
 */
export async function mutationResult<T>(context: CallContext, verification: VerificationRequest,
  perform: (progress: MutationProgress<T>) => Promise<unknown>): Promise<OperationResult<T>> {
  let submitted = false
  let lastConfirmedState: LastConfirmedState | undefined
  let confirmation: { value: T } | undefined
  try {
    await perform({ submitting() { submitted = true }, confirmed(value) { confirmation = { value } },
      lastConfirmed(value) { lastConfirmedState = value } })
    if (!confirmation) throw withUiMessage(new Error('The operation returned without publication confirmation'), ownMessage({ key: 'reasonTheOperationReturnedWithoutPublicationConfirmation' }))
    return { operationStatus: 'confirmed', value: confirmation.value }
  } catch (error) {
    const problem = operationProblem(context, error)
    if (confirmation) return { operationStatus: 'confirmed', value: confirmation.value, refreshIssue: problem }
    if (error !== null && typeof error === 'object' && 'code' in error && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes(String(error.code))) {
      return { operationStatus: 'rejected', problem: { ...problem, code: 'version-conflict' } }
    }
    if (error instanceof OperationRefusal) return { operationStatus: 'rejected', problem }
    if (error !== null && typeof error === 'object' && 'code' in error && ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code))) {
      return { operationStatus: 'rejected', problem: { ...problem, code: 'access-denied' } }
    }
    if (!submitted) return { operationStatus: 'rejected', problem: { ...problem, code: error instanceof OperationRefusal ? error.code : 'dependency-unavailable' } }
    return { operationStatus: 'unknown', problem: { ...problem, code: 'outcome-unknown' }, verification, ...(lastConfirmedState === undefined ? {} : { lastConfirmedState }) }
  }
}

/**
 * Read-only failures cannot be successful empty reads or mutation confirmations.
 */
export async function readResult<T>(context: CallContext, read: () => Promise<T>): Promise<OperationResult<T>> {
  try { return { operationStatus: 'confirmed', value: await read() } }
  catch (error) { return { operationStatus: 'rejected', problem: { ...operationProblem(context, error), code: error instanceof OperationRefusal ? error.code : 'dependency-unavailable' } } }
}

/**
 * Presentation consumes the union without changing its meaning or retrying.
 */
export function requireConfirmation<T>(result: OperationResult<T>): T {
  if (result.operationStatus === 'confirmed') return result.value
  throw new OperationPresentationError(result.problem, result.operationStatus === 'unknown' ? result.verification : undefined)
}

/**
 * Present a known problem with the original read address when the mutation outcome is unknown.
 */
export class OperationPresentationError extends Error {
  constructor(readonly problem: OperationProblem, readonly verification?: VerificationRequest) {
    super(verification ? `${problem.message} Outcome unknown. Read the original ${verification.operation}; do not repeat the change.` : problem.message)
  }
}
