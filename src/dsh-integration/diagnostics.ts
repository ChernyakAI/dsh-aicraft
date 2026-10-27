/**
 * FILE: plugin/src/dsh-integration/diagnostics.ts
 * DESCRIPTION: Carry operation context and publish diagnostic facts without changing business outcomes
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type { DiagnosticContext, DiagnosticEvent, DiagnosticSource } from './types.ts'

const storage = new AsyncLocalStorage<DiagnosticContext>()
const observers = new Set<(event: DiagnosticEvent) => void>()
const rejectedErrors = new WeakSet<object>()
const processInstance = randomUUID()
const accepted = new WeakSet<object>()

/**
 * START_METHOD_diagnosticContext
 * Run one action with an isolated causal context; child operations share its sequence.
 */
export function diagnosticContext<T>(context: Partial<DiagnosticContext>, execute: () => T): T {
  const parent = storage.getStore()
  const value: DiagnosticContext = {
    ...parent, ...context,
    correlationId: context.correlationId ?? parent?.correlationId ?? randomUUID(),
    sequence: context.sequence ?? parent?.sequence ?? { value: 0 },
  }
  return storage.run(value, execute)
}
// END_METHOD_diagnosticContext

/**
 * START_METHOD_observeDiagnostics
 * Subscribe before an action; disposal prevents further delivery to this observer.
 */
export function observeDiagnostics(observe: (event: DiagnosticEvent) => void): () => void {
  observers.add(observe)
  return () => { observers.delete(observe) }
}
// END_METHOD_observeDiagnostics

/**
 * START_METHOD_diagnosticEvent
 * Publish a boundary fact with source and causal identity, never a criterion verdict.
 */
export function diagnosticEvent(type: string, data: Record<string, unknown> = {}, source?: DiagnosticSource): void {
  const context = storage.getStore()
  if (!context || !observers.size) return
  const { sequence, ...identity } = context
  const event: DiagnosticEvent = {
    schemaVersion: 2, producer: 'aicraft.server', instanceId: `${processInstance}:${context.correlationId}`,
    seq: ++sequence.value, ...identity, type, source: source ?? context.source ?? { path: 'src/dsh-integration/diagnostics.ts' }, data,
  }
  for (const observer of observers) {
    // An observer cannot change a committed business operation. Missing delivery is detected by sequence/high-water checks.
    try { observer(event) } catch { /* The checking side owns collection failures. */ }
  }
}
// END_METHOD_diagnosticEvent

/**
 * START_METHOD_diagnosticRejection
 * Mark an existing domain refusal without replacing its error identity or stack.
 */
export function diagnosticRejection<T>(error: T): T {
  if (typeof error === 'object' && error !== null) rejectedErrors.add(error)
  return error
}
// END_METHOD_diagnosticRejection

/**
 * START_METHOD_diagnosticAccepted
 * Record validated inputs at their actual acceptance boundary.
 */
export function diagnosticAccepted(data: Record<string, unknown> = {}): void {
  const context = storage.getStore()
  if (context && !accepted.has(context)) {
    for (const key of ['runId', 'sessionId', 'taskId', 'stepId', 'workspaceId'] as const) if (typeof data[key] === 'string') context[key] = data[key]
    accepted.add(context)
    diagnosticEvent('input.accepted', { fields: Object.keys(data), encoding: 'json-v1',
      sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') })
  }
}
// END_METHOD_diagnosticAccepted

/**
 * START_METHOD_diagnosticCommitted
 * Record publication after a successful write or rename, excluding staging files.
 */
export function diagnosticCommitted(data: Record<string, unknown> = {}): void {
  diagnosticEvent('persistence.committed', data)
}
// END_METHOD_diagnosticCommitted

function failure(error: unknown, seen = new WeakSet<object>()): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) }
  if (seen.has(error)) return { name: error.name, circularCause: true }
  seen.add(error)
  return { name: error.name, message: error.message, stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: failure(error.cause, seen) }) }
}

function finishError(error: unknown): void {
  const code = (error as { code?: string })?.code
  const cancelled = (error as Error)?.name === 'AbortError' || code === 'FS_ABORTED'
  const rejected = typeof error === 'object' && error !== null && (rejectedErrors.has(error)
    || (error as Error).name === 'ZodError' || ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_NOT_TEXT', 'FS_TOO_LARGE'].includes(code ?? ''))
  diagnosticEvent(cancelled ? 'operation.cancelled' : rejected ? 'operation.rejected' : 'operation.failed', { error: failure(error) })
}

/**
 * START_METHOD_diagnosticOperation
 * Observe a real operation, preserving its exact result and thrown error.
 */
export async function diagnosticOperation<T>(
  source: DiagnosticSource, identity: Partial<DiagnosticContext>, execute: () => Promise<T>,
): Promise<T> {
  const parent = storage.getStore()
  if (!parent && !observers.size) return execute()
  return diagnosticContext({ ...identity, source, operationId: randomUUID(), parentOperationId: parent?.operationId }, async () => {
    diagnosticEvent('operation.started')
    try {
      const result = await execute()
      diagnosticAccepted()
      diagnosticEvent('operation.completed')
      return result
    } catch (error) {
      try { finishError(error) } catch { /* An unrecordable failure still preserves the original error. */ }
      throw error
    }
  })
}
// END_METHOD_diagnosticOperation

/**
 * START_METHOD_diagnosticStream
 * Keep stream operations in their originating context across next, return and cancellation.
 */
export async function* diagnosticStream<T>(
  source: DiagnosticSource, identity: Partial<DiagnosticContext>, create: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const parent = storage.getStore()
  if (!parent && !observers.size) { yield* create(); return }
  const context: Partial<DiagnosticContext> = {
    correlationId: parent?.correlationId ?? randomUUID(), sequence: parent?.sequence ?? { value: 0 },
    ...identity, source, operationId: randomUUID(), parentOperationId: parent?.operationId,
  }
  let iterator: AsyncIterator<T> | undefined
  let ended = false
  try {
    iterator = diagnosticContext(context, () => {
      diagnosticEvent('operation.started')
      diagnosticAccepted()
      return create()[Symbol.asyncIterator]()
    })
    while (true) {
      const item = await diagnosticContext(context, () => iterator!.next())
      if (item.done) break
      yield item.value
    }
    diagnosticContext(context, () => diagnosticEvent('operation.completed'))
    ended = true
  } catch (error) {
    try { diagnosticContext(context, () => finishError(error)) } catch { /* Preserve the original stream error. */ }
    ended = true
    throw error
  } finally {
    if (iterator?.return) await diagnosticContext(context, () => iterator!.return!())
    if (!ended) diagnosticContext(context, () => diagnosticEvent('operation.cancelled', { reason: 'consumer closed stream' }))
  }
}
// END_METHOD_diagnosticStream

/**
 * START_METHOD_diagnosticPublication
 * Observe successful publication at an actual filesystem mutation, never at staging writes.
 */
export async function diagnosticPublication<T>(execute: () => Promise<T>, target: unknown, kind: string): Promise<T> {
  diagnosticAccepted({ kind })
  const result = await execute()
  const path = typeof target === 'string' ? target : String((target as { displayPath?: string })?.displayPath ?? '')
  if (!/(?:^|[\\/])tasks[\\/]\.creating-[^\\/]+(?:[\\/]|$)/.test(path)) diagnosticCommitted({ path, kind })
  return result
}
// END_METHOD_diagnosticPublication
