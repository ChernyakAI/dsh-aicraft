/**
 * FILE: plugin/src/dsh-integration/service.ts
 * DESCRIPTION: Route shared panel and agent operations to domain owners
 */
import { ownMessage, withUiMessage, messageOf } from '../ui-message.ts'
import { diagnosticContext, diagnosticEvent, diagnosticOperation } from './diagnostics.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallContext, CallerRef, MessageRef, OperationResult, RunObservation } from '../step-execution/types.ts'
import type { StepData, TaskChangeConfirmation } from '../task-management/types.ts'
import { mutationResult, readResult } from './operation-result.ts'
import { OperationRefusal, operationProblem } from '../step-execution/application/observe-run.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import type { } from '@deepseek-ai/dsh-api-session-controller/types'
import type { } from '@deepseek-ai/dsh-fs'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { } from '@deepseek-ai/dsh-session-query'
import type { } from '@deepseek-ai/dsh-session-title'
import type { } from '@deepseek-ai/dsh-subprocess'
import { Remote,RemoteError,TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { } from '@deepseek-ai/dsh-workspace'
import { StatisticsController } from '../execution-accounting/statistics.ts'
import { saveProcess } from '../project-settings/processes.ts'
import { hasAicraftProject,prepareProject } from '../project-settings/project.ts'
import { deleteRole,saveRole } from '../project-settings/roles.ts'
import { openProjectRules } from '../project-settings/rules.ts'
import { aicraftIntroduction } from '../project-settings/introduction.ts'
import { agentResultNotes, readAgentHelp } from './agent-help.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { readSettings } from '../project-settings/settings.ts'
import { setStepModel } from '../step-execution/models.ts'
import { defaultStepPrompt,openStepPrompt } from '../step-execution/prompts.ts'
import { RunController } from '../step-execution/runs.ts'
import { TaskCreationRefusal } from '../task-management/creation-result.ts'
import { createTask,updateTask } from '../task-management/commands.ts'
import type { CreateTaskRequest,TaskCreationConfirmation,ExecutionStatistics,InitializeProjectRequest,MaterialDocument,MaterialGroup,ProcessDefinition,ProcessDocument,ProcessTemplateLanguage,ProjectChange,ProjectPresence,ProjectSettings,ProjectView,RoleDocument,RunModel,TaskSnapshot } from '../types.ts'
import { deleteStepMaterials } from '../work-materials/cleanup.ts'
import { listMaterials,readMaterial,saveMaterial } from '../work-materials/materials.ts'
import type { Config } from './config.ts'
import { resolveProject,workspaceForAgent } from './project-context.ts'
import { readProject,readTaskView } from './project-view.ts'
import { readTaskSnapshot } from '../task-management/queries.ts'
import type { AgentHelp, DiagnosticContext } from './types.ts'
import { ProjectWatch } from './project-watch.ts'
import { presentationErrors } from './presentation-errors.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AICraft operations shared by the panel and future agent tools. */
    aicraft: AicraftService
  }
}
/**
 * Server operations shared by the AICraft panel and actual agent callers.
 */
export class AicraftService extends TypertRemoteService {
  /** Project identity and filesystem operations are provided by DSH. */
  static inject: string[] = ['workspaceRegistry', 'fs', 'subprocess', 'agents', 'agentPresets', 'sessionQuery', 'sessionTitle', 'llm', 'sessionProjections']
  private readonly runs: RunController
  private readonly statisticsController: StatisticsController
  private readonly projectWatch: ProjectWatch
  private readonly callers = new WeakMap<CallerRef, Agent>()
  /**
   * @param ctx - Owning Cordis plugin context.
   * @param config - Validated operation limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'aicraft')
    this.statisticsController = new StatisticsController(ctx,config.lockWaitMs)
    this.runs = new RunController(ctx, config, agent => this.statisticsController.track(agent), (model, signal) =>
      resolveModel(ctx, model, signal), ref => this.callers.get(ref))
    this.projectWatch = new ProjectWatch(ctx, config)
  }

  /** Publish operations only after the owned accounting registration is ready.
   */
  protected async [Service.init](): Promise<void> { await this.statisticsController.ready }

