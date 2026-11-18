/**
 * FILE: plugin/src/dsh-integration/execution/runtime.ts
 * DESCRIPTION: Own native execution admission, exact spawn dispatch and standalone agent lifetime
 */
import { ownMessage, withUiMessage } from '../../ui-message.ts'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-subagent'
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { randomUUID } from 'node:crypto'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ExecutionAdmission, ExecutionRuntime, PreparedRun } from '../../step-execution/ports.ts'
import type { CallContext, CallerRef, OperationResult, RunView } from '../../step-execution/types.ts'
import { OperationRefusal, operationProblem, verification } from '../../step-execution/application/observe-run.ts'
import type { NativeWorkObservation } from './activity.ts'
import { diagnosticAccepted, diagnosticEvent, diagnosticFailure } from '../diagnostics.ts'

// Cordis re-creates traced wrappers; compare their documented original targets.
const nativeIdentity = (value: unknown): unknown => value && (typeof value === 'object' || typeof value === 'function')
  ? Reflect.get(value, symbols.original) ?? value : value
/**
 * The installed host can load another SDK module instance; use the seam's typed code vocabulary to recognize refusals.
 */
const nativeRefusal = (error: unknown, codes: string[]): boolean => error !== null && typeof error === 'object'
  && 'code' in error && typeof error.code === 'string' && codes.includes(error.code)

interface NativeAdmission {
  context: CallContext
  services: unknown[]
  sessionId: string
  unlisten?: () => void
  prepared?: PreparedRun
  accountingFailed: boolean
}

/**
 * Own native executor handles and lifecycle subscriptions, releasing archived idle chats safely.
 */
export class NativeExecutionRuntime implements ExecutionRuntime {
  private readonly admissions = new WeakMap<object, NativeAdmission>()
  private readonly handles = new Map<string, AgentHandle>()
  private readonly active = new Set<string>()
  private readonly releasing = new Set<string>()
  private archivedSessions = new Set<SessionId>()
  private releaseRevision = 0
  private stopping = false

