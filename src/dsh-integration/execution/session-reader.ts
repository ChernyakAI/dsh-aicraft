/**
 * FILE: plugin/src/dsh-integration/execution/session-reader.ts
 * DESCRIPTION: Lease one exact native conversation cut without publishing an agent
 */
import { ownMessage, withUiMessage } from '../../ui-message.ts'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-query'
import { resolve } from 'node:path'
import type { CallContext } from '../../step-execution/types.ts'
import { OperationRefusal } from '../../step-execution/application/observe-run.ts'

export interface NativeConversationCut { header: SessionHeader; events: readonly SessionEvent[]; upper: number }

export class NativeSessionReader {
  constructor(private readonly ctx: Context) {}
  /** Read a consistent Session Query cut within an automatically released observation.
   */
  async read(context: CallContext, sessionId: string, signal: AbortSignal): Promise<NativeConversationCut> {
    signal.throwIfAborted()
    using observation = await this.ctx.sessionQuery.observeSession(brandString<SessionId>(sessionId), { signal, projectionMode: 'all' })
    if (observation.header.id !== sessionId || !observation.header.cwd || resolve(observation.header.cwd) !== resolve(context.projectRoot)) throw withUiMessage(new OperationRefusal('access-denied', 'The conversation source does not belong to the original project'), ownMessage({ key: 'reasonTheConversationSourceDoesNotBelongToTheOriginalProject' }))
    const events = observation.events
    if ((events.at(-1)?.seq ?? -1) !== observation.cursor || observation.projections && observation.projections.asOfSeq !== observation.cursor) throw withUiMessage(new Error('The native conversation cut is inconsistent'), ownMessage({ key: 'reasonTheNativeConversationCutIsInconsistent' }))
    return { header: observation.header, events, upper: observation.cursor }
  }
}