  /**
   * START_METHOD_AicraftService.changes
   * One event-driven project subscription, independent of the selected chat.
   */
  @Remote({ mode: 'stream' })
  @presentationErrors
  changes(workspaceId: string, taskId: string | null, signal: AbortSignal): AsyncIterable<ProjectChange> {
    return this.projectWatch.follow(this.projectPath(workspaceId), taskId, signal)
  }
  // END_METHOD_AicraftService.changes

  /**
   * START_METHOD_AicraftService.status
   * Confirm that the AICraft server service is reachable.
   * @returns The stable connection status.
   */
  @Remote
  @presentationErrors
  status(): string {
    return 'connected'
  }
  // END_METHOD_AicraftService.status

  /**
   * START_METHOD_AicraftService.projects
   * Inspect project directories for icons in the workspace picker.
   * @param signal - Caller cancellation.
   * @returns Presence information for every registered workspace.
   */
  @Remote
  @presentationErrors
  projects(signal: AbortSignal): Promise<ProjectPresence[]> {
    return Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      workspaceId: workspace.id,
      hasAicraft: await hasAicraftProject(this.ctx.fs, this.projectPath(workspace.id), signal),
    })))
  }
  // END_METHOD_AicraftService.projects

  /**
   * START_METHOD_AicraftService.task
   * Read task state for an explicitly selected DSH project.
   * @param workspaceId - Registered DSH Workspace identity, never an arbitrary path.
   * @param signal - Caller cancellation injected by Remote API.
   * @returns The project's current task snapshot.
   */
  @Remote
  @presentationErrors
  async task(workspaceId: string, signal: AbortSignal): Promise<TaskSnapshot> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.task' }, { workspaceId: workspaceId }, async () => {
      return readTaskView(this.ctx.fs, this.projectPath(workspaceId), signal)

    })
  }
  // END_METHOD_AicraftService.task

  /**
   * START_METHOD_AicraftService.statistics
   * Fetch derived task or executor-tree statistics separately from project/UI loading.
   */
  @Remote
  @presentationErrors
  statistics(
    workspaceId: string,
    taskId: string,
    sessionId: string | null,
    signal: AbortSignal,
  ): Promise<ExecutionStatistics> {
    return this.statisticsController.read(this.projectPath(workspaceId), taskId, sessionId, signal)
  }
  // END_METHOD_AicraftService.statistics

  private projectPath(workspaceId: string): string { return resolveProject(this.ctx, workspaceId) }

  /**
   * Keep actual caller identity and the common outcome in the existing diagnostic channel.
   */
  private forCall<T>(context: CallContext, execute: () => Promise<T>, subject: Partial<DiagnosticContext> = {}): Promise<T> {
    return diagnosticContext({ workspaceId: context.workspaceId, projectPath: context.projectRoot,
      callId: context.callId, callerSessionId: context.callerSessionId, taskId: undefined, stepId: undefined,
      runId: undefined, sessionId: undefined, ...subject }, () => diagnosticOperation(
      { path: 'src/dsh-integration/service.ts' }, {}, async () => {
        const result = await execute()
        if (typeof result === 'object' && result !== null && 'operationStatus' in result) {
          const value = result as { operationStatus: unknown; problem?: unknown; refreshIssue?: unknown }
          diagnosticEvent('operation.result', { outcome: value.operationStatus, ...(value.problem ? { problem: value.problem } : {}),
            ...(value.refreshIssue ? { refreshIssue: value.refreshIssue } : {}) })
        }
        return result
      }))
  }

  /** Expose the shared material catalog through the common read result.
   */
  materialsForCall(context: CallContext, taskId: string | null, signal: AbortSignal): Promise<OperationResult<MaterialGroup[]>> {
    return this.forCall(context, async () => {
      return readResult(context, () => this.materials(context.workspaceId, taskId, signal)
        .catch((error) => { throw error instanceof RemoteError && error.cause ? error.cause : error }))

    }, { taskId: taskId ?? undefined })
  }

  /** Expose document reading through the common read result.
   */
  materialForCall(context: CallContext, path: string, signal: AbortSignal): Promise<OperationResult<MaterialDocument>> {
    return this.forCall(context, async () => {
      return readResult(context, () => this.material(context.workspaceId, path, signal)
        .catch((error) => { throw error instanceof RemoteError && error.cause ? error.cause : error }))

    }, {})
  }

  /** Build trusted references from the actual tool execution, never model parameters.
   */
  contextForAgent(workspaceId: string, agent: Agent, callId: string, standing: SandboxExecutionPolicy): CallContext {
    const projectRoot = this.projectPath(workspaceId)
    if (!agent.session.header.cwd || resolve(agent.session.header.cwd) !== resolve(projectRoot)
      || resolve(standing.workspaceRoot) !== resolve(projectRoot)) throw withUiMessage(new OperationRefusal('access-denied', 'The actual caller and standing policy must belong to the registered project'), ownMessage({ key: 'reasonTheActualCallerAndStandingPolicyMustBelongToTheRegisteredProje' }))
    const callerRef = {} as CallerRef
    this.callers.set(callerRef, agent)
    return { workspaceId, projectRoot, source: 'agent', callId, callerSessionId: agent.session.id, callerRef,
      permissions: { mode: standing.mode, workspaceRoot: standing.workspaceRoot } }
  }

  /**
   * Build trusted panel context for the registered project without inventing a caller session.
   */
  private panelContext(workspaceId: string): CallContext {
    const projectRoot = this.projectPath(workspaceId)
    return { workspaceId, projectRoot, source: 'panel', callId: randomUUID(), callerSessionId: null, callerRef: null,
      permissions: { mode: 'workspace-write', workspaceRoot: projectRoot } }
  }

  /**
   * Select only a fully read, unambiguous open task without history or material projections.
   */
  private async openTaskForAgent(context: CallContext, signal: AbortSignal, allowEmpty = false) {
    const snapshot = await readTaskSnapshot(this.ctx.fs, context.projectRoot, signal, false)
    if (snapshot.issues.length) {
      const issue = ['access-denied', 'dependency-unavailable', 'state-conflict']
        .flatMap(code => snapshot.issues.filter(issue => issue.code === code))[0]!
      throw new OperationRefusal(issue.code, snapshot.issues.map(issue => issue.message).join('; '),
        { cause: new AggregateError(snapshot.issues.map(issue => issue.cause), issue.message) })
    }
    if (snapshot.kind === 'ambiguous' || snapshot.kind === 'invalid') throw withUiMessage(new OperationRefusal('state-conflict', 'The open task is ambiguous or invalid'), ownMessage({ key: 'reasonTheOpenTaskIsAmbiguousOrInvalid' }))
    const task = snapshot.tasks[0]
    if (!task && !allowEmpty) throw withUiMessage(new OperationRefusal('not-found', 'No task is open in the calling project'), ownMessage({ key: 'reasonNoTaskIsOpenInTheCallingProject' }))
    return task
  }

  /**
   * Read the actual current stage; the panel's last-done selection is irrelevant.
   */
  stepForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<string | null>> {
    return this.forCall(context, () => readResult(context, async () =>
      (await this.openTaskForAgent(context, signal))!.steps.find(step => step.status === 'current')?.id ?? null))
  }

  /**
   * Read the unchanged framework description from its settings owner.
   */
  private readHelpDescription(): string { return aicraftIntroduction }

  /**
   * Read the mandatory explanation independently of task or execution state.
   */
  private readHelpResultNotes(): string { return agentResultNotes }

  /**
   * Return fresh help for the trusted actual caller without reading or admitting task work.
   */
  helpForAgent(context: CallContext, catalog: (agent: Agent) => ToolSchema[], signal: AbortSignal): Promise<OperationResult<AgentHelp>> {
    return this.forCall(context, () => readResult(context, async () => {
      signal.throwIfAborted()
      const agent = context.callerRef && this.callers.get(context.callerRef)
      if (!agent || agent.session.id !== context.callerSessionId) throw withUiMessage(new OperationRefusal('access-denied', 'AICraft help requires the actual calling agent'), ownMessage({ key: 'reasonAICraftHelpRequiresTheActualCallingAgent' }))
      const result = readAgentHelp(() => this.readHelpDescription(), () => catalog(agent), () => this.readHelpResultNotes())
      signal.throwIfAborted()
      return result
    }))
  }

  /** The same task-state owner serves panel and actual agent callers.
   */
  changeTask(context: CallContext, taskId: string, operation: TaskChangeConfirmation['operation'], stepId: string | null,
    signal: AbortSignal, fromStepId?: string,
    expected?: { expectedStep: string | null }): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.forCall(context, async () => {
      return mutationResult(context, { workspaceId: context.workspaceId, taskId, operation: 'task' }, progress =>
        updateTask(this.ctx.fs, this.ctx.subprocess, context.projectRoot, taskId, operation, stepId, this.config, signal,
          fromStepId, run => this.runs.isActive(run, context), readProject, progress,
          () => this.runs.hasCallerActivity(context, signal), expected))

    }, { taskId, stepId: stepId ?? undefined })
  }

  /**
   * START_METHOD_AicraftService.project
   * Read project readiness, process choices, current branch and task state.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Project state suitable for creation controls.
   */
  @Remote
  @presentationErrors
  async project(workspaceId: string, signal: AbortSignal): Promise<ProjectView> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.project' }, { workspaceId: workspaceId }, async () => {
      const cwd = this.projectPath(workspaceId)
      await this.runs.reconcile(cwd)
      return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)

    })
  }
  // END_METHOD_AicraftService.project

  /**
   * Read the open task ID and all saved stages with their actual states.
   */
  projectForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<{
    openTaskId: string | null
    steps: { id: string; description: string; status: StepData['status'] }[]
  }>> {
    return this.forCall(context, () => readResult(context, async () => {
      const task = await this.openTaskForAgent(context, signal, true)
      return { openTaskId: task?.id ?? null, steps: task?.steps.map(step => ({
        id: step.id, description: step.description ?? `Execute the assignment for stage '${step.id}' using role '${step.role}'.`,
        status: step.status,
      })) ?? [] }
    }))
  }

  /**
   * Apply a guarded agent transition through the common task owner and original selected task.
   */
  async moveStepForAgent(context: CallContext, action: 'complete' | 'skip' | 'goto' | 'return',
    expectedStep: string | null, targetStep: string | undefined, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.forCall<OperationResult<TaskChangeConfirmation>>(context, async () => {
      const selected = await readResult(context, async () => {
        if (!['complete', 'skip', 'goto', 'return'].includes(action)
          || (action !== 'goto' && expectedStep === null)
          || (['goto', 'return'].includes(action) ? !targetStep : targetStep !== undefined)) throw withUiMessage(new OperationRefusal('invalid-input', 'expectedStep and targetStep do not match the selected action'), ownMessage({ key: 'reasonExpectedStepAndTargetStepDoNotMatchTheSelectedAction' }))
        return (await this.openTaskForAgent(context, signal))!
      })
      if (selected.operationStatus !== 'confirmed') return selected
      return this.changeTask(context, selected.value.id, action, action === 'complete' || action === 'skip' ? expectedStep : targetStep!,
        signal, action === 'return' ? expectedStep! : undefined, { expectedStep })
    })
  }

  /**
   * Resolve the open task once before the shared owner rechecks its identity under lock.
   */
  async closeTaskForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.forCall<OperationResult<TaskChangeConfirmation>>(context, async () => {
      const selected = await readResult(context, async () => (await this.openTaskForAgent(context, signal))!)
      if (selected.operationStatus !== 'confirmed') return selected
      return this.changeTask(context, selected.value.id, 'close', null, signal)
    })
  }


  /**
   * START_METHOD_AicraftService.materials
   * List documents in the selected project, independently of the chat session.
   */
  @Remote
  @presentationErrors
  materials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]> {
    return listMaterials(this.ctx.fs, this.projectPath(workspaceId), taskId, signal)
  }
  // END_METHOD_AicraftService.materials

  /**
   * START_METHOD_AicraftService.material
   * Read one project material without modifying it.
   */
  @Remote
  @presentationErrors
  async material(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.material' }, { workspaceId: workspaceId }, async () => {
      const cwd = this.projectPath(workspaceId)
      const document = await readMaterial(this.ctx.fs, cwd, path, signal)
      const snapshot = await readTaskView(this.ctx.fs, cwd, signal)
      return { ...document, readOnly: snapshot.kind === 'ambiguous' }

    })
  }
  // END_METHOD_AicraftService.material

  /**
   * START_METHOD_AicraftService.projectRules
   * Open shared project rules, adopting the current filename on explicit request.
   */
  @Remote
  @presentationErrors
  projectRules(workspaceId: string, signal: AbortSignal): Promise<MaterialDocument> {
    return openProjectRules(this.ctx.fs, this.projectPath(workspaceId), this.config.lockWaitMs, signal)
  }
  // END_METHOD_AicraftService.projectRules

  /**
   * START_METHOD_AicraftService.saveMaterial
   * Save existing Markdown with an optimistic file version guard.
   */
  @Remote
  @presentationErrors
  saveMaterial(
    workspaceId: string,
    path: string,
    text: string,
    version: string,
    signal: AbortSignal,
  ): Promise<OperationResult<MaterialDocument>> {
    const context = this.panelContext(workspaceId)
    return this.saveMaterialForCall(context, path, text, version, signal)
  }
  // END_METHOD_AicraftService.saveMaterial

  /** Connect versioned material saving to the common mutation result.
   */
  saveMaterialForCall(context: CallContext, path: string, text: string, version: string,
    signal: AbortSignal): Promise<OperationResult<MaterialDocument>> {
    return this.forCall(context, async () => {
      return mutationResult(context, { workspaceId: context.workspaceId, taskId: '', operation: 'material', path }, progress =>
        saveMaterial(this.ctx.fs, context.projectRoot, path, text, version, this.config.lockWaitMs, signal, progress))

    }, {})
  }

  /**
   * START_METHOD_AicraftService.setStepModel
   * Save the model used by subsequent runs of this task step.
   */
  @Remote
  @presentationErrors
  async setStepModel(
    workspaceId: string,
    taskId: string,
    stepId: string,
    model: RunModel,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.setStepModel' }, { workspaceId: workspaceId, taskId: taskId, stepId: stepId }, async () => {
      const cwd = this.projectPath(workspaceId)
      await setStepModel(this.ctx.fs, this.config.lockWaitMs, this.runs.isActive, cwd, taskId, stepId, model, signal, (model,
        signal) => resolveModel(this.ctx, model, signal))
      return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)

    })
  }
  // END_METHOD_AicraftService.setStepModel

  /**
   * START_METHOD_AicraftService.deleteStepMaterials
   * Delete step outputs only after the panel's explicit confirmation.
   */
  @Remote
  @presentationErrors
  async deleteStepMaterials(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.deleteStepMaterials' }, { workspaceId: workspaceId, taskId: taskId, stepId: stepId }, async () => {
      const cwd = this.projectPath(workspaceId)
      await deleteStepMaterials(this.ctx.fs, this.config.lockWaitMs, this.runs.isActive, cwd, taskId, stepId, signal)
      return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)

    })
  }
  // END_METHOD_AicraftService.deleteStepMaterials

  /**
   * START_METHOD_AicraftService.settings
   * Read editable project process templates and available roles.
   */
  @Remote
  @presentationErrors
  settings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings> {
    return readSettings(this.ctx.fs, this.projectPath(workspaceId), signal)
  }
  // END_METHOD_AicraftService.settings

  /**
   * START_METHOD_AicraftService.saveProcess
   * Persist a project process template without changing existing tasks.
   */
  @Remote
  @presentationErrors
  saveProcess(
    workspaceId: string,
    id: string,
    definition: ProcessDefinition,
    version: string | null,
    templateLanguage: ProcessTemplateLanguage | null,
    signal: AbortSignal,
  ): Promise<ProcessDocument> {
    return saveProcess(this.ctx.fs, this.projectPath(workspaceId), id, definition, version, this.config.lockWaitMs, signal,
      templateLanguage)
  }
  // END_METHOD_AicraftService.saveProcess

  /**
   * START_METHOD_AicraftService.saveRole
   * Save project role instructions without replacing stale edits.
   */
  @Remote
  @presentationErrors
  saveRole(
    workspaceId: string,
    id: string,
    text: string,
    version: string | null,
    signal: AbortSignal,
  ): Promise<RoleDocument> {
    return saveRole(this.ctx.fs, this.projectPath(workspaceId), id, text, version, this.config.lockWaitMs, signal)
  }
  // END_METHOD_AicraftService.saveRole

  /**
   * START_METHOD_AicraftService.deleteRole
   * Remove the selected role instruction after version and access checks.
   */
  @Remote
  @presentationErrors
  deleteRole(
    workspaceId: string,
    id: string,
    version: string,
    signal: AbortSignal,
  ): Promise<void> {
    return deleteRole(this.ctx.fs, this.projectPath(workspaceId), id, version, this.config.lockWaitMs, signal)
  }
  // END_METHOD_AicraftService.deleteRole

  /**
   * START_METHOD_AicraftService.stepPrompt
   * Read or create the editable step prompt, preserving the owner's publication outcome at the Remote boundary.
   */
  @Remote
  @presentationErrors
  async stepPrompt(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const context = this.panelContext(workspaceId)
    const path = `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`
    const result = await mutationResult<string>(context, { workspaceId, taskId, operation: 'material', path }, async (progress) => {
      const text = await openStepPrompt(this.ctx.fs, this.config.lockWaitMs, context.projectRoot, taskId, stepId, signal,
        undefined, { submitting: () => progress.submitting(), confirmed: document => progress.confirmed(document.text),
          lastConfirmed: state => progress.lastConfirmed?.(state) })
      progress.confirmed(text)
    })
    if (result.operationStatus === 'confirmed') return result.value
    const message = result.operationStatus === 'unknown'
      ? `${result.problem.message} Outcome unknown. Check the original assignment at ${path}; do not repeat the change.`
      : result.problem.message
    throw new RemoteError('aicraft/prompt-not-confirmed', message, result)
  }
  // END_METHOD_AicraftService.stepPrompt

  /**
   * START_METHOD_AicraftService.defaultStepPrompt
   * Generate default editor text without saving; preserve the loaded file version.
   */
  @Remote
  @presentationErrors
  defaultStepPrompt(
    workspaceId: string,
    taskId: string,
    stepId: string,
    version: string,
    signal: AbortSignal,
  ): Promise<MaterialDocument> {
    return defaultStepPrompt(this.ctx.fs, this.config.lockWaitMs, this.projectPath(workspaceId), taskId, stepId, version, signal)
  }
  // END_METHOD_AicraftService.defaultStepPrompt

  /**
   * START_METHOD_AicraftService.startStep
   * Launch the current stage in a new independent session.
   * @param workspaceId - Registered project identity.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param model - Optional per-run model override.
   * @param signal - Creation cancellation.
   * @returns Durable executor link, without accepting the stage.
   */
  @Remote
  @presentationErrors
  startStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    model: RunModel | null,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<RunObservation>> {
    return this.runs.start(this.panelContext(workspaceId), taskId, stepId, attemptId, model, signal)
  }
  // END_METHOD_AicraftService.startStep

  /**
   * START_METHOD_AicraftService.startStepForAgent
   * Authorized agent entry; the executor inherits standing permissions, not a one-call grant.
   */
  async startStepForAgent(context: CallContext, expectedStep: string, attemptId: string,
    signal: AbortSignal): Promise<OperationResult<RunObservation>> {
    return this.forCall<OperationResult<RunObservation>>(context, async () => {
      const selected = await readResult(context, async () => (await this.openTaskForAgent(context, signal))!)
      if (selected.operationStatus !== 'confirmed') return selected
      return this.forCall(context, () => this.runs.start(context, selected.value.id, expectedStep, attemptId, null, signal),
        { taskId: selected.value.id, stepId: expectedStep })
    })
  }
  // END_METHOD_AicraftService.startStepForAgent

  /** Read one attempt without reconciliation or execution.
   */
  @Remote
  @presentationErrors
  run(workspaceId: string, taskId: string, runId: string | null, attemptId: string | null,
    expectedWorkspaceId: string | null, messageRef: MessageRef | null, signal: AbortSignal): Promise<OperationResult<RunObservation>> {
    return this.observeRunForCall(this.panelContext(workspaceId), taskId, runId, attemptId, expectedWorkspaceId, messageRef, signal)
  }

  /** Route either transport to the shared saved-attempt observation.
   */
  observeRunForCall(context: CallContext, taskId: string, runId: string | null, attemptId: string | null,
    expectedWorkspaceId: string | null, messageRef: MessageRef | null, signal: AbortSignal): Promise<OperationResult<RunObservation>> {
    return this.forCall(context, async () => {
      return this.runs.observe(context, taskId, { ...(runId === null ? {} : { runId }),
        ...(attemptId === null ? {} : { attemptId }) }, signal, expectedWorkspaceId ?? undefined, messageRef ?? undefined)

    }, { taskId, runId: runId ?? undefined })
  }

  /**
   * Read one original attempt of the selected open task without choosing a later run.
   */
  async checkRunForAgent(context: CallContext, runId: string | undefined, attemptId: string | undefined,
    signal: AbortSignal): Promise<OperationResult<RunObservation>> {
    return this.forCall<OperationResult<RunObservation>>(context, async () => {
      const selected = await readResult(context, async () => {
        if ((runId === undefined) === (attemptId === undefined)) throw withUiMessage(new OperationRefusal('invalid-input', 'Specify exactly one runId or attemptId'), ownMessage({ key: 'reasonSpecifyExactlyOneRunIdOrAttemptId' }))
        return (await this.openTaskForAgent(context, signal))!
      })
      if (selected.operationStatus !== 'confirmed') return selected
      const result = await this.observeRunForCall(context, selected.value.id, runId ?? null, attemptId ?? null, null, null, signal)
      if (result.operationStatus !== 'confirmed') return result
      const observed = result.value
      if (observed.availability.executor.state === 'unavailable' || !observed.activity.selected.complete) {
        const reason = observed.availability.executor.reason ?? (observed.activity.selected.reasons.join('; ') || 'The executor source could not be completely observed')
        return { operationStatus: 'unknown', problem: operationProblem(context, new Error(reason)),
          verification: { workspaceId: context.workspaceId, taskId: selected.value.id, operation: 'run', ...(runId === undefined ? { attemptId } : { runId }) },
          lastConfirmedState: { runId: observed.link.id, stepId: observed.link.stepId,
            ...(observed.link.dispatch === undefined || observed.link.dispatch.phase === 'accepted' || observed.availability.executor.state === 'available'
              ? { sessionId: observed.link.sessionId } : {}),
            initialAssignmentStatus: observed.initialOutcome.state, conversationActivity: observed.activity.selected.state } }
      }
      return result
    })
  }

  /**
   * START_METHOD_AicraftService.prepare
   * Prepare missing project files without overwriting existing materials.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  @presentationErrors
  prepare(workspaceId: string, request: InitializeProjectRequest, signal: AbortSignal): Promise<ProjectView> {
    return prepareProject(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), this.config, signal, request, readProject)
  }
  // END_METHOD_AicraftService.prepare

  /**
   * START_METHOD_AicraftService.createTask
   * Create one open task in the selected project.
   * @param workspaceId - Registered DSH project identity.
   * @param request - Task title, selected process and requirements.
   * @param signal - Caller cancellation.
   * @returns Publication confirmation; full project state is read separately.
   */
  @Remote
  @presentationErrors
  async createTask(workspaceId: string, request: CreateTaskRequest, signal: AbortSignal): Promise<TaskCreationConfirmation> {
    try {
      return await createTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), request, this.config, signal, readProject)
    } catch (error) { throw creationFailure(error) }
  }
  // END_METHOD_AicraftService.createTask

  /**
   * START_METHOD_AicraftService.workspaceForAgent
   * Resolve the registered project matching the calling agent's working directory.
   */
  workspaceForAgent(cwd: string): string { return workspaceForAgent(this.ctx, cwd) }
  // END_METHOD_AicraftService.workspaceForAgent

  /**
   * START_METHOD_AicraftService.completeStep
   * Complete the current step and select the next pending stage without closing the task.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  @presentationErrors
  completeStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'complete', stepId, signal)
  }
  // END_METHOD_AicraftService.completeStep

  /**
   * START_METHOD_AicraftService.goToStep
   * Select a step without resetting the other stages; the previous current stage becomes pending.
   */
  @Remote
  @presentationErrors
  goToStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'goto', stepId, signal)
  }
  // END_METHOD_AicraftService.goToStep

  /**
   * START_METHOD_AicraftService.returnStep
   * Return from a row to an eligible earlier step, preserving excluded stages and materials.
   */
  @Remote
  @presentationErrors
  returnStep(
    workspaceId: string,
    taskId: string,
    fromStepId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'return', stepId, signal, fromStepId)
  }
  // END_METHOD_AicraftService.returnStep

  /**
   * START_METHOD_AicraftService.skipStep
   * Skip the current step and select the next pending stage, keeping all materials.
   */
  @Remote
  @presentationErrors
  skipStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'skip', stepId, signal)
  }
  // END_METHOD_AicraftService.skipStep

  /**
   * START_METHOD_AicraftService.closeTask
   * Close a task without deleting materials or performing Git mutations.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  @presentationErrors
  closeTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'close', null, signal)
  }
  // END_METHOD_AicraftService.closeTask

  /**
   * START_METHOD_AicraftService.reopenTask
   * Reopen a closed task without resetting stages, artifacts or executor history.
   */
  @Remote
  @presentationErrors
  reopenTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>> {
    return this.changeTask(this.panelContext(workspaceId), taskId, 'reopen', null, signal)
  }
  // END_METHOD_AicraftService.reopenTask

}
/**
 * START_METHOD_resolveModel
 * Resolve the explicit model assignment with DSH without substituting a default route.
 */
export async function resolveModel(ctx: Context, assignment: RunModel, signal: AbortSignal): Promise<RunModel> {
  return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'resolveModel' }, {  }, async () => {
    const selection = { provider: assignment.provider, model: assignment.model, ...(assignment.reasoningEffort === null ? {} :
      { reasoningEffort: ReasoningEffortId(assignment.reasoningEffort) }) }
    const resolved = await ctx.llm.resolveCallConfig(selection, signal)
    return { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort ?? null }

  })
}
// END_METHOD_resolveModel

/** Translate only a refusal proven by the task publication owner.
 */
function creationFailure(error: unknown): unknown {
  if (error instanceof TaskCreationRefusal) return new RemoteError('aicraft/task-not-created', error.message,
    { taskIdentifier: error.taskIdentifier, outcome: 'not-created', ...(messageOf(error) ? { uiMessage: messageOf(error) } : {}) }, { cause: error })
  return error
}
