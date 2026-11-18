/**
 * FILE: plugin/src/dsh-integration/execution/conversations.ts
 * DESCRIPTION: Observe the original native turn and exact linked messages
 */
import { ownMessage, withUiMessage, messageOf, externalMessage } from '../../ui-message.ts'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createHash } from 'node:crypto'
import type { ConversationReader, WorkObservation } from '../../step-execution/ports.ts'
import type { CallContext, MessageRef, NativeJson, RunObservation, RunView } from '../../step-execution/types.ts'
import { OperationRefusal } from '../../step-execution/application/observe-run.ts'
import { NativeSessionReader, type NativeConversationCut } from './session-reader.ts'

const messageEvents = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/ptc-dispatch', 'agent/inbox/spliced', 'turn/start', 'turn/end', 'step/start', 'step/end'])
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const json = (value: unknown): NativeJson => JSON.parse(JSON.stringify(value)) as NativeJson

/**
 * Native identified message entry, rather than arbitrary text or the last turn, selects the turn.
 */
function messageTurn(events: readonly SessionEvent[], messageId: string): { start: number; entry: number; end: number } | undefined {
  let start = -1
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'turn/start') start = index
    if (event.type === 'user/message' && event.data.id === messageId && start >= 0) {
      const turn = events[start]!
      if (turn.type !== 'turn/start') return undefined
      const end = events.findIndex((item, position) => position > index && item.type === 'turn/end' && item.data.turn === turn.data.turn)
      return { start, entry: index, end }
    }
    if (event.type === 'turn/end') start = -1
  }
  return undefined
}

/**
 * Read immutable native conversation facts independently of publication and task acceptance.
 */
export class NativeConversations implements ConversationReader {
  constructor(private readonly source: NativeSessionReader, private readonly work: WorkObservation) {}

  /**
   * Establish initial submission from the reserved conversation and exact original assignment, without creating work.
   */
  async acceptedMessage(context: CallContext, run: RunView, signal: AbortSignal) {
    if (run.dispatch?.phase !== 'submitting' || !run.promptSha256) return undefined
    const cut = await this.source.read(context, run.sessionId, signal)
    if (run.executionBackend?.kind === 'spawn-in-process' && cut.header.parentSession !== run.callerSessionId) throw withUiMessage(new OperationRefusal('state-conflict', 'The native parent differs from the saved run link'), ownMessage({ key: 'reasonTheNativeParentDiffersFromTheSavedRunLink' }))
    const initial = cut.events.flatMap(event => event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => message.source.kind === 'user')
    if (!initial) return undefined
    const assignment = initial.content[0]
    // DSH may append its own return guidance in a separate block after the original prompt.
    if (assignment?.type !== 'text' || createHash('sha256').update(assignment.text).digest('hex') !== run.promptSha256) return undefined
    const accepted: RunView = { ...run, status: 'running', dispatch: { phase: 'accepted', messageId: initial.id, reason: null },
      initialTurn: { turn: null, messageId: initial.id } }
    try { return { messageId: initial.id, observation: await this.observe(context, accepted, signal, undefined, cut) } }
    catch (observationError) { return { messageId: initial.id, observationError } }
  }