  /**
   * @param ctx - Service context with DSH execution and persistence dependencies.
   */
  constructor(
    private readonly ctx: Context,
    private readonly trackStatistics: ((agent: Agent) => Promise<void>) | undefined,
    private readonly resolveCaller: (ref: CallerRef) => Agent | undefined,
    private readonly work: NativeWorkObservation,
    private readonly onSettled: (context: CallContext, run: RunView) => Promise<void>,
  ) {
    this.archivedSessions = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    ctx.on('domain/changed', (change) => {
      if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
      // Read the committed event: the registry's cached state updates after this notification.
      this.archivedSessions = new Set(workspaceDomainState.parse(change.value).archivedSessionIds)
      this.releaseIdleHandles()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const [id, handle] of this.handles) if (handle.agent === agent) {
        this.handles.delete(id)
        this.active.delete(id)
        this.work.initial.delete(agent.session.id)
      }
    })
    ctx.on('agent/status', ({ status }) => { if (status === 'idle') this.releaseIdleHandles() })
    ctx.on('agent/inbox/discarded', () => this.releaseIdleHandles())
    const jobs = ctx.get('jobs')
    if (jobs) ctx.effect(() => jobs.events.subscribe({ owners: 'all' }, (event: { type: string }) => {
      if (event.type === 'removed') this.releaseIdleHandles()
    }), 'aicraft: executor job ownership')
    ctx.effect(() => async () => {
      this.stopping = true
      await Promise.all([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
    }, 'aicraft: executor lifetime')
  }

  /**
   * Ordinary idle chats stay live; archived owners release on lifecycle events, without polling.
   */
  private releaseIdleHandles(): void {
    this.releaseRevision++
    for (const [id, handle] of this.handles) {
      if (this.stopping || !this.archivedSessions.has(handle.agent.session.id) || this.active.has(id) || this.releasing.has(id) || handle.agent.status !== 'idle') continue
      this.releasing.add(id)
      void this.release(id, handle).catch((error) => {
        this.ctx.get('logger')?.warn(`AICraft executor release failed: ${String(error)}`)
      }).finally(() => this.releasing.delete(id))
    }
  }

  /**
   * Release only an archived owner after checking idle state, queued input and owned work.
   */
  private async release(id: string, handle: AgentHandle): Promise<void> {
    const agent = handle.agent
    while (!this.stopping && this.handles.get(id) === handle) {
      await agent.whenIdle()
      if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.active.has(id) || this.handles.get(id) !== handle) return
      const revision = agent.session.seq, generation = this.releaseRevision
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: agent.session.id }, () => Promise.resolve([]))
      if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.handles.get(id) !== handle) return
      if (agent.status !== 'idle' || agent.session.seq !== revision || this.releaseRevision !== generation) continue
      // Disposal clears the inbox and owned jobs: preserve queued input and job output.
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length
        || agent.ctx.get('jobs')?.list(agent.session.id).some((job: { owner?: SessionId }) => job.owner === agent.session.id)
        || activity.length) return
      // No await between the final activity check and starting native teardown.
      try {
        await handle.dispose()
        if (this.handles.get(id) === handle) this.handles.delete(id)
      } finally {
        if (this.handles.get(id) === handle && this.ctx.agents.get(agent.session.id) !== agent) this.handles.delete(id)
      }
      return
    }
  }

  /**
   * Reconsider archived idle handles after an explicit project reconciliation.
   */
  reconcileResources(): void { this.releaseIdleHandles() }


  /**
   * Validate the installed host composition and actual caller before native admission.
   */
  private services(context: CallContext): unknown[] {
    const required = ['agents', 'agentPresets', 'sessionProjections', 'sessionPersistence', 'sessionQuery', 'agentLoop']
    const services = required.map(name => this.ctx.get(name))
    const missing = required.filter((_name, index) => !services[index])
    if (missing.length) throw withUiMessage(new OperationRefusal('dependency-unavailable', `The host is missing required native execution services: ${missing.join(', ')}`), ownMessage({ key: 'reasonTheHostIsMissingRequiredNativeExecutionServicesValue0', params: { value0: missing.join(', ') } }))
    if (typeof this.trackStatistics !== 'function') throw withUiMessage(new OperationRefusal('dependency-unavailable', 'Early executor accounting is unavailable'), ownMessage({ key: 'reasonEarlyExecutorAccountingIsUnavailable' }))
    services.push(this.trackStatistics)
    if (context.source === 'agent') {
      const caller = context.callerRef && this.resolveCaller(context.callerRef)
      if (!caller || this.ctx.agents.get(caller.session.id) !== caller || caller.session.id !== context.callerSessionId) throw withUiMessage(new OperationRefusal('access-denied', 'The actual calling agent is no longer live'), ownMessage({ key: 'reasonTheActualCallingAgentIsNoLongerLive' }))
      const runtime = this.ctx.get('subagents'), provider = runtime?.getProvider('spawn')
      if (!provider || provider.name !== 'spawn') throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The host must provide the exact spawn backend'), ownMessage({ key: 'reasonTheHostMustProvideTheExactSpawnBackend' }))
      if (typeof provider.prepareContinuable !== 'function') throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The spawn backend cannot prepare a continuable executor'), ownMessage({ key: 'reasonTheSpawnBackendCannotPrepareAContinuableExecutor' }))
      if (provider.inheritsParentContext !== false) throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The spawn backend does not guarantee a fresh conversation'), ownMessage({ key: 'reasonTheSpawnBackendDoesNotGuaranteeAFreshConversation' }))
      if (provider.capabilities?.agentOptions !== true) throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The spawn backend cannot select explicit executor model options'), ownMessage({ key: 'reasonTheSpawnBackendCannotSelectExplicitExecutorModelOptions' }))
      services.push(runtime, provider, caller)
    }
    return services.map(nativeIdentity)
  }

  /** Check native launch readiness and install accounting for the reserved executor.
   */
  async admit(context: CallContext, signal: AbortSignal): Promise<ExecutionAdmission> {
    signal.throwIfAborted()
    const identity = {}, services = this.services(context)
    const sessionId = `session-${randomUUID()}`
    const token: NativeAdmission = { context, services, sessionId, accountingFailed: false }
    token.unlisten = this.ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.id !== sessionId || !token.prepared) return undefined
      try {
        // Panel execution preserves the profile default. A delegated child gets standing caller policy.
        if (context.source === 'agent') setSandboxMode(agent.session, context.permissions.mode)
        await this.trackStatistics!(agent)
        const workspace = this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(context.workspaceId))
        if (!workspace) throw withUiMessage(new Error('The original workspace disappeared before dispatch'), ownMessage({ key: 'reasonTheOriginalWorkspaceDisappearedBeforeDispatch' }))
        await workspace.attachSession(agent.session.id)
        this.ctx.sessionTitle.rename(agent.session, token.prepared.sessionTitle)
      } catch (error) { token.accountingFailed = true; throw error }
      return undefined
    })
    if (typeof token.unlisten !== 'function') throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The awaited executor creation listener is unavailable'), ownMessage({ key: 'reasonTheAwaitedExecutorCreationListenerIsUnavailable' }))
    this.admissions.set(identity, token)
    return { identity, sessionId }
  }

  /** Release the reserved admission and its addressed creation listener.
   */
  releaseAdmission(admission: ExecutionAdmission): void {
    const token = this.admissions.get(admission.identity)
    if (!token) return
    token.prepared = undefined
    this.admissions.delete(admission.identity)
    try { token.unlisten?.() }
    catch (error) { this.ctx.get('logger')?.warn(`AICraft creation listener release failed: ${String(error)}`) }
  }

  /** Dispatch the prepared launch through its admitted native execution path.
   */
  async start(context: CallContext, prepared: PreparedRun, signal: AbortSignal): Promise<OperationResult<{ messageId: string }>> {
    const run = prepared.run
    let invoked = false, handle: AgentHandle | undefined
    const token = this.admissions.get(prepared.admission.identity)
    try {
      signal.throwIfAborted()
      const services = this.services(context)
      if (!token || token.context !== context || token.services.some((service, index) => service !== services[index])) throw withUiMessage(new OperationRefusal('dependency-unavailable', 'Native execution services changed after admission'), ownMessage({ key: 'reasonNativeExecutionServicesChangedAfterAdmission' }))
      if (run.sessionId !== token.sessionId) throw withUiMessage(new OperationRefusal('state-conflict', 'The reserved executor identity changed before dispatch'), ownMessage({ key: 'reasonTheReservedExecutorIdentityChangedBeforeDispatch' }))
      token.prepared = prepared
      diagnosticAccepted({ workspaceId: context.workspaceId, taskId: run.taskId, stepId: run.stepId, runId: run.id,
        sessionId: run.sessionId })
      this.work.pending.add(run.sessionId)
      const selected = { provider: run.model.provider, model: run.model.model,
        ...(run.model.reasoningEffort === null ? context.source === 'agent' ? { reasoningEffort: undefined } : {}
          : { reasoningEffort: ReasoningEffortId(run.model.reasoningEffort) }) }
      if (context.source === 'agent') {
        // DSH rc.3 keeps the live title configuration private in TypeScript.
        const titleConfig = Reflect.get(this.ctx.sessionTitle, 'config') as { maxTitleBytes: number }
        invoked = true
        const activation = await this.ctx.get('subagents')!.startActivation({ provider: 'spawn', childId: brandString<SessionId>(run.sessionId),
          label: normalizeSessionTitle(prepared.sessionTitle, titleConfig.maxTitleBytes), delivery: 'parent', signal,
          parent: this.resolveCaller(context.callerRef!)!, cwd: context.projectRoot, prompt: prepared.content,
          agentOptions: selected })
        diagnosticEvent('native.execution-accepted', { messageId: activation.messageId, callId: context.callId,
          callerSessionId: context.callerSessionId }, { path: 'src/dsh-integration/execution/runtime.ts' })
        void activation.result.then(() => this.stopping ? undefined : this.onSettled(context, run)).catch(error => this.ctx.get('logger')?.warn(`AICraft run observation failed: ${String(error)}`))
        return { operationStatus: 'confirmed', value: { messageId: activation.messageId } }
      }
      const preset = await this.ctx.agentPresets.resolve()
      handle = await this.ctx.agents.create({ sessionId: brandString<SessionId>(run.sessionId),
        meta: { cwd: context.projectRoot, agentPreset: preset.id }, agentOptions: selected, signal,
        setup: async (agentCtx, agent) => {
          await this.ctx.agentPresets.mount(agentCtx, preset.id)
          installModelSelection(agentCtx)
          agent.session.append('model/selection', selected)
        } })
      this.handles.set(run.id, handle)
      this.active.add(run.id)
      this.work.initial.add(run.sessionId)
      const message = createUserMessage({ content: prepared.content, source: { kind: 'user' } })
      invoked = true
      handle.agent.followup(message)
      diagnosticEvent('native.execution-accepted', { messageId: message.id, callId: context.callId,
        callerSessionId: null }, { path: 'src/dsh-integration/execution/runtime.ts' })
      const owned = handle
      void owned.agent.whenIdle().then(() => this.stopping ? undefined : this.onSettled(context, run))
        .catch(error => this.ctx.get('logger')?.warn(`AICraft run observation failed: ${String(error)}`))
        .finally(() => { this.active.delete(run.id); this.work.initial.delete(run.sessionId); this.releaseIdleHandles() })
      return { operationStatus: 'confirmed', value: { messageId: message.id } }
    } catch (error) {
      diagnosticEvent('native.execution-failure', { callId: context.callId, callerSessionId: context.callerSessionId,
        sessionId: run.sessionId, acceptanceMayHaveStarted: invoked && !token?.accountingFailed, error: diagnosticFailure(error) }, { path: 'src/dsh-integration/execution/runtime.ts' })
      if (!invoked || token?.accountingFailed || nativeRefusal(error, ['UNAUTHORIZED', 'DUPLICATE_CHILD', 'ACTIVATION_LIMIT_REACHED', 'UNSUPPORTED_CAPABILITY', 'DRAINING', 'ACTIVATION_CLOSING', 'PRESET_UNAVAILABLE', 'PROVIDER_CHANGED'])) {
        if (handle) await handle.dispose()
        this.work.initial.delete(run.sessionId)
        return { operationStatus: 'rejected', problem: { ...operationProblem(context, error), code: error instanceof OperationRefusal ? error.code : 'dependency-unavailable' } }
      }
      if (handle) {
        void handle.agent.whenIdle().then(() => this.stopping ? undefined : this.onSettled(context, run))
          .catch(failure => this.ctx.get('logger')?.warn(`AICraft uncertain run observation failed: ${String(failure)}`))
          .finally(() => { this.active.delete(run.id); this.work.initial.delete(run.sessionId); this.releaseIdleHandles() })
      }
      return { operationStatus: 'unknown', problem: operationProblem(context, error), verification: verification(context, run.taskId!, { attemptId: run.attemptId }) }
    } finally {
      this.work.pending.delete(run.sessionId)
      this.releaseAdmission(prepared.admission)
    }
  }

}
