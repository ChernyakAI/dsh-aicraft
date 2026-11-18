/**
 * FILE: plugin/src/dsh-integration/execution/compose.ts
 * DESCRIPTION: Assemble execution ports and project-backed preparation for the compatible controller
 */
import { ownMessage, withUiMessage } from '../../ui-message.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { randomUUID, createHash } from 'node:crypto'
import type { ProjectConfig } from '../config.ts'
import { createRunStore, readRuns } from '../../step-execution/history.ts'
import { inputPrompt } from '../../step-execution/prompts.ts'
import { startRun } from '../../step-execution/application/start-run.ts'
import { observeRun, OperationRefusal, OperationUncertainty } from '../../step-execution/application/observe-run.ts'
import type { CallContext, CallerRef, MessageRef, OperationResult, RunModel, RunObservation, RunView } from '../../step-execution/types.ts'
import { readTaskSnapshot, readTaskState } from '../../task-management/queries.ts'
import { currentStepOf } from '../../task-management/state.ts'
import { readMaterial, targetFor } from '../../work-materials/materials.ts'
import { diagnosticOperation, diagnosticPublication } from '../diagnostics.ts'
import { NativeExecutionRuntime } from './runtime.ts'
import { NativeWorkObservation } from './activity.ts'
import { NativeConversations } from './conversations.ts'
import { NativeSessionReader } from './session-reader.ts'

/**
 * Connect shared launch and observation operations to their project and native owners.
 */
export class ExecutionApplication {
  private readonly store
  private readonly work
  private readonly reader
  private readonly runtime
  constructor(private readonly ctx: Context, private readonly config: ProjectConfig,
    track: ((agent: Agent) => Promise<void>) | undefined, private readonly resolveModel: (model: RunModel,
      signal: AbortSignal) => Promise<RunModel>,
    caller: (ref: CallerRef) => Agent | undefined) {
    this.store = createRunStore(ctx.fs, config.lockWaitMs)
    this.work = new NativeWorkObservation(ctx, caller)
    this.reader = new NativeConversations(new NativeSessionReader(ctx), this.work)
    this.runtime = new NativeExecutionRuntime(ctx, track, caller, this.work, (context, run) => this.settle(context, run))
  }

  /**
   * Admit task mutations using live work, excluding only the actual caller's current turn.
   */
  readonly isActive = async (run: RunView, context?: CallContext): Promise<boolean> => diagnosticOperation(
    { path: 'src/dsh-integration/execution/compose.ts' }, { runId: run.id, sessionId: run.sessionId }, async () => {
      const cwd = context?.projectRoot ?? this.ctx.agents.get(run.sessionId as never)?.session?.header?.cwd
      const call = context ?? { workspaceId: '', projectRoot: cwd ?? '', source: 'panel', callId: 'activity', callerSessionId: null,
        callerRef: null, permissions: { mode: 'workspace-write', workspaceRoot: cwd ?? '' } } as CallContext
      const observed = await this.work.read(call, run, new AbortController().signal, true)
      if (observed.selected.state === 'active' || observed.others.state === 'active') return true
      if (observed.selected.state === 'unknown' || observed.others.state === 'unknown') throw withUiMessage(new OperationRefusal('dependency-unavailable', 'Task work could not be completely observed'), ownMessage({ key: 'reasonTaskWorkCouldNotBeCompletelyObserved' }))
      return false
    })

  /** Check the caller's own and related work before a shared operation.
   */
  async hasCallerActivity(context: CallContext, signal: AbortSignal): Promise<boolean> {
    return diagnosticOperation({ path: 'src/dsh-integration/execution/compose.ts' },
      { projectPath: context.projectRoot, sessionId: context.callerSessionId }, async () => {
        const work = await this.work.caller(context, signal)
        if (work.selected.state === 'active' || work.others.state === 'active') return true
        if (!work.selected.complete || !work.others.complete) throw withUiMessage(new OperationRefusal('dependency-unavailable', 'The calling conversation work could not be completely observed'), ownMessage({ key: 'reasonTheCallingConversationWorkCouldNotBeCompletelyObserved' }))
        return false
      })
  }

  /**
   * Recheck the actual current task without resolving or changing a model route.
   */
  private async currentState(context: CallContext, taskId: string, stepId: string, signal: AbortSignal) {
    const snapshot = await readTaskSnapshot(this.ctx.fs, context.projectRoot, signal)
    if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw withUiMessage(new OperationRefusal('state-conflict', 'The current task changed or is ambiguous'), ownMessage({ key: 'reasonTheCurrentTaskChangedOrIsAmbiguous' }))
    const state = await readTaskState(this.ctx.fs, context.projectRoot, taskId, signal)
    if (state.status !== 'open' || currentStepOf(state) !== stepId || state.stepStates.find(step => step.id === stepId)?.status !== 'current') throw withUiMessage(new OperationRefusal('state-conflict', 'Only the current running stage can start an executor'), ownMessage({ key: 'reasonOnlyTheCurrentRunningStageCanStartAnExecutor' }))
    return state
  }

