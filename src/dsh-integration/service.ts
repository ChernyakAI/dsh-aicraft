/**
 * FILE: plugin/src/dsh-integration/service.ts
 * DESCRIPTION: Route shared panel and agent operations to domain owners
 */
import { diagnosticOperation } from './diagnostics.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import type { } from '@deepseek-ai/dsh-api-session-controller/types'
import type { } from '@deepseek-ai/dsh-fs'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
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
import { readSettings } from '../project-settings/settings.ts'
import { setStepModel } from '../step-execution/models.ts'
import { defaultStepPrompt,openStepPrompt } from '../step-execution/prompts.ts'
import { RunController } from '../step-execution/runs.ts'
import { TaskCreationRefusal } from '../task-management/creation-result.ts'
import { createTask,updateTask } from '../task-management/commands.ts'
import type { CreateTaskRequest,TaskCreationConfirmation,ExecutionStatistics,InitializeProjectRequest,MaterialDocument,MaterialGroup,ProcessDefinition,ProcessDocument,ProcessTemplateLanguage,ProjectChange,ProjectPresence,ProjectSettings,ProjectView,RoleDocument,RunModel,RunView,TaskSnapshot } from '../types.ts'
import { deleteStepMaterials } from '../work-materials/cleanup.ts'
import { listMaterials,readMaterial,saveMaterial } from '../work-materials/materials.ts'
import type { Config } from './config.ts'
import { resolveProject,workspaceForAgent } from './project-context.ts'
import { readProject,readTaskView } from './project-view.ts'
import { ProjectWatch } from './project-watch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AICraft operations shared by the panel and future agent tools. */
    aicraft: AicraftService
  }
}
/** Server operations exposed to the AICraft panel. */
export class AicraftService extends TypertRemoteService {
  /** Project identity and filesystem operations are provided by DSH. */
  static inject: string[] = ['workspaceRegistry', 'fs', 'subprocess', 'agents', 'agentPresets', 'sessionQuery', 'sessionTitle', 'llm', 'sessionProjections']
  private readonly runs: RunController
  private readonly statisticsController: StatisticsController
  private readonly projectWatch: ProjectWatch
  /**
   * @param ctx - Owning Cordis plugin context.
   * @param config - Validated operation limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'aicraft')
    this.statisticsController = new StatisticsController(ctx,config.lockWaitMs)
    this.runs = new RunController(ctx, config, agent => this.statisticsController.track(agent), (model, signal) =>
      resolveModel(ctx, model, signal))
    this.projectWatch = new ProjectWatch(ctx, config)
  }

  /**
   * START_METHOD_AicraftService.changes
   * One event-driven project subscription, independent of the selected chat.
   */
  @Remote({ mode: 'stream' })
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
   * START_METHOD_AicraftService.project
   * Read project readiness, process choices, current branch and task state.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Project state suitable for creation controls.
   */
  @Remote
  async project(workspaceId: string, signal: AbortSignal): Promise<ProjectView> {
    return diagnosticOperation({ path: 'src/dsh-integration/service.ts', method: 'AicraftService.project' }, { workspaceId: workspaceId }, async () => {
      const cwd = this.projectPath(workspaceId)
      await this.runs.reconcile(cwd)
      return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)

    })
  }
  // END_METHOD_AicraftService.project

  /**
   * START_METHOD_AicraftService.projectForAgent
   * Agent reads must not reconcile or persist executor state.
   */
  projectForAgent(workspaceId: string, signal: AbortSignal): Promise<ProjectView> {
    return readProject(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), this.config, signal)
  }
  // END_METHOD_AicraftService.projectForAgent

  /**
   * START_METHOD_AicraftService.materials
   * List documents in the selected project, independently of the chat session.
   */
  @Remote
  materials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]> {
    return listMaterials(this.ctx.fs, this.projectPath(workspaceId), taskId, signal)
  }
  // END_METHOD_AicraftService.materials

  /**
   * START_METHOD_AicraftService.material
   * Read one project material without modifying it.
   */
  @Remote
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
  projectRules(workspaceId: string, signal: AbortSignal): Promise<MaterialDocument> {
    return openProjectRules(this.ctx.fs, this.projectPath(workspaceId), this.config.lockWaitMs, signal)
  }
  // END_METHOD_AicraftService.projectRules

  /**
   * START_METHOD_AicraftService.saveMaterial
   * Save existing Markdown with an optimistic file version guard.
   */
  @Remote
  saveMaterial(
    workspaceId: string,
    path: string,
    text: string,
    version: string,
    signal: AbortSignal,
  ): Promise<MaterialDocument> {
    return saveMaterial(this.ctx.fs, this.projectPath(workspaceId), path, text, version, this.config.lockWaitMs, signal)
  }
  // END_METHOD_AicraftService.saveMaterial

  /**
   * START_METHOD_AicraftService.setStepModel
   * Save the model used by subsequent runs of this task step.
   */
  @Remote
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
  settings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings> {
    return readSettings(this.ctx.fs, this.projectPath(workspaceId), signal)
  }
  // END_METHOD_AicraftService.settings

  /**
   * START_METHOD_AicraftService.saveProcess
   * Persist a project process template without changing existing tasks.
   */
  @Remote
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
   * Remove only a role not referenced by any process or saved task.
   */
  @Remote
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
   * Read or create the editable step prompt without starting a model.
   */
  @Remote
  stepPrompt(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<string> {
    return openStepPrompt(this.ctx.fs, this.config.lockWaitMs, this.projectPath(workspaceId), taskId, stepId, signal)
  }
  // END_METHOD_AicraftService.stepPrompt

  /**
   * START_METHOD_AicraftService.defaultStepPrompt
   * Generate default editor text without saving; preserve the loaded file version.
   */
  @Remote
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
  startStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    model: RunModel | null,
    signal: AbortSignal,
  ): Promise<RunView> {
    return this.runs.start(workspaceId, this.projectPath(workspaceId), taskId, stepId, model, signal)
  }
  // END_METHOD_AicraftService.startStep

  /**
   * START_METHOD_AicraftService.startStepForAgent
   * Authorized agent entry; the executor inherits standing permissions, not a one-call grant.
   */
  startStepForAgent(workspaceId: string, taskId: string, stepId: string, mode: SandboxMode, signal: AbortSignal): Promise<RunView> {
    return this.runs.start(workspaceId, this.projectPath(workspaceId), taskId, stepId, null, signal, mode)
  }
  // END_METHOD_AicraftService.startStepForAgent

  /**
   * START_METHOD_AicraftService.prepare
   * Prepare missing project files without overwriting existing materials.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
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
  async createTask(workspaceId: string, request: CreateTaskRequest, signal: AbortSignal): Promise<TaskCreationConfirmation> {
    try {
      return await createTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), request, this.config, signal, readProject)
    } catch (error) { throw creationFailure(error) }
  }
  // END_METHOD_AicraftService.createTask

  /**
   * START_METHOD_AicraftService.workspaceForAgent
   * workspaceForAgent operation.
   */

  workspaceForAgent(cwd: string): string { return workspaceForAgent(this.ctx, cwd) }
  // END_METHOD_AicraftService.workspaceForAgent

  /**
   * START_METHOD_AicraftService.moveStep
   * Select any stage; reset later statuses on return.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param stepId - Step in the task's saved process.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  moveStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'move', stepId, this.config, signal, undefined, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.moveStep

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
  completeStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'complete', stepId, this.config, signal, undefined, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.completeStep

  /**
   * START_METHOD_AicraftService.goToStep
   * Select a step without resetting the other stages; the previous current stage becomes pending.
   */
  @Remote
  goToStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'goto', stepId, this.config, signal, undefined, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.goToStep

  /**
   * START_METHOD_AicraftService.returnStep
   * Return from a row to an eligible earlier step, preserving excluded stages and materials.
   */
  @Remote
  returnStep(
    workspaceId: string,
    taskId: string,
    fromStepId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'return', stepId, this.config, signal, fromStepId, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.returnStep

  /**
   * START_METHOD_AicraftService.skipStep
   * Skip the current step and select the next pending stage, keeping all materials.
   */
  @Remote
  skipStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'skip', stepId, this.config, signal, undefined, this.runs.isActive, readProject)
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
  closeTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'close', null, this.config, signal, undefined, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.closeTask

  /**
   * START_METHOD_AicraftService.reopenTask
   * Reopen a closed task without resetting stages, artifacts or executor history.
   */
  @Remote
  reopenTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'reopen', null, this.config, signal, undefined, this.runs.isActive, readProject)
  }
  // END_METHOD_AicraftService.reopenTask

}
/**
 * START_METHOD_resolveModel
 * resolveModel operation.
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
    { taskIdentifier: error.taskIdentifier, outcome: 'not-created' }, { cause: error })
  return error
}