  /** Assemble run and message observations from their exact native conversation sources.
   */
  async observe(context: CallContext, run: RunView, signal: AbortSignal, messageRef?: MessageRef,
    executorCut?: NativeConversationCut): Promise<RunObservation> {
    const value: RunObservation = {
      link: run, initialOutcome: { state: 'unknown', reason: 'The initial native turn is not established at this read boundary', reasonMessage: { key: 'reasonTheInitialNativeTurnIsNotEstablishedAtThisReadBoundary' } },
      activity: await this.work.read(context, run, signal),
      availability: { executor: { state: 'unavailable' }, caller: run.callerSessionId ? { state: 'unavailable' } : null },
      ...(messageRef ? { messageRef } : {}), delivery: { state: 'not-requested' }, response: { state: 'unknown', reason: 'No message was selected', reasonMessage: { key: 'reasonNoMessageWasSelected' } }, result: null,
    }
    const cuts = new Map<string, NativeConversationCut>()
    if (run.dispatch?.phase === 'rejected') value.initialOutcome = { state: 'failed', reason: run.dispatch.reason ?? 'Native execution was rejected before publication', reasonMessage: run.dispatch.reasonMessage ?? { key: 'dispatchRejected' } }
    for (const [key, id] of [['executor', run.sessionId], ['caller', run.callerSessionId]] as const) {
      if (!id) continue
      if (key === 'executor' && (run.dispatch?.phase === 'registered' || run.dispatch?.phase === 'rejected')) {
        value.availability.executor = { state: 'unavailable', reason: 'The reserved executor identity was not published', reasonMessage: { key: 'reasonTheReservedExecutorIdentityWasNotPublished' } }
        continue
      }
      try {
        const cut = key === 'executor' && executorCut ? executorCut : await this.source.read(context, id, signal)
        if (key === 'executor' && run.executionBackend?.kind === 'spawn-in-process' && cut.header.parentSession !== run.callerSessionId) throw withUiMessage(new Error('The native parent differs from the saved run link'), ownMessage({ key: 'reasonTheNativeParentDiffersFromTheSavedRunLink' }))
        cuts.set(id, cut)
        value.availability[key] = { state: 'available' }
      } catch (error) {
        signal.throwIfAborted()
        value.availability[key] = { state: 'unavailable', reason: reason(error), reasonMessage: messageOf(error) ?? externalMessage('sourceUnavailable', error) }
        if (key === 'executor') value.activity.selected = { ...value.activity.selected, state: value.activity.selected.state === 'active' ? 'active' : 'unknown', complete: false, reasons: [...value.activity.selected.reasons, reason(error)] }
      }
    }
    const executor = cuts.get(run.sessionId)
    if (executor && !executor.events.some(event => event.type === 'turn/end')) {
      value.initialOutcome = { state: 'unknown', reason: 'The observed conversation has no completed DSH turn', reasonMessage: { key: 'reasonTheObservedConversationHasNoCompletedDSHTurn' },
        evidence: { kind: 'no-turn-end', observedThrough: executor.upper } }
    }
    const initialMessage = run.initialTurn?.messageId ?? run.dispatch?.messageId
    if (executor && initialMessage) {
      const turn = messageTurn(executor.events, initialMessage)
      const end = turn && turn.end >= 0 ? executor.events[turn.end] : undefined
      if (turn && end?.type === 'turn/end') {
        const kind = end.data.reason.kind
        const failure = end.data.reason.kind === 'error' ? end.data.reason.error.message : `DSH turn ended: ${kind}`
        value.initialOutcome = { state: kind === 'completed' ? 'completed' : ['interrupted', 'aborted'].includes(kind) ? 'interrupted' : 'failed', ...(kind === 'completed' ? {} : { reason: failure, reasonMessage: end.data.reason.kind === 'error' ? externalMessage('runFailed', end.data.reason.error.message) : { key: 'dshTurnEnded' as const, params: { kind } } }) }
        const events = executor.events.slice(turn.start, turn.end + 1)
        value.result = { content: json(finalAssistantOutput(events) ?? []),
          events: events.filter(event => messageEvents.has(event.type)).map(json) }
      }
    }
    if (!messageRef) {
      value.delivery = run.callerSessionId ? { state: 'unknown', reason: 'The delivery of the initial result is not linked to a specific native notification', reasonMessage: { key: 'reasonTheDeliveryOfTheInitialResultIsNotLinkedToASpecificNativeNotif' } } : { state: 'not-requested' }
      return value
    }
    const selected = messageRef
    const cut = cuts.get(selected.sessionId)
    if (!cut) { value.delivery = { state: 'unknown', messageId: selected.messageId, reason: 'The original message source is unavailable', reasonMessage: { key: 'reasonTheOriginalMessageSourceIsUnavailable' } }; return value }
    const inserted = cut.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : [])
      .find(message => message.id === selected.messageId)
    if (!inserted) {
      value.delivery = { state: selected.messageId === run.dispatch?.messageId && run.dispatch.phase === 'accepted' ? 'accepted' : 'unknown', messageId: selected.messageId, reason: 'The selected input is not retained in the observed prefix', reasonMessage: { key: 'reasonTheSelectedInputIsNotRetainedInTheObservedPrefix' } }
      value.response = { state: 'unknown', reason: 'The original input cannot be linked to a response', reasonMessage: { key: 'reasonTheOriginalInputCannotBeLinkedToAResponse' } }
      return value
    }
    const expectedSender = selected.sessionId === run.sessionId ? run.callerSessionId : run.sessionId
    if ((inserted.source.kind === 'agent-message' || inserted.source.kind === 'subagent-settled') && inserted.source.senderSessionId !== expectedSender) throw withUiMessage(new OperationRefusal('state-conflict', 'The native message sender does not match the saved conversation pair'), ownMessage({ key: 'reasonTheNativeMessageSenderDoesNotMatchTheSavedConversationPair' }))
    value.delivery = { state: 'accepted', messageId: selected.messageId, source: json(inserted.source) }
    const turn = messageTurn(cut.events, selected.messageId)
    if (!turn) value.response = { state: 'not-observed' }
    else {
      const following = cut.events.slice(turn.entry + 1, turn.end >= 0 ? turn.end + 1 : undefined)
      const output = following.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.length > 0))
      const intervening = following.some(event => event.type === 'user/message' && (!('form' in event.data.source) || event.data.source.form !== 'snapshot') && (!output || event.seq < output.seq))
      // A new substantive input or a control-only assistant message cannot establish an answer to this message.
      value.response = intervening ? { state: 'unknown', reason: 'Another native input prevents linking later output to this exact message', reasonMessage: { key: 'reasonAnotherNativeInputPreventsLinkingLaterOutputToThisExactMessage' } }
        : output ? { state: 'observed', evidence: json({ kind: 'assistant-message-in-consumed-turn', inputMessageId: selected.messageId, event: output }) }
          : following.some(event => event.type === 'assistant/message') ? { state: 'unknown', reason: 'Native control output does not establish a related answer', reasonMessage: { key: 'reasonNativeControlOutputDoesNotEstablishARelatedAnswer' } } : { state: 'not-observed' }
    }
    return value
  }

}