  /** Assemble project-backed launch preparation and ports for the shared start operation.
   */
  async start(context: CallContext, taskId: string, stepId: string, attemptId: string, modelOverride: RunModel | null,
    signal: AbortSignal): Promise<OperationResult<RunObservation>> {
    let originalAssignment: RunModel | undefined
    const currentAssignment = async () => {
      const state = await this.currentState(context, taskId, stepId, signal)
      if (modelOverride === null && originalAssignment) {
        const assigned = state.process.steps.find(step => step.id === stepId)!.model
        if (assigned.provider !== originalAssignment.provider || assigned.model !== originalAssignment.model
          || assigned.reasoningEffort !== originalAssignment.reasoningEffort) throw withUiMessage(new OperationRefusal('version-conflict', 'The stage model assignment changed during launch preparation'), ownMessage({ key: 'reasonTheStageModelAssignmentChangedDuringLaunchPreparation' }))
      }
      return state
    }
    return startRun({ store: this.store, runtime: this.runtime, reader: this.reader,
      validate: async (_context, _taskId, request, signal) => {
        const state = await currentAssignment()
        const step = state.process.steps.find(step => step.id === request.stepId)
        if (state.status !== 'open' || !step || currentStepOf(state) !== request.stepId || state.stepStates.find(step => step.id === request.stepId)?.status !== 'current') throw withUiMessage(new OperationRefusal('state-conflict', 'Only the current running stage can start an executor'), ownMessage({ key: 'reasonOnlyTheCurrentRunningStageCanStartAnExecutor' }))
        if (await this.hasCallerActivity(context, signal)) throw withUiMessage(new OperationRefusal('state-conflict', 'An executor is already active for this task'), ownMessage({ key: 'reasonAnExecutorIsAlreadyActiveForThisTask' }))
        for (const run of await readRuns(this.ctx.fs, context.projectRoot, taskId, signal)) if (await this.isActive(run, context)) throw withUiMessage(new OperationRefusal('state-conflict', 'An executor is already active for this task'), ownMessage({ key: 'reasonAnExecutorIsAlreadyActiveForThisTask' }))
        originalAssignment = structuredClone(request.modelOverride ?? step.model)
        return this.resolveModel(originalAssignment, signal)
      },
      validateDispatch: async (_context, _taskId, ownRun, signal) => {
        await currentAssignment()
        if (await this.hasCallerActivity(context, signal)) throw withUiMessage(new OperationRefusal('state-conflict', 'An executor is already active for this task'), ownMessage({ key: 'reasonAnExecutorIsAlreadyActiveForThisTask' }))
        for (const run of await readRuns(this.ctx.fs, context.projectRoot, taskId, signal)) if (run.id !== ownRun.id && await this.isActive(run, context)) throw withUiMessage(new OperationRefusal('state-conflict', 'An executor is already active for this task'), ownMessage({ key: 'reasonAnExecutorIsAlreadyActiveForThisTask' }))
      },
      prepare: async (_context, _taskId, attemptId, request, model, admission, signal) => {
        let promptWritePending = false
        try {
          await inputPrompt(this.ctx.fs, context.projectRoot, taskId, stepId, signal, undefined, undefined, {
            submitting() { promptWritePending = true }, confirmed() { promptWritePending = false },
          })
        } catch (error) {
          if (error instanceof OperationRefusal) throw error
          if (error !== null && typeof error === 'object' && 'code' in error && ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'].includes(String(error.code))) throw new OperationRefusal('version-conflict', error instanceof Error ? error.message : String(error), { cause: error })
          if (promptWritePending) throw new OperationUncertainty(error instanceof Error ? error.message : String(error),
            { workspaceId: context.workspaceId, taskId, attemptId, operation: 'material', path: `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md` }, { cause: error })
          throw error
        }
        const outputPath = `.aicraft/tasks/${taskId}/${stepId}`
        const prompt = await readMaterial(this.ctx.fs, context.projectRoot, `${outputPath}/input-prompt.md`, signal)
        if (!prompt.text.trim()) throw withUiMessage(new OperationRefusal('invalid-input', `The saved prompt is empty. Edit and save ${outputPath}/input-prompt.md before starting an executor.`), ownMessage({ key: 'reasonTheSavedPromptIsEmptyEditAndSaveValue0InputPromptMdBeforeStart', params: { value0: outputPath } }))
        const state = await currentAssignment()
        const content = [{ type: 'text' as const, text: prompt.text }]
        const processTarget = await targetFor(this.ctx.fs, context.projectRoot, `.aicraft/tasks/${taskId}/process.json`, signal)
        if (!await this.ctx.fs.stat(processTarget, signal)) {
          const processText = JSON.stringify(state.process, null, 2) + '\n'
          const processBytes = new TextEncoder().encode(processText)
          try { await diagnosticPublication(async () => {
            try { await this.ctx.fs.writeText(processTarget, processText, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: context.projectRoot }) }
            catch (error) {
              if (error !== null && typeof error === 'object' && 'code' in error && ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'].includes(String(error.code))) throw error
              if (error !== null && typeof error === 'object' && 'code' in error && ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code))) {
                throw new OperationRefusal('access-denied', error instanceof Error ? error.message : String(error), { cause: error })
              }
              try {
                const bytes = await this.ctx.fs.readBytes(processTarget, signal, processBytes.length + 1)
                if (bytes.length === processBytes.length && bytes.every((byte, index) => byte === processBytes[index])) return
              }
              catch { /* The original preparation remains uncertain. */ }
              throw error
            }
          }, processTarget, 'writeText') }
          catch (error) {
            if (error instanceof OperationRefusal) throw error
            if (error !== null && typeof error === 'object' && 'code' in error && ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'].includes(String(error.code))) throw new OperationRefusal('version-conflict', error instanceof Error ? error.message : String(error), { cause: error })
            throw new OperationUncertainty(error instanceof Error ? error.message : String(error),
              { workspaceId: context.workspaceId, taskId, attemptId, operation: 'material', path: `.aicraft/tasks/${taskId}/process.json` }, { cause: error })
          }
        }
        const run: RunView = { id: `run-${randomUUID()}`, taskId, stepId, attemptId, callerSessionId: context.callerSessionId,
          sessionId: admission.sessionId, request, model, status: 'starting', startedAt: new Date().toISOString(), finishedAt: null,
          outputPath, error: null, dispatch: { phase: 'registered', messageId: null, reason: null }, initialTurn: { turn: null, messageId: null },
          promptVersion: prompt.version, promptSha256: createHash('sha256').update(prompt.text).digest('hex'),
          executionBackend: { kind: context.source === 'agent' ? 'spawn-in-process' : 'standalone', providerName: context.source === 'agent' ? 'spawn' : null } }
        const stepIndex = state.process.steps.findIndex(step => step.id === stepId)
        const step = state.process.steps[stepIndex]
        return { run, content, admission, sessionTitle: `${stepIndex + 1}. ${step.title}` }
      },
    }, context, taskId, attemptId, { stepId, modelOverride }, signal)
  }

