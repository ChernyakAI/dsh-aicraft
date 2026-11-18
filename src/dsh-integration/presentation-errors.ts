/**
 * FILE: plugin/src/dsh-integration/presentation-errors.ts
 * DESCRIPTION: Preserve owner-provided message descriptors through native Remote failures
 */
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { messageOf } from '../ui-message.ts'

/**
 * Retain native codes and payloads; serialize metadata only for an explicitly described own error.
 */
export function presentationFailure(error: unknown): unknown {
  const uiMessage = messageOf(error)
  if (!uiMessage) return error
  const existing = remoteErrorOf(error)
  if (existing) return new RemoteError(existing.code, existing.message, { ...existing.details, uiMessage }, { cause: error })
  return new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), { uiMessage }, { cause: error })
}

/** Adapt unary and stream errors without changing inputs, values, cancellation or publication semantics.
 */
export function presentationErrors<This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result {
  return function (...args: Args): Result {
    try {
      const value = method.apply(this, args)
      if (value instanceof Promise) return value.catch((error) => { throw presentationFailure(error) }) as Result
      if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
        return (async function* () {
          try { yield* value as AsyncIterable<unknown> }
          catch (error) { throw presentationFailure(error) }
        })() as Result
      }
      return value
    } catch (error) { throw presentationFailure(error) }
  }
}
