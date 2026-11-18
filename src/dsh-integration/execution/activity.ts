/**
 * FILE: plugin/src/dsh-integration/execution/activity.ts
 * DESCRIPTION: Observe native work with event-first discovery and exact job ownership
 */
import type { UiMessage } from '../../ui-message.ts'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-jobs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkObservation } from '../../step-execution/ports.ts'
import type { CallContext, CallerRef, RunView, WorkActivity } from '../../step-execution/types.ts'

const empty = (): WorkActivity => ({ state: 'inactive', complete: true, participants: [], reasons: [] })
const identity = (value: object | undefined): unknown => value ? Reflect.get(value, symbols.original) ?? value : value
/**
 * Track native lifecycle changes before snapshots so activity completeness can be established.
 */
export class NativeWorkObservation implements WorkObservation {
  private readonly observers = new Set<Set<string>>()
  private readonly activations = new Map<string, { sessionId: string; local: boolean }>()
  readonly pending = new Set<string>()
  readonly initial = new Set<string>()
  constructor(private readonly ctx: Context, private readonly resolveCaller: (ref: CallerRef) => Agent | undefined) {
    const changed = (...ids: (string | undefined)[]) => {
      for (const observer of this.observers) for (const id of ids) if (id) observer.add(id)
    }
    ctx.on('agent/created', ({ agent }) => { changed(agent.session.id, agent.session.header.parentSession); return undefined })
    ctx.on('agent/disposed', ({ agent }) => changed(agent.session.id, agent.session.header.parentSession))
    ctx.on('agent/status', ({ agent }) => changed(agent.session.id))
    ctx.on('subagent/start', (info) => {
      this.activations.set(info.runId, { sessionId: info.id, local: info.local })
      changed(info.id, ctx.agents.get(info.id)?.session.header.parentSession, info.local ? undefined : '*')
    })
    ctx.on('subagent/end', (info) => { this.activations.delete(info.runId); changed(info.id, info.local ? undefined : '*') })
  }

  /**
   * One bounded observation; a changing or unreadable composition stays incomplete.
   */
  async read(context: CallContext, run: RunView, signal: AbortSignal,
    excludeCallerTurn = false): Promise<{ selected: WorkActivity; others: WorkActivity }> {
    const unpublished = run.dispatch?.phase === 'registered' || run.dispatch?.phase === 'rejected'
    return this.readRoots(context, run.sessionId, new Set([...(unpublished ? [] : [run.sessionId]),
      ...(run.callerSessionId ? [run.callerSessionId] : [])]), signal, excludeCallerTurn)
  }

  /** Observe work owned by the actual calling conversation.
   */
  async caller(context: CallContext, signal: AbortSignal): Promise<{ selected: WorkActivity; others: WorkActivity }> {
    if (!context.callerSessionId) return { selected: empty(), others: empty() }
    return this.readRoots(context, context.callerSessionId, new Set([context.callerSessionId]), signal, true)
  }

  /**
   * Observe exact work owners and retain incomplete discovery as unknown activity.
   */
  private async readRoots(context: CallContext, selectedId: string, roots: Set<string>, signal: AbortSignal,
    excludeCallerTurn: boolean): Promise<{ selected: WorkActivity; others: WorkActivity }> {
    const changes = new Set<string>(), selected = empty(), others = empty()
    const caller = excludeCallerTurn && context.callerRef ? this.resolveCaller(context.callerRef) : undefined
    this.observers.add(changes)
    const jobs = this.ctx.get('jobs')
    let unsubscribe: (() => void) | undefined
    try {
      const known = new Set(roots)
      const unknown = (reason: string, descriptor: UiMessage) => {
        others.complete = false; others.reasons.push(reason); (others.reasonMessages ??= []).push(descriptor)
      }
      if (!jobs) unknown('Native job observation is unavailable', { key: 'reasonNativeJobObservationIsUnavailable' })
      else {
        try {
          unsubscribe = jobs.events.subscribe({ owners: 'all' }, (event) => {
            const owner = 'job' in event ? event.job.owner : event.owner
            if (owner) changes.add(owner)
          })
        } catch (error) { unknown(`Native job events unavailable: ${error instanceof Error ? error.message : String(error)}`, { key: 'reasonNativeJobEventsUnavailableValue0', params: { value0: error instanceof Error ? error.message : String(error) } }) }
      }
      const runtime = this.ctx.get('subagents')
      for (const root of roots) {
        if (!runtime) { unknown('Native descendant discovery is unavailable', { key: 'reasonNativeDescendantDiscoveryIsUnavailable' }); continue }
        try {
          for (const row of await runtime.listDescendants(brandString<SessionId>(root), signal)) {
            known.add(row.id)
            if (row.kind === 'diagnostic') unknown(`${row.id}: ${row.reason}`, { key: 'reasonValue0Value1', params: { value0: row.id, value1: row.reason } })
            // rc.5 catalog activity reports Session residency, not an executing model turn.
            else if (row.mode === 'external' && ![...this.activations.values()].some(item => item.sessionId === row.id)) unknown(`${row.id}: external execution state is not established`, { key: 'reasonValue0ExternalExecutionStateIsNotEstablished', params: { value0: row.id } })
          }
        } catch (error) { unknown(`${root}: ${error instanceof Error ? error.message : String(error)}`, { key: 'reasonValue0Value1', params: { value0: root, value1: error instanceof Error ? error.message : String(error) } }) }
      }
      for (const id of known) {
        signal.throwIfAborted()
        const target = id === selectedId ? selected : others
        const agent = this.ctx.agents.get(brandString<SessionId>(id))
        const ownTurn = excludeCallerTurn && id === context.callerSessionId && agent !== undefined
          && agent === caller && agent.status !== 'idle'
        if (agent && agent.status !== 'idle' && !ownTurn) target.participants.push({ sessionId: id, kind: 'turn', id })
        if (this.pending.has(id)) target.participants.push({ sessionId: id, kind: 'start', id })
        if (this.initial.has(id) && !ownTurn) others.participants.push({ sessionId: id, kind: 'activation', id })
        for (const [activationId, activation] of this.activations) if (activation.sessionId === id && !ownTurn) {
          // The current caller turn is also wrapped by its activation; count settling after that turn, not twice.
          // Descendants, exact-owner jobs and unconfirmed starts remain independently visible.
          others.participants.push({ sessionId: id, kind: 'activation', id: activationId })
        }
        // Descendant jobs and the selected conversation's jobs are separate from its own model turn.
        for (const job of jobs?.list(brandString<SessionId>(id)) ?? []) {
          if (job.owner === id && (job.status === 'running' || job.status === 'stopping')) others.participants.push({ sessionId: id, kind: 'job', id: job.id })
        }
      }
      if (changes.has('*') || [...known].some(id => changes.has(id))) unknown('Related native work changed during discovery', { key: 'reasonRelatedNativeWorkChangedDuringDiscovery' })
      if (identity(this.ctx.get('jobs')) !== identity(jobs)) unknown('Native job service changed during discovery', { key: 'reasonNativeJobServiceChangedDuringDiscovery' })
      for (const value of [selected, others]) value.state = value.participants.length ? 'active' : value.complete ? 'inactive' : 'unknown'
      return { selected, others }
    } finally { unsubscribe?.(); this.observers.delete(changes) }
  }
}