  /** Connect the run store and native reader to the shared observation operation.
   */
  observe(context: CallContext, taskId: string, selector: { runId?: string; attemptId?: string }, signal: AbortSignal,
    expectedWorkspaceId?: string, messageRef?: MessageRef): Promise<OperationResult<RunObservation>> {
    return diagnosticOperation({ path: 'src/dsh-integration/execution/compose.ts' },
      { projectPath: context.projectRoot, taskId }, () => observeRun(this.store, this.reader, context, taskId, selector,
        signal, expectedWorkspaceId, messageRef))
  }
  /**
   * Persist established initial-turn outcomes; unreadable sources do not invent interruption.
   */
  private async settle(context: CallContext, run: RunView, recovery = false, taskId = run.taskId!): Promise<void> {
    const signal = new AbortController().signal
    await this.store.transaction(context, taskId, signal, async (writer) => {
      const saved = (await writer.read()).find(item => item.id === run.id)
      if (!saved || !['starting', 'running'].includes(saved.status)) return
      const observed = await this.reader.observe(context, saved, signal)
      if (observed.initialOutcome.state === 'unknown') {
        if (!recovery || observed.availability.executor.state !== 'available' || observed.activity.selected.state !== 'inactive'
          || observed.initialOutcome.evidence?.kind !== 'no-turn-end') return
        await writer.save({ ...saved, status: 'interrupted', finishedAt: new Date().toISOString(), error: 'The saved run has no completed DSH turn', errorMessage: { key: 'reasonTheSavedRunHasNoCompletedDSHTurn' } })
      } else await writer.save({ ...saved, status: observed.initialOutcome.state,
        finishedAt: new Date().toISOString(), error: observed.initialOutcome.reason ?? null,
        errorMessage: observed.initialOutcome.reasonMessage })
    })
  }

  /** Reconcile saved launches and persist established recovery outcomes through settle.
   */
  async reconcile(cwd: string): Promise<void> {
    this.runtime.reconcileResources()
    const signal = new AbortController().signal, snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
    if (snapshot.kind !== 'task') return
    const context: CallContext = { workspaceId: '', projectRoot: cwd, source: 'panel', callId: 'reconcile', callerSessionId: null,
      callerRef: null, permissions: { mode: 'workspace-write', workspaceRoot: cwd } }
    for (const task of snapshot.tasks) for (const run of await readRuns(this.ctx.fs, cwd, task.id, signal)) {
      if (['starting', 'running'].includes(run.status)) await this.settle(context, run, true, task.id)
    }
  }
}
